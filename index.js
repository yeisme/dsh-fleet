/**
 * Host half of `@local/dsh-threads`.
 *
 * A thread is a conversation DSH only READS and RENDERS: a `pi` session JSONL on
 * disk, including the ones bound to live herdr panes. Nothing here is a DSH
 * subagent, so no settlement notice can reach a parent Session.
 *
 * Every operation exists once: the routes below and the agent tools (later) call
 * the same functions.
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const name = 'threads'

/** Services used directly. */
export const inject = ['webServer', 'connection', 'commands']

const PI_HOME = join(homedir(), '.pi', 'agent', 'sessions')
const HERDR_STATE = join(homedir(), '.config', 'herdr', 'session.json')
const OWNED_DIR = join(homedir(), '.dsh', 'threads', 'pi')
const MAX_MESSAGES = 4000
const MAX_THREADS = 80
const SSE_INTERVAL_MS = 600

/** Host services captured for helpers that run outside a request. */
let context

/* ------------------------------------------------------------------ discovery */

/**
 * Read the workspaces herdr keeps, tolerating an absent or unreadable file.
 * @returns panes bound to an agent session file.
 */
async function herdrPanes() {
  try {
    const raw = JSON.parse(await readFile(HERDR_STATE, 'utf8'))
    const panes = []
    for (const workspace of raw.workspaces ?? []) {
      for (const tab of workspace.tabs ?? []) {
        for (const [number, pane] of Object.entries(tab.panes ?? {})) {
          const bound = pane?.agent_session
          if (bound === undefined || bound === null || typeof bound.value !== 'string') continue
          panes.push({
            agent: String(bound.agent ?? 'pi'),
            sessionPath: bound.value,
            cwd: String(pane.cwd ?? workspace.identity_cwd ?? ''),
            pane: String(number),
          })
        }
      }
    }
    return panes
  } catch {
    return []
  }
}

/**
 * List pi session files below one root.
 * @param root - directory to scan.
 * @param depth - remaining recursion depth.
 * @returns absolute session file paths.
 */
async function piSessionFiles(root, depth = 3) {
  const found = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory() && depth > 0) found.push(...await piSessionFiles(path, depth - 1))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path)
  }
  return found
}

/**
 * Read the session header and first question from the head of a session file.
 * @param path - session file.
 * @returns session identity, cwd, and a display title.
 */
async function sessionMeta(path) {
  const fallback = { id: basename(path).replace(/\.jsonl$/u, ''), cwd: '', title: '' }
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(524288)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    // The last line may be truncated; a complete file keeps it.
    if (bytesRead === buffer.length) lines.pop()
    let id = fallback.id
    let cwd = ''
    let title = ''
    for (const line of lines) {
      if (line.trim() === '') continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type === 'session') {
        id = String(entry.id ?? id)
        cwd = String(entry.cwd ?? '')
      }
      if (entry.type === 'message' && entry.message?.role === 'user' && title === '') {
        title = textOf(entry.message).replace(/^【侧问[^】]*】/u, '').replace(/\s+/gu, ' ').trim().slice(0, 80)
      }
      if (cwd !== '' && title !== '') break
    }
    return { id, cwd, title: title === '' ? id.slice(0, 8) : title }
  } catch {
    return { ...fallback, title: fallback.id.slice(0, 8) }
  } finally {
    await handle?.close()
  }
}

/** key -> thread descriptor. */
const registry = new Map()

/** Running child processes for threads DSH itself drives. */
const running = new Map()

/** key -> { offset, messages } */
const messageCache = new Map()

/**
 * Build the thread registry: herdr-bound sessions plus other recent sessions.
 * @returns thread descriptors, newest first.
 */
