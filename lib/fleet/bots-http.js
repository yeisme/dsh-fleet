/**
 * HTTP routes for external Agent Bots (`/plugin/fleet/bots/*`):
 *  - GET  /plugin/fleet/bots/list
 *  - POST /plugin/fleet/bots/register
 *  - POST /plugin/fleet/bots/heartbeat
 *  - POST /plugin/fleet/bots/event
 *
 * Uses the exact same transport security guards (`lib/security.js`) and contract error shape
 * (`{ ok: false, reason, message, detail? }`) as `/plugin/fleet/*` in `lib/http.js`.
 */
import { HttpError, guardRequest, readJsonBody, requireJson } from '../security.js'

export const BOT_PATHS = Object.freeze({
  list: '/plugin/fleet/bots/list',
  register: '/plugin/fleet/bots/register',
  heartbeat: '/plugin/fleet/bots/heartbeat',
  event: '/plugin/fleet/bots/event',
})

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isTyped = (error) => typeof error?.reason === 'string' && Number.isInteger(error?.status)
const bad = (message) => new HttpError(400, 'invalid-request', message)

function json(response, status, payload, headers = {}) {
  const text = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers,
  })
  response.end(text)
}

function errorBody(error) {
  const body = { ok: false, reason: error.reason, message: error.message }
  if (error.detail !== undefined) body.detail = error.detail
  return body
}

/** `code @ file:line:col` of the first stack frame; never the error message (may contain request content). */
function where(error) {
  const frame = String(error?.stack ?? '').split('\n').find((line) => line.trimStart().startsWith('at '))
  return `${error?.code ?? '-'} @ ${frame ? frame.trim().replace(/^at /, '') : 'unknown'}`
}

/**
 * @param {{
 *   provider: {
 *     listBots(): object[],
 *     register(bot: object): object,
 *     heartbeat(id: string, patch?: object): object,
 *     recordEvent(id: string, frame: object): object,
 *   },
 *   connection: { requestRejection(request: object): unknown },
 *   logger?: { warn?: (...args: unknown[]) => void },
 * }} deps
 */
export function createBotEndpoints({ provider, connection, logger }) {
  const routes = {
    [BOT_PATHS.list]: {
      GET: async (_request, response) => {
        json(response, 200, { ok: true, bots: provider.listBots() })
      },
    },

    [BOT_PATHS.register]: {
      POST: async (request, response) => {
        requireJson(request)
        const body = await readJsonBody(request)
        if (!isPlainObject(body)) throw bad('request body must be a JSON object')
        const pane = provider.register(body)
        json(response, 200, { ok: true, id: pane.id, pane })
      },
    },

    [BOT_PATHS.heartbeat]: {
      POST: async (request, response) => {
        requireJson(request)
        const body = await readJsonBody(request)
        if (!isPlainObject(body)) throw bad('request body must be a JSON object')
        const id = body.id ?? body.pane
        if (typeof id !== 'string' || id.trim() === '') throw bad('id is required')
        const { id: _id, pane: _pane, ...patch } = body
        const pane = provider.heartbeat(id, patch)
        json(response, 200, { ok: true, id: pane.id, pane })
      },
    },

    [BOT_PATHS.event]: {
      POST: async (request, response) => {
        requireJson(request)
        const body = await readJsonBody(request)
        if (!isPlainObject(body)) throw bad('request body must be a JSON object')
        const id = body.id ?? body.pane
        if (typeof id !== 'string' || id.trim() === '') throw bad('id is required')
        if (!isPlainObject(body.frame)) throw bad('frame must be a JSON object')
        const frame = provider.recordEvent(id, body.frame)
        json(response, 200, { ok: true, id, frame })
      },
    },
  }

  const endpoints = Object.entries(routes).map(([path, handlers]) => ({
    path,
    async handler(request, response) {
      try {
        guardRequest(connection, request)
        const handle = handlers[String(request.method ?? 'GET').toUpperCase()]
        if (handle === undefined) {
          throw Object.assign(new HttpError(405, 'method-not-allowed', 'method not allowed'), { allow: Object.keys(handlers).join(', ') })
        }
        await handle(request, response)
      } catch (error) {
        if (response.headersSent) {
          try { response.end() } catch { /* already closed */ }
          return
        }
        const headers = error?.allow ? { allow: error.allow } : {}
        if (error?.status === 413) headers.connection = 'close'
        if (isTyped(error)) {
          json(response, error.status, errorBody(error), headers)
          return
        }
        logger?.warn?.('fleet-bots: %s failed: %s %s', path, String(error?.name ?? 'Error'), where(error))
        json(response, 500, { ok: false, reason: 'internal', message: 'internal error' })
      }
    },
  }))

  return { endpoints }
}

/**
 * Register the `/plugin/fleet/bots/*` routes on the DSH web server.
 * @param ctx host root context (`ctx.webServer`, `ctx.connection`, `ctx.effect`, `ctx.logger`)
 */
export function installBotRoutes(ctx, { provider } = {}) {
  const bots = createBotEndpoints({ provider, connection: ctx.connection, logger: ctx.logger })
  for (const { path, handler } of bots.endpoints) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), `fleet-bots: ${path}`)
  }
  return bots
}
