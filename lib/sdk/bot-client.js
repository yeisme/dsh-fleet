/**
 * FleetBotClient: lightweight zero-dependency SDK for connecting external Agent Bots
 * into dsh-fleet (`/plugin/fleet/bots/*`) with automatic heartbeat and local approval callbacks.
 *
 * Security invariants:
 *  - Zero external dependencies (`node:*` only).
 *  - Never logs or echoes prompt/answer text in console output or error messages.
 */
import { createServer } from 'node:http'

const PATHS = Object.freeze({
  register: '/plugin/fleet/bots/register',
  heartbeat: '/plugin/fleet/bots/heartbeat',
  event: '/plugin/fleet/bots/event',
})

const MAX_CALLBACK_BYTES = 256 * 1024

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function sendJson(response, status, payload) {
  const text = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

async function readCallbackJson(request) {
  const declared = Number(request.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > MAX_CALLBACK_BYTES) {
    const error = new Error('Payload too large')
    error.status = 413
    throw error
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_CALLBACK_BYTES) {
      const error = new Error('Payload too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (size === 0) {
    const error = new Error('Empty request body')
    error.status = 400
    throw error
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('Invalid JSON body')
    error.status = 400
    throw error
  }
}

export class FleetBotClient {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl='http://127.0.0.1:3081']
   * @param {Record<string, string>} [options.headers={}]
   * @param {string} options.id
   * @param {string} [options.name]
   * @param {string} [options.kind='bot']
   * @param {string} [options.cwd=process.cwd()]
   * @param {string} [options.workspaceLabel='External Bots']
   * @param {number} [options.heartbeatMs=20000]
   * @param {number} [options.ttlMs=60000]
   * @param {boolean} [options.listen=true]
   * @param {typeof fetch} [options.fetchImpl=globalThis.fetch]
   */
  constructor({
    baseUrl = 'http://127.0.0.1:3081',
    headers = {},
    id,
    name,
    kind = 'bot',
    cwd = process.cwd(),
    workspaceLabel = 'External Bots',
    heartbeatMs = 20_000,
    ttlMs = 60_000,
    listen = true,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TypeError('FleetBotClient requires a non-empty string "id".')
    }
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('FleetBotClient requires a valid fetch implementation.')
    }

    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.headers = { ...headers }
    this.id = id.trim()
    this.name = typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined
    this.kind = typeof kind === 'string' && kind.trim() !== '' ? kind.trim() : 'bot'
    this.cwd = typeof cwd === 'string' ? cwd : ''
    this.workspaceLabel = typeof workspaceLabel === 'string' ? workspaceLabel : 'External Bots'
    this.heartbeatMs = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? Math.floor(heartbeatMs) : 0
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 60_000
    this.listen = Boolean(listen)
    this._fetch = fetchImpl

    this.callbackUrl = null
    this.paneId = null
    this.pane = null

    this._started = false
    this._server = null
    this._heartbeatTimer = null
    /** @type {Set<(payload: { verb: 'prompt', text: string, pane: string, botId: string }) => unknown>} */
    this._promptHandlers = new Set()
    /** @type {Set<(payload: { verb: 'interrupt', pane: string, botId: string }) => unknown>} */
    this._interruptHandlers = new Set()
    /** @type {Array<{ resolve: (value: { text: string, enter: boolean }) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> | null }>} */
    this._pendingApprovals = []
  }

  async _post(path, body) {
    const response = await this._fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(body),
    })

    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }

    if (!response.ok || data?.ok === false) {
      const reason = typeof data?.reason === 'string' ? data.reason : 'request-failed'
      const error = new Error(`FleetBotClient: POST ${path} failed (${response.status} ${reason})`)
      error.status = response.status
      error.reason = reason
      throw error
    }
    return data
  }

  async _startCallbackServer() {
    const server = createServer((request, response) => {
      this._handleCallback(request, response).catch(() => {
        if (!response.headersSent) {
          sendJson(response, 500, { ok: false, reason: 'internal', message: 'internal error' })
        } else {
          try { response.end() } catch { /* already closed */ }
        }
      })
    })

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

    const address = server.address()
    if (!address || typeof address === 'string') {
      await new Promise((resolve) => server.close(() => resolve()))
      throw new Error('FleetBotClient: failed to bind local callback server.')
    }

    this._server = server
    this.callbackUrl = `http://127.0.0.1:${address.port}/callback`
  }

  async _handleCallback(request, response) {
    if (String(request.method ?? '').toUpperCase() !== 'POST') {
      sendJson(response, 405, { ok: false, reason: 'method-not-allowed', message: 'method not allowed' })
      return
    }

    let body
    try {
      body = await readCallbackJson(request)
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400
      sendJson(response, status, { ok: false, reason: status === 413 ? 'payload-too-large' : 'invalid-request', message: 'invalid request body' })
      return
    }

    if (!isPlainObject(body) || typeof body.verb !== 'string') {
      sendJson(response, 400, { ok: false, reason: 'invalid-request', message: 'verb is required' })
      return
    }

    const pane = typeof body.pane === 'string' ? body.pane : (this.paneId ?? `bot:${this.id}`)
    const botId = typeof body.botId === 'string' ? body.botId : this.id

    if (body.verb === 'answer') {
      const answer = {
        text: typeof body.text === 'string' ? body.text : '',
        enter: body.enter !== false,
      }
      const waiter = this._pendingApprovals.shift()
      if (waiter) {
        if (waiter.timer !== null) clearTimeout(waiter.timer)
        waiter.resolve(answer)
      }
      sendJson(response, 200, { ok: true })
      return
    }

    if (body.verb === 'prompt') {
      const payload = {
        verb: 'prompt',
        text: typeof body.text === 'string' ? body.text : '',
        pane,
        botId,
      }
      for (const handler of [...this._promptHandlers]) {
        await handler(payload)
      }
      sendJson(response, 200, { ok: true })
      return
    }

    if (body.verb === 'interrupt') {
      const payload = { verb: 'interrupt', pane, botId }
      for (const handler of [...this._interruptHandlers]) {
        await handler(payload)
      }
      sendJson(response, 200, { ok: true })
      return
    }

    sendJson(response, 400, { ok: false, reason: 'invalid-request', message: 'unsupported verb' })
  }

  /**
   * Start local callback server (if `listen: true`), register bot with dsh-fleet,
   * and start the periodic heartbeat timer.
   */
  async start() {
    if (this._started) return this.pane

    if (this.listen) {
      await this._startCallbackServer()
    }

    const registration = {
      id: this.id,
      kind: this.kind,
      cwd: this.cwd,
      workspaceLabel: this.workspaceLabel,
      ttlMs: this.ttlMs,
      status: 'idle',
    }
    if (this.name !== undefined) {
      registration.name = this.name
      registration.display = this.name
    }
    if (this.callbackUrl !== null) {
      registration.callbackUrl = this.callbackUrl
    }

    let data
    try {
      data = await this._post(PATHS.register, registration)
    } catch (error) {
      await this.stop()
      throw error
    }

    this.paneId = data.id ?? null
    this.pane = data.pane ?? null
    this._started = true

    if (this.heartbeatMs > 0) {
      this._heartbeatTimer = setInterval(() => {
        this._post(PATHS.heartbeat, { id: this.id }).catch(() => { /* transient failure; retried on next tick */ })
      }, this.heartbeatMs)
      this._heartbeatTimer.unref?.()
    }

    return this.pane
  }

  /**
   * Update bot status (`working` | `blocked` | `done` | `idle`) and optional summary/screenText.
   * @param {'working' | 'blocked' | 'done' | 'idle'} status
   * @param {{ summary?: string, screenText?: string }} [options]
   */
  async setStatus(status, { summary, screenText } = {}) {
    const payload = { id: this.id, status }
    if (summary !== undefined) payload.summary = summary
    if (screenText !== undefined) payload.screenText = screenText
    const data = await this._post(PATHS.heartbeat, payload)
    this.pane = data.pane ?? this.pane
    return this.pane
  }

  /**
   * Push a contract `text` frame.
   * @param {'user' | 'assistant' | 'system'} role
   * @param {string} text
   * @param {{ at?: number | null }} [options]
   */
  async pushText(role, text, { at } = {}) {
    const frame = { kind: 'text', role, text }
    if (at !== undefined) frame.at = at
    const data = await this._post(PATHS.event, { id: this.id, frame })
    return data.frame
  }

  /**
   * Push a contract `work` frame.
   * @param {string} summary
   * @param {Array<{ verb: string, object: string, outcome?: 'ok' | 'error' | null, ms?: number | null }>} rows
   * @param {number | null} [tokens=null]
   */
  async pushWork(summary, rows, tokens = null) {
    const normalizedRows = Array.isArray(rows)
      ? rows.map((row) => ({
          verb: row.verb,
          object: row.object,
          outcome: row.outcome ?? null,
          ms: row.ms ?? null,
        }))
      : []
    const frame = { kind: 'work', summary, rows: normalizedRows, tokens }
    const data = await this._post(PATHS.event, { id: this.id, frame })
    return data.frame
  }

  /**
   * Push a contract `final` frame.
   * @param {string} text
   * @param {string} [reason='done']
   * @param {number | null} [ms=0]
   */
  async pushFinal(text, reason = 'done', ms = 0) {
    const frame = { kind: 'final', text, reason, ms }
    const data = await this._post(PATHS.event, { id: this.id, frame })
    return data.frame
  }

  /**
   * Ask a human for approval in DSH UI: pushes the question frame, marks the bot `blocked`,
   * and resolves with `{ text, enter }` once DSH sends an `answer` callback.
   * @param {string} question
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ text: string, enter: boolean }>}
   */
  async requestApproval(question, { timeoutMs } = {}) {
    if (this._server === null || this.callbackUrl === null) {
      throw new Error('FleetBotClient: requestApproval requires listen: true and start().')
    }

    await this.pushText('assistant', question)
    await this.setStatus('blocked', { summary: question, screenText: question })

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this._pendingApprovals.indexOf(waiter)
          if (index !== -1) this._pendingApprovals.splice(index, 1)
          reject(new Error('FleetBotClient: approval request timed out.'))
        }, Math.floor(timeoutMs))
      }
      this._pendingApprovals.push(waiter)
    })
  }

  /**
   * Register a handler invoked when DSH sends a `prompt` action.
   * @param {(payload: { verb: 'prompt', text: string, pane: string, botId: string }) => unknown} fn
   * @returns {() => void} unsubscribe
   */
  onPrompt(fn) {
    if (typeof fn !== 'function') throw new TypeError('FleetBotClient.onPrompt: handler must be a function.')
    this._promptHandlers.add(fn)
    return () => { this._promptHandlers.delete(fn) }
  }

  /**
   * Register a handler invoked when DSH sends an `interrupt` action.
   * @param {(payload: { verb: 'interrupt', pane: string, botId: string }) => unknown} fn
   * @returns {() => void} unsubscribe
   */
  onInterrupt(fn) {
    if (typeof fn !== 'function') throw new TypeError('FleetBotClient.onInterrupt: handler must be a function.')
    this._interruptHandlers.add(fn)
    return () => { this._interruptHandlers.delete(fn) }
  }

  /**
   * Stop the heartbeat timer, reject pending approvals, and close the local callback server.
   * Safe to call multiple times.
   */
  async stop() {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }

    while (this._pendingApprovals.length > 0) {
      const waiter = this._pendingApprovals.shift()
      if (waiter.timer !== null) clearTimeout(waiter.timer)
      waiter.reject(new Error('FleetBotClient: stopped before approval was received.'))
    }

    const server = this._server
    this._server = null
    this.callbackUrl = null
    this._started = false

    if (server !== null) {
      server.closeAllConnections?.()
      await new Promise((resolve) => {
        server.close(() => resolve())
      })
    }
  }
}