async function discover() {
  const panes = await herdrPanes()
  const paths = new Set(await piSessionFiles(PI_HOME))
  for (const path of await piSessionFiles(OWNED_DIR, 1)) paths.add(path)

  const recent = []
  for (const path of paths) {
    try {
      const info = await stat(path)
      recent.push({ path, mtimeMs: info.mtimeMs, size: info.size })
    } catch {
      /* vanished between scan and stat */
    }
  }
  recent.sort((left, right) => right.mtimeMs - left.mtimeMs)

  const threads = []
  for (const item of recent.slice(0, MAX_THREADS)) {
    const pane = panes.find((candidate) => candidate.sessionPath === item.path)
    const meta = await sessionMeta(item.path)
    threads.push({
      key: `pi:${meta.id}`,
      tool: 'pi',
      id: meta.id,
      path: item.path,
      title: meta.title,
      cwd: meta.cwd,
      source: item.path.startsWith(OWNED_DIR) ? 'side' : pane === undefined ? 'session' : 'herdr',
      pane: pane?.pane ?? null,
      bound: pane !== undefined,
      updatedAt: item.mtimeMs,
      bytes: item.size,
    })
  }
  for (const thread of threads) registry.set(thread.key, thread)
  return threads
}

/**
 * Resolve a thread by key, refreshing the registry once when it is unknown.
 * @param key - `pi:<session id>`.
 * @returns the descriptor, or undefined.
 */
async function lookup(key) {
  if (key === '') return undefined
  if (!registry.has(key)) await discover()
  return registry.get(key)
}

/* ------------------------------------------------------------- normalization */

/**
 * Join the text blocks of one pi message.
 * @param message - pi message payload.
 * @returns its plain text.
 */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
}

/**
 * Project one pi message entry onto the pane's message model.
 * @param entry - `message` entry from the session file.
 * @param index - position in the normalised list.
 * @returns a renderable message, or undefined for system prompts.
 */
function normalize(entry, index) {
  const message = entry?.message
  if (message === undefined || message === null) return undefined
  if (message.role === 'system') return undefined
  const base = {
    seq: index,
    id: String(entry.id ?? index),
    time: Number(entry.timestamp ?? message.timestamp ?? 0),
  }
  if (message.role === 'user') {
    // Side threads carry a framing prefix in their first turn; it is our
    // instruction, not the user's words.
    return { ...base, role: 'user', text: textOf(message).replace(/^【侧问[^】]*】/u, '').trim() }
  }
  if (message.role === 'assistant') {
    const blocks = Array.isArray(message.content) ? message.content : []
    const thinking = blocks
      .filter((block) => block?.type === 'thinking' && typeof block.thinking === 'string')
      .map((block) => block.thinking)
      .join('\n\n')
      .trim()
    const tools = blocks
      .filter((block) => block?.type === 'toolCall')
      .map((block) => ({
        callId: String(block.id ?? block.toolCallId ?? ''),
        name: String(block.name ?? ''),
        args: block.arguments ?? block.args ?? null,
      }))
    return {
      ...base,
      role: 'assistant',
      text: textOf(message),
      ...(thinking === '' ? {} : { thinking }),
      ...(tools.length === 0 ? {} : { tools }),
      ...(message.usage === undefined ? {} : { usage: message.usage }),
      ...(message.stopReason === undefined ? {} : { stopReason: String(message.stopReason) }),
      ...(message.durationMs === undefined ? {} : { durationMs: Number(message.durationMs) }),
    }
  }
  if (message.role === 'toolResult') {
    return {
      ...base,
      role: 'tool',
      toolName: String(message.toolName ?? ''),
      callId: String(message.toolCallId ?? ''),
      text: textOf(message),
      isError: message.isError === true,
    }
  }
  return { ...base, role: 'other', text: textOf(message) }
}

/**
 * Read appended bytes of one session file and normalise them.
 * @param thread - registry entry.
 * @returns its messages in file order.
 */
