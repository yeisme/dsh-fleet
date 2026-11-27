/**
 * A fake herdr server for tests: a real unix-socket server that speaks herdr's newline-delimited JSON protocol over a
 * `createWorld()` model (see ./wire.js). Host code under test talks to it through the real `HerdrClient`, so framing,
 * timeouts, reconnects and refusals are exercised for real; no test ever touches a live herdr.
 *
 * Behavior mirrors what the orchestrator and `herdr api schema` established for herdr 0.9.5 (protocol 22):
 *  - a plain request is answered once and the connection is then closed; `events.subscribe` keeps its connection;
 *  - results carry a `type` tag (`session_snapshot`, `pane_info`, `agent_info`, `agent_prompted`, `pane_read`, `ok`...);
 *  - errors are `{ id, error: { code, message } }`;
 *  - `agent.prompt` on a blocked agent is refused ("answer the question on screen first") and sends nothing.
 *
 * ASSUMPTIONS that only a live herdr can confirm (spike 8 was docs-level; nothing here was probed on a live session):
 *  - the key grammar: plus-separated chords (`ctrl+c`); a hyphen chord (`ctrl-c`) is refused as `invalid_key`;
 *  - `agent.start` on a pane that still runs an agent is refused (`agent_already_running` is a made-up code);
 *  - error codes other than `agent_blocked` are placeholders: assert on behavior and messages, not on these codes.
 *
 * Every request is recorded. `writeRequests()` is the set that could change or type into a pane: the safety tests
 * assert it stays empty whenever a request must be refused.
 */
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWorld } from './wire.js'

/** Methods that type into a pane or change/close one. Reads (snapshot, get, read, list, ping) are not here. */
export const WRITE_METHODS = new Set([
  'agent.prompt', 'agent.send_keys', 'agent.start', 'agent.rename',
  'pane.send_text', 'pane.send_keys', 'pane.send_input', 'pane.close', 'pane.release_agent',
])

