/**
 * The /plugin/fleet/* routes (docs/design/FLEET-API.md). Transport only: every decision about panes, state and
 * writes lives in the service; this file validates the transport, maps errors to the contract's error shape, and
 * keeps SSE clients fed.
 *
 * Built so it can be tested against a plain node:http server: `createFleetEndpoints` returns
 * `{ path, handler(request, response) }` pairs, and `installFleetRoutes` registers them on the DSH web server
 * exactly like the existing /plugin/threads/* routes (same guard, same `ctx.effect` lifecycle).
 */
import { HttpError, guardRequest, readJsonBody, requireJson } from './security.js'
import { createSseHub } from './sse.js'
import { POLICIES } from './fleet/writability.js'

export const FLEET_PATHS = Object.freeze({
  state: '/plugin/fleet/state',
  stream: '/plugin/fleet/stream',
  frames: '/plugin/fleet/frames',
  screen: '/plugin/fleet/screen',
  act: '/plugin/fleet/act',
  policy: '/plugin/fleet/policy',
})

const DEFAULT_LIMIT = 80
const MAX_LIMIT = 200
const MAX_ID_CHARS = 64
const MAX_CURSOR_CHARS = 512

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

/** The contract's error shape: `{ ok: false, reason, message, detail? }`. */
function errorBody(error) {
  const body = { ok: false, reason: error.reason, message: error.message }
  if (error.detail !== undefined) body.detail = error.detail
  return body
}

/** A typed error from this file or from the service (FleetError has `reason` and an HTTP `status`). */
const isTyped = (error) => typeof error?.reason === 'string' && Number.isInteger(error?.status)

/** `code @ file:line:col` of the first stack frame; never the message. */
function where(error) {
  const frame = String(error?.stack ?? '').split('\n').find((line) => line.trimStart().startsWith('at '))
  return `${error?.code ?? '-'} @ ${frame ? frame.trim().replace(/^at /, '') : 'unknown'}`
}

const bad = (message) => new HttpError(400, 'invalid-request', message)

function paneParam(url) {
  const pane = url.searchParams.get('pane')
  if (pane === null || pane === '') throw bad('pane is required')
  if (pane.length > MAX_ID_CHARS) throw bad('pane is too long')
  return pane
}

function cursorParam(url, name) {
  const value = url.searchParams.get(name)
  if (value === null) return undefined
  if (value === '' || value.length > MAX_CURSOR_CHARS) throw bad(`${name} is not a valid cursor`)
  return value
}

function limitParam(url) {
  const value = url.searchParams.get('limit')
  if (value === null) return DEFAULT_LIMIT
  if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > MAX_LIMIT) throw bad(`limit must be an integer from 1 to ${MAX_LIMIT}`)
  return Number(value)
}

/**
 * @param {{
 *   service: { state(): object, frames(pane: string, query: object): Promise<object>, screen(pane: string): Promise<object>, act(request: unknown): Promise<object>, onChange(listener: () => void): () => void },
 *   connection: { requestRejection(request: object): unknown },
 *   logger?: { warn?: (...args: unknown[]) => void },
 *   heartbeatMs?: number,
 * }} deps
 */
export function createFleetEndpoints({ service, connection, logger, heartbeatMs }) {
  const hub = createSseHub({
    heartbeatMs,
    onError: (error) => logger?.warn?.('fleet: stream write failed: %s', String(error?.code ?? error?.name ?? 'error')),
  })
  const stateMessage = () => {
    const state = service.state()
    return { event: 'state', id: state.revision, data: state }
  }
  // One subscription for all clients: the state is built once per change, not once per client.
  const unsubscribe = service.onChange(() => {
    if (hub.size > 0) hub.broadcast(stateMessage())
  })

  const routes = {
    [FLEET_PATHS.state]: {
      GET: async (_request, response) => json(response, 200, service.state()),
    },

    [FLEET_PATHS.stream]: {
      // `Last-Event-ID` is deliberately ignored: every event is a full state, so the newest one is all a reconnecting
      // client needs, and there is nothing to replay.
      GET: async (_request, response) => { hub.add(response, stateMessage()) },
    },

    [FLEET_PATHS.frames]: {
      GET: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const pane = paneParam(url)
        const before = cursorParam(url, 'before')
        const after = cursorParam(url, 'after')
        if (before !== undefined && after !== undefined) throw bad('before and after are mutually exclusive')
        const query = { limit: limitParam(url) }
        if (before !== undefined) query.before = before
        if (after !== undefined) query.after = after
        json(response, 200, await service.frames(pane, query))
      },
    },

    [FLEET_PATHS.screen]: {
      GET: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        json(response, 200, await service.screen(paneParam(url)))
      },
    },

    [FLEET_PATHS.act]: {
      POST: async (request, response) => {
        requireJson(request)
        const body = await readJsonBody(request)
        json(response, 200, await service.act(body))
      },
    },

    [FLEET_PATHS.policy]: {
      POST: async (request, response) => {
        requireJson(request)
        const body = await readJsonBody(request)
        const write = body !== null && typeof body === 'object' && !Array.isArray(body) ? body.write : undefined
        if (typeof write !== 'string' || !POLICIES.includes(write)) {
          throw bad(`write must be one of: ${POLICIES.join(', ')}`)
        }
        if (typeof service.setPolicy !== 'function') {
          throw new HttpError(500, 'internal', 'policy updates are not supported')
        }
        const result = await service.setPolicy(write)
        json(response, 200, result ?? { ok: true, policy: { write } })
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
          // Mid-stream there is no status left to send: just end it.
          try { response.end() } catch { /* already closed */ }
          return
        }
        const headers = error?.allow ? { allow: error.allow } : {}
        // The body of an oversized request was not read to the end: do not keep the connection for the next request.
        if (error?.status === 413) headers.connection = 'close'
        if (isTyped(error)) {
          // Refusals are expected traffic, not warnings; only the reason is logged, never the request.
          json(response, error.status, errorBody(error), headers)
          return
        }
        // Only the error's class, code and the top stack frame's location: enough to find the bug, and (unlike the
        // message) it can never carry a prompt or keystrokes into the log.
        logger?.warn?.('fleet: %s failed: %s %s', path, String(error?.name ?? 'Error'), where(error))
        json(response, 500, { ok: false, reason: 'internal', message: 'internal error' })
      }
    },
  }))

  return {
    endpoints,
    hub,
    /** Close every open stream and stop listening for changes. */
    dispose() {
      unsubscribe?.()
      hub.close()
    },
  }
}

/**
 * Register the fleet routes on the DSH web server, the same way index.js registers /plugin/threads/*.
 * @param ctx host root context (`ctx.webServer`, `ctx.connection`, `ctx.effect`, `ctx.logger`)
 */
export function installFleetRoutes(ctx, { service, heartbeatMs } = {}) {
  const fleet = createFleetEndpoints({ service, connection: ctx.connection, logger: ctx.logger, heartbeatMs })
  for (const { path, handler } of fleet.endpoints) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), `fleet: ${path}`)
  }
  ctx.effect(() => () => fleet.dispose(), 'fleet: streams')
  return fleet
}