async function readMessages(thread) {
  const cache = messageCache.get(thread.key) ?? { offset: 0, messages: [] }
  let size = 0
  try {
    size = (await stat(thread.path)).size
  } catch {
    return cache.messages
  }
  if (size > cache.offset) {
    const length = Math.min(size - cache.offset, 8 * 1024 * 1024)
    const handle = await open(thread.path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, cache.offset)
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
      const rest = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        let entry
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (entry.type !== 'message') continue
        const message = normalize(entry, cache.messages.length)
        if (message !== undefined) cache.messages.push(message)
      }
      cache.offset += bytesRead - Buffer.byteLength(rest, 'utf8')
      if (cache.messages.length > MAX_MESSAGES) cache.messages = cache.messages.slice(-MAX_MESSAGES)
    } finally {
      await handle.close()
    }
  }
  messageCache.set(thread.key, cache)
  return cache.messages
}

/* ----------------------------------------------------------------- operations */

/**
 * Start one pi turn against a session file.
 * @param thread - target thread.
 * @param text - prompt body.
 * @returns the child process.
 */
function startTurn(thread, text) {
  const child = spawn('pi', ['-p', '--session', thread.path, text], {
    cwd: thread.cwd === '' ? homedir() : thread.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { child, stderr: '' }
  child.stderr?.on('data', (chunk) => { state.stderr = (state.stderr + String(chunk)).slice(-4000) })
  running.set(thread.key, state)
  child.on('exit', (code) => {
    running.delete(thread.key)
    if (code !== 0) context?.logger?.warn?.('threads: pi turn exited %s for %s: %s', String(code), thread.key, state.stderr.slice(-500))
  })
  child.on('error', (error) => {
    running.delete(thread.key)
    context?.logger?.warn?.('threads: pi spawn failed for %s: %s', thread.key, String(error?.message ?? error))
  })
  return child
}

/**
 * Create one DSH-owned session descriptor.
 * @param text - first question, used as the title.
 * @param cwd - working directory.
 * @returns the descriptor, before pi writes the header.
 */
function ownedThread(text, cwd) {
  const id = randomUUID()
  return {
    key: `pi:${id}`,
    tool: 'pi',
    id,
    path: join(OWNED_DIR, `${new Date().toISOString().replace(/[:.]/gu, '-')}_${id}.jsonl`),
    title: text === '' ? '侧问' : text.replace(/\s+/gu, ' ').slice(0, 80),
    cwd,
    source: 'side',
    pane: null,
    bound: false,
    updatedAt: Date.now(),
    bytes: 0,
  }
}

/**
 * Copy a session into DSH's own directory under a fresh id — a fork with no
 * model call and no history rewriting beyond the header identity.
 * @param source - thread to copy.
 * @returns the new thread descriptor.
 */
async function forkThread(source) {
  await mkdir(OWNED_DIR, { recursive: true })
  const id = randomUUID()
  const target = join(OWNED_DIR, `${new Date().toISOString().replace(/[:.]/gu, '-')}_${id}.jsonl`)
  const lines = (await readFile(source.path, 'utf8')).split('\n')
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first >= 0) {
    try {
      const header = JSON.parse(lines[first])
      if (header.type === 'session') {
        header.id = id
        header.timestamp = new Date().toISOString()
        lines[first] = JSON.stringify(header)
      }
    } catch {
      /* keep the original header when it is unreadable */
    }
  }
  await writeFile(target, lines.join('\n'), 'utf8')
  await discover()
  return registry.get(`pi:${id}`)
}

/* --------------------------------------------------------------------- replies */

/**
 * Send one JSON reply.
 * @param response - node response.
 * @param status - HTTP status.
 * @param payload - body to serialise.
 */
function json(response, status, payload) {
  const text = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/**
 * Read a request body as JSON.
 * @param request - node request.
 * @returns the parsed object, or undefined.
 */
async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** Descriptor projection shared by every reply. */
function view(thread) {
  return {
    key: thread.key,
    id: thread.id,
    title: thread.title,
    cwd: thread.cwd,
    source: thread.source,
    pane: thread.pane,
    bound: thread.bound,
    updatedAt: thread.updatedAt,
    running: running.has(thread.key),
  }
}

/* ---------------------------------------------------------------------- apply */

/**
 * Register the thread routes and the `/btw` entry point.
 * @param ctx - host root context.
 */
export function apply(ctx) {
  context = ctx

  /**
   * Register one authenticated path with per-method handlers.
   * @param path - absolute pathname.
   * @param handlers - method table.
   */
  function endpoint(path, handlers) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      async handler(request, response) {
        const rejection = ctx.connection.requestRejection(request)
        if (rejection !== undefined) {
          json(response, 403, { ok: false, reason: 'forbidden' })
          return
        }
        const handle = handlers[String(request.method ?? 'GET').toUpperCase()]
        if (handle === undefined) {
          json(response, 405, { ok: false, reason: 'method-not-allowed' })
          return
        }
        try {
          await handle(request, response)
        } catch (error) {
          ctx.logger?.warn?.('threads: %s failed: %s', path, String(error?.message ?? error))
          if (!response.headersSent) json(response, 500, { ok: false, reason: String(error?.message ?? error) })
        }
      },
    }), `threads: ${path}`)
  }

  endpoint('/plugin/threads', {
    GET: async (_request, response) => {
      const threads = await discover()
      json(response, 200, { ok: true, threads: threads.map(view) })
    },
  })

  endpoint('/plugin/threads/messages', {
    GET: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const key = url.searchParams.get('key') ?? ''
      const after = Math.max(0, Number(url.searchParams.get('after') ?? '0'))
      const thread = await lookup(key)
      if (thread === undefined) return json(response, 404, { ok: false, reason: 'unknown-thread' })
      const messages = await readMessages(thread)
      json(response, 200, { ok: true, ...view(thread), after: messages.length, messages: messages.slice(after) })
    },
  })

  endpoint('/plugin/threads/stream', {
    GET: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const key = url.searchParams.get('key') ?? ''
      let after = Math.max(0, Number(url.searchParams.get('after') ?? '0'))
      const thread = await lookup(key)
      if (thread === undefined) return json(response, 404, { ok: false, reason: 'unknown-thread' })

      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const send = (event, data) => {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      const push = async () => {
        const messages = await readMessages(thread)
        if (messages.length < after) after = 0
        if (messages.length > after) {
          send('append', { messages: messages.slice(after), after: messages.length, running: running.has(thread.key) })
          after = messages.length
        }
      }
      send('ready', { ...view(thread), after })
      await push()
      const timer = setInterval(() => { void push() }, SSE_INTERVAL_MS)
      const stop = () => {
        clearInterval(timer)
        try { response.end() } catch { /* already closed */ }
      }
      request.on('close', stop)
      response.on('close', stop)
    },
  })

  endpoint('/plugin/threads/prompt', {
    POST: async (request, response) => {
      const payload = await readJson(request)
      const thread = await lookup(String(payload?.key ?? ''))
      if (thread === undefined) return json(response, 404, { ok: false, reason: 'unknown-thread' })
      const text = String(payload?.text ?? '').trim()
      if (text === '') return json(response, 400, { ok: false, reason: 'empty-prompt' })
      if (running.has(thread.key)) return json(response, 409, { ok: false, reason: 'turn-running' })
      if (thread.bound && payload?.force !== true) {
        return json(response, 409, {
          ok: false,
          reason: 'attached-readonly',
          detail: '该会话由外部终端（herdr 面板）持有，只能只读，或分叉后继续。',
        })
      }
      startTurn(thread, text)
      json(response, 202, { ok: true, accepted: true })
    },
  })

  endpoint('/plugin/threads/fork', {
    POST: async (request, response) => {
      const payload = await readJson(request)
      const thread = await lookup(String(payload?.key ?? ''))
      if (thread === undefined) return json(response, 404, { ok: false, reason: 'unknown-thread' })
      const forked = await forkThread(thread)
      if (forked === undefined) return json(response, 500, { ok: false, reason: 'fork-failed' })
      json(response, 200, { ok: true, thread: view(forked) })
    },
  })

  endpoint('/plugin/threads/interrupt', {
    POST: async (request, response) => {
      const payload = await readJson(request)
      const key = String(payload?.key ?? '')
      const state = running.get(key)
      if (state === undefined) return json(response, 200, { ok: true, interrupted: false })
      try {
        state.child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      running.delete(key)
      json(response, 200, { ok: true, interrupted: true })
    },
  })

  endpoint('/plugin/threads/new', {
    POST: async (request, response) => {
      const payload = await readJson(request)
      await mkdir(OWNED_DIR, { recursive: true })
      const text = String(payload?.text ?? '').trim()
      const cwd = String(payload?.cwd ?? process.cwd())
      const thread = ownedThread(text, cwd)
      registry.set(thread.key, thread)
      if (text !== '') startTurn(thread, text)
      await discover()
      json(response, 200, { ok: true, thread: view(registry.get(thread.key) ?? thread) })
    },
  })

  /* --- entries: /threads now, /btw takes over after the retired bundle unloads --- */

  /**
   * Create one owned side thread and start its first turn.
   * @param text - the side question.
   * @returns the created descriptor.
   */
  async function openSideThread(text) {
    await mkdir(OWNED_DIR, { recursive: true })
    const thread = ownedThread(text, process.cwd()) // title = the user's own words
    registry.set(thread.key, thread)
    startTurn(thread, `【侧问·只回答、不改文件；三句内】${text}`)
    // pi writes its own session identity into the file, so wait for it and report
    // that identity — the minted uuid never appears in discovery.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const threads = await discover()
      const created = threads.find((candidate) => candidate.path === thread.path)
      if (created !== undefined) return created
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return thread
  }

  ctx.effect(() => ctx.commands.register({
    name: 'threads',
    description: 'List attached threads, or start a side thread with a question',
    input: { hint: '[<question>]' },
    handler: async (invocation) => {
      const text = String(invocation?.rawInput ?? '').trim()
      try {
        if (text === '') {
          const threads = await discover()
          const counts = { herdr: 0, session: 0, side: 0 }
          for (const thread of threads) counts[thread.source] += 1
          return {
            kind: 'success',
            text: `线程 ${threads.length} 条（herdr ${counts.herdr} · 磁盘会话 ${counts.session} · 侧线 ${counts.side}）`,
          }
        }
        const thread = await openSideThread(text)
        return { kind: 'success', text: `已开侧问线程 ${thread.id.slice(0, 8)}（右栏「线程」）` }
      } catch (error) {
        return { kind: 'error', text: `线程失败：${String(error?.message ?? error)}` }
      }
    },
  }), 'threads: /threads')

  // `/btw` moves to this engine, but a retired bundle can still hold the name in a
  // running host. Register when free; never fail the whole plugin over it.
  try {
    const dispose = ctx.commands.register({
      name: 'btw',
      description: 'Open an isolated side thread (pi session) for a side question',
      input: { hint: '<question>' },
      handler: async (invocation) => {
        const text = String(invocation?.rawInput ?? '').trim()
        if (text === '') return { kind: 'error', text: '用法：/btw <问题>' }
        try {
          const thread = await openSideThread(text)
          return { kind: 'success', text: `已开侧问线程 ${thread.id.slice(0, 8)}（右栏「线程」）` }
        } catch (error) {
          return { kind: 'error', text: `线程失败：${String(error?.message ?? error)}` }
        }
      },
    })
    ctx.effect(() => dispose, 'threads: /btw')
  } catch (error) {
    ctx.logger?.debug?.('threads: /btw left to the retiring bundle: %s', String(error?.message ?? error))
  }
}