const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'super'])
const NAMED_KEYS = new Set(['enter', 'esc', 'tab', 'space', 'backspace', 'delete', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`)])

/** herdr's documented key grammar (assumed, see header): `[mod+]*key`, key = one character or a named key. */
export function isValidKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false
  const parts = key.split('+')
  const base = parts.pop()
  if (!parts.every((part) => MODIFIERS.has(part))) return false
  return NAMED_KEYS.has(base) || /^[a-z0-9]$/.test(base)
}

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param {{ world?: ReturnType<typeof createWorld>, dir?: string }} [options]
 */
export async function startFakeHerdr({ world = createWorld(), dir } = {}) {
  const ownsDir = dir === undefined
  const directory = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'fh-'))
  const socketPath = path.join(directory, 'herdr.sock')
  const requests = []
  const overrides = new Map()
  const planned = new Map()
  const subscribers = new Set()
  const sockets = new Set()
  let server = null

  const plan = (method, step) => {
    const queue = planned.get(method) ?? []
    queue.push(step)
    planned.set(method, queue)
  }
  const nextPlanned = (method) => planned.get(method)?.shift() ?? null

  const target = (params) => {
    const record = world.resolve(params.pane_id ?? params.target)
    if (!record) throw new FakeError('pane_not_found', `unknown agent or pane ${params.pane_id ?? params.target}`)
    return record
  }
  const requireKeys = (keys) => {
    const bad = (Array.isArray(keys) ? keys : []).filter((key) => !isValidKey(key))
    if (bad.length > 0) throw new FakeError('invalid_key', `unknown key ${bad.map((key) => JSON.stringify(key)).join(', ')}`)
  }

  const defaults = {
    ping: () => ({ type: 'pong', version: world.version, protocol: world.protocol, capabilities: {} }),
    'session.snapshot': () => ({ type: 'session_snapshot', snapshot: world.snapshot() }),
    'agent.list': () => ({ type: 'agent_list', agents: world.snapshot().agents }),
    'pane.get': (params) => ({ type: 'pane_info', pane: world.paneInfo(target(params).id) }),
    'agent.get': (params) => {
      const record = target(params)
      if (!record.agent) throw new FakeError('agent_not_found', `pane ${record.id} has no agent`)
      return { type: 'agent_info', agent: world.agentInfo(record.id) }
    },
    'pane.read': (params) => {
      const record = target(params)
      const format = params.format ?? 'text'
      return {
        type: 'pane_read',
        read: {
          pane_id: record.id,
          workspace_id: record.workspaceId,
          tab_id: record.tabId,
          source: params.source ?? 'visible',
          format,
          text: format === 'ansi' ? record.screen : stripAnsi(record.screen),
          revision: record.revision,
          truncated: false,
        },
      }
    },
    'agent.prompt': (params) => {
      const record = target(params)
      if (!record.agent) throw new FakeError('agent_not_found', `pane ${record.id} has no agent`)
      if (record.agent.status === 'blocked') throw new FakeError('agent_blocked', 'agent is waiting on a question: answer the question on screen first')
      if (typeof params.text !== 'string' || params.text.length === 0) throw new FakeError('invalid_params', 'text is required')
      return { type: 'agent_prompted', agent: world.agentInfo(record.id) }
    },
    'agent.send_keys': (params) => { target(params); requireKeys(params.keys); return { type: 'ok' } },
    'pane.send_keys': (params) => { target(params); requireKeys(params.keys); return { type: 'ok' } },
    'pane.send_text': (params) => { target(params); return { type: 'ok' } },
    'pane.send_input': (params) => { target(params); if (params.keys) requireKeys(params.keys); return { type: 'ok' } },
    'pane.close': (params) => { world.closePane(target(params).id); return { type: 'ok' } },
    'agent.rename': (params) => {
      const record = target(params)
      if (!record.agent) throw new FakeError('agent_not_found', `pane ${record.id} has no agent`)
      world.update(record.id, { name: params.name ?? null })
      return { type: 'ok' }
    },
    'agent.start': (params) => {
      const record = target(params)
      if (record.agent) throw new FakeError('agent_already_running', `pane ${record.id} already runs an agent`)
      return { type: 'agent_started', agent: { pane_id: record.id, name: params.name, agent: params.kind }, argv: [params.kind] }
    },
    'pane.release_agent': (params) => { target(params); return { type: 'ok' } },
  }

  async function handleLine(socket, line) {
    let request
    try {
      request = JSON.parse(line)
    } catch {
      socket.end(`${JSON.stringify({ id: null, error: { code: 'invalid_json', message: 'malformed request' } })}\n`)
      return
    }
    const { id, method, params = {} } = request
    requests.push({ id, method, params, at: Date.now() })

    const step = nextPlanned(method)
    if (step?.kind === 'drop') { socket.destroy(); return }
    if (step?.kind === 'hang') return
    if (step?.kind === 'raw') { socket.end(step.text); return }
    if (step?.kind === 'delay') await sleep(step.ms)

    if (method === 'events.subscribe' && step?.kind !== 'error') {
      subscribers.add(socket)
      socket.write(`${JSON.stringify({ id, result: { type: 'subscription_started' } })}\n`)
      return
    }

    let outcome
    try {
      if (step?.kind === 'error') throw new FakeError(step.code, step.message)
      const handler = overrides.get(method) ?? defaults[method]
      if (!handler) throw new FakeError('unknown_method', `unknown method ${method}`)
      outcome = { result: await handler(params, { world, fake }) }
    } catch (error) {
      outcome = { error: { code: error?.code ?? 'internal_error', message: String(error?.message ?? error) } }
    }
    if (!socket.destroyed) socket.end(`${JSON.stringify({ id, ...outcome })}\n`)
  }

  function onConnection(socket) {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (line.trim().length > 0) void handleLine(socket, line)
      }
    })
    socket.on('close', () => { sockets.delete(socket); subscribers.delete(socket) })
    socket.on('error', () => {})
  }

  const fake = {
    socketPath,
    world,
    requests,

    requestsOf: (...methods) => requests.filter((request) => methods.includes(request.method)),
    /** Everything that could have typed into or changed a pane. */
    writeRequests: () => requests.filter((request) => WRITE_METHODS.has(request.method)),
    clearRequests: () => { requests.length = 0 },

    /** Replace a method's behavior for every later request: `fn(params, { world, fake })` returns a result or throws. */
    handle: (method, fn) => { overrides.set(method, fn) },
    /** Answer the next request of `method` with an error frame. */
    failNext: (method, { code = 'internal_error', message = 'planned failure' } = {}) => { plan(method, { kind: 'error', code, message }) },
    /** Never answer the next request of `method` (the client's timeout fires). */
    hangNext: (method) => { plan(method, { kind: 'hang' }) },
    /** Close the connection without answering the next request of `method`. */
    dropNext: (method) => { plan(method, { kind: 'drop' }) },
    /** Answer the next request of `method` with this raw text instead of a protocol frame. */
    rawNext: (method, text) => { plan(method, { kind: 'raw', text }) },
    /** Delay the answer to the next request of `method`. */
    delayNext: (method, ms) => { plan(method, { kind: 'delay', ms }) },

    /** Push an event frame (`{ event, data }`) to every subscriber. */
    push: (event, data = {}) => {
      for (const socket of subscribers) socket.write(`${JSON.stringify({ event, data })}\n`)
    },
    subscriberCount: () => subscribers.size,
    /** Close every subscription connection (what herdr does when a reader falls behind: `events_lost`). */
    dropSubscribers: () => { for (const socket of [...subscribers]) socket.destroy() },

    /** herdr goes away: connections die, the socket file disappears. */
    async stop() {
      if (!server) return
      const closing = server
      server = null
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => closing.close(resolve))
      fs.rmSync(socketPath, { force: true })
    },
    /** herdr comes (back) up at the same socket path. */
    async start() {
      if (server) return
      fs.rmSync(socketPath, { force: true })
      server = net.createServer(onConnection)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
    },
    async close() {
      await fake.stop()
      if (ownsDir) fs.rmSync(directory, { recursive: true, force: true })
    },
  }

  await fake.start()
  return fake
}
