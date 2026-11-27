/**
 * Host half of `dsh-fleet`.
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
import { mkdir, open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { applyFleetHost } from './lib/fleet/host.js'

export const name = 'threads'

/** Services used directly. */
export const inject = ['webServer', 'connection', 'commands']
// Fleet host wiring lives in its own module so it can be tested without a host: see lib/fleet/host.js.

const PI_HOME = join(homedir(), '.pi', 'agent', 'sessions')
const HERDR_STATE = join(homedir(), '.config', 'herdr', 'session.json')
const OWNED_DIR = join(homedir(), '.dsh', 'threads', 'pi')
const MAX_MESSAGES = 4000
const MAX_THREADS = 80
const SSE_INTERVAL_MS = 600
const READ_BLOCK_BYTES = 8 * 1024 * 1024
const MAX_LINE_BYTES = 64 * 1024 * 1024
const GROUP_GRACE_MS = 2000

/** Host services captured for helpers that run outside a request. */
let context

/* ------------------------------------------------------------------ discovery */

/**
 * Read herdr's path bindings and record whether their ownership is verifiable.
 */
async function herdrPanes() {
  try {
    const raw = JSON.parse(await readFile(HERDR_STATE, 'utf8'))
    const panes = []
    let uncertain = false
    if (!Array.isArray(raw.workspaces)) return { panes, uncertain: true }
    for (const workspace of raw.workspaces) {
      if (!Array.isArray(workspace.tabs)) return { panes, uncertain: true }
      for (const tab of workspace.tabs) {
        if (!tab.panes || typeof tab.panes !== 'object') return { panes, uncertain: true }
        for (const [number, pane] of Object.entries(tab.panes)) {
          const bound = pane?.agent_session
          if (bound == null || bound.kind === 'id') continue
          if (!(bound.kind === 'path' && typeof bound.value === 'string' && bound.value !== '')) {
            uncertain = true
            continue
          }
          const cwd = typeof pane.cwd === 'string' && isAbsolute(pane.cwd) ? pane.cwd
            : typeof workspace.identity_cwd === 'string' ? workspace.identity_cwd : ''
          if (!isAbsolute(bound.value) && !isAbsolute(cwd)) {
            panes.push({ path: bound.value, canonical: bound.value, pane: number })
            uncertain = true
            continue
          }
          const path = isAbsolute(bound.value) ? bound.value : resolve(cwd, bound.value)
          const canonical = await realpath(path).catch(() => undefined)
          uncertain ||= canonical === undefined
          panes.push({ path, canonical: canonical ?? path, pane: number })
        }
      }
    }
    return { panes, uncertain }
  } catch {
    return { panes: [], uncertain: true }
  }
}

async function threadBinding(path, { panes, uncertain }) {
  const canonical = await realpath(path).catch(() => undefined)
  const pane = panes.find((candidate) => candidate.path === path || candidate.canonical === (canonical ?? path))
  return { path: canonical ?? path, pane: pane?.pane ?? null, bound: pane !== undefined || uncertain || canonical === undefined }
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

/** Session path -> running process group, including turns still being interrupted. */
const running = new Map()

/** Thread key -> absolute message cursor and byte position of its current file. */
const messageCache = new Map()
const pendingReads = new Map()

/**
 * Build the thread registry: herdr-bound sessions plus other recent sessions.
 * @returns thread descriptors, newest first.
 */
async function discover() {
  const bindings = await herdrPanes()
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
    const binding = await threadBinding(item.path, bindings)
    const meta = await sessionMeta(binding.path)
    threads.push({
      key: `pi:${meta.id}`,
      tool: 'pi',
      id: meta.id,
      ...binding,
      title: meta.title,
      cwd: meta.cwd,
      source: item.path.startsWith(OWNED_DIR) ? 'side' : binding.pane === null ? 'session' : 'herdr',
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
 * @param seq - absolute sequence of the message in this thread.
 * @returns a renderable message, or undefined for system prompts.
 */
function normalize(entry, seq) {
  const message = entry?.message
  if (message === undefined || message === null) return undefined
  if (message.role === 'system') return undefined
  const base = {
    seq,
    id: String(entry.id ?? seq),
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

async function readBlock(handle, offset, length) {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return buffer.subarray(0, filled)
}

async function loadMessages(thread) {
  const prior = messageCache.get(thread.key)
  const handle = await open(thread.path, 'r').catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (handle === undefined) return prior ?? { total: 0, messages: [] }
  try {
    const { size, dev, ino } = await handle.stat()
    const cache = prior?.dev === dev && prior.ino === ino && size >= prior.scannedSize ? prior : {
      dev, ino, offset: 0, scannedSize: -1, total: prior?.total ?? 0, messages: [], droppingLine: false, warned: false,
    }
    messageCache.set(thread.key, cache)
    if (size === cache.scannedSize) return cache

    while (cache.offset < size) {
      const remaining = size - cache.offset
      let length = Math.min(remaining, READ_BLOCK_BYTES)
      let bytes = await readBlock(handle, cache.offset, length)
      if (bytes.length === 0) break
      if (cache.droppingLine) {
        const newline = bytes.indexOf(10)
        cache.offset += newline === -1 ? bytes.length : newline + 1
        cache.droppingLine = newline === -1
        continue
      }

      let end = bytes.lastIndexOf(10)
      while (end === -1 && length < Math.min(remaining, MAX_LINE_BYTES)) {
        if (!cache.warned) {
          context?.logger?.warn?.('threads: oversized JSONL line for %s; growing the read block up to 64 MiB', thread.key)
          cache.warned = true
        }
        length = Math.min(length * 2, remaining, MAX_LINE_BYTES)
        bytes = await readBlock(handle, cache.offset, length)
        end = bytes.lastIndexOf(10)
      }
      if (end === -1) {
        if (bytes.length < MAX_LINE_BYTES) break // still an incomplete append
        // Skip through the next newline so the tail cannot be parsed as a new entry.
        cache.offset += bytes.length
        cache.droppingLine = true
        continue
      }

      const lines = bytes.subarray(0, end).toString('utf8').split('\n')
      const batch = []
      for (const line of lines) {
        let entry
        try { entry = JSON.parse(line) } catch { continue }
        if (entry?.type !== 'message') continue
        const message = normalize(entry, cache.total)
        if (message === undefined) continue
        batch.push(message)
        cache.total++
      }
      cache.messages = cache.messages.concat(batch).slice(-MAX_MESSAGES)
      cache.offset += end + 1
    }
    cache.scannedSize = size
    return cache
  } finally {
    await handle.close()
  }
}

/** Serialize concurrent GET and SSE reads so one byte range assigns sequence numbers once. */
async function readMessages(thread) {
  const pending = pendingReads.get(thread.key)
  if (pending !== undefined) return pending
  const read = loadMessages(thread)
  pendingReads.set(thread.key, read)
  try { return await read } finally { pendingReads.delete(thread.key) }
}

function messagesSince({ total, messages }, after) {
  return messages.slice(Math.max(0, after - (total - messages.length)))
}

function messageCursor(url) {
  const after = Number(url.searchParams.get('after') ?? '0')
  return Number.isSafeInteger(after) && after >= 0 ? after : 0
}

/* ----------------------------------------------------------------- operations */

/**
 * Start one pi turn against a session file.
 * @param thread - target thread.
 * @param text - prompt body.
 * @returns the child process.
 */
function startTurn(thread, text) {
  // Pi print mode consumes piped stdin as the initial message.
  const child = spawn('pi', ['-p', '--session', thread.path, '--'], {
    cwd: thread.cwd === '' ? homedir() : thread.cwd,
    env: process.env,
    detached: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  const state = { child, stderr: '' }
  running.set(thread.path, state)
  const clear = () => {
    clearInterval(state.reapTimer)
    if (running.get(thread.path) === state) running.delete(thread.path)
  }
  state.clear = clear
  child.stderr?.on('data', (chunk) => { state.stderr = (state.stderr + String(chunk)).slice(-4000) })
  child.once('exit', () => {
    if (running.get(thread.path) !== state) return
    if (!groupAlive(child.pid)) clear()
    else state.reapTimer = setInterval(() => { if (!groupAlive(child.pid)) clear() }, 250).unref()
  })
  child.once('close', (code, signal) => {
    if (code !== 0 && state.interrupt === undefined && child.pid !== undefined) {
      context?.logger?.warn?.('threads: pi turn exited %s for %s: %s', signal ?? String(code), thread.key, state.stderr.slice(-500))
    }
  })
  child.once('error', (error) => {
    if (child.pid === undefined) clear()
    context?.logger?.warn?.('threads: pi spawn failed for %s: %s', thread.key, String(error?.message ?? error))
  })
  child.stdin.on('error', (error) => {
    if (child.pid !== undefined && state.interrupt === undefined) {
      context?.logger?.warn?.('threads: pi stdin failed for %s: %s', thread.key, String(error?.message ?? error))
    }
  })
  child.stdin.end(text, 'utf8')
  return child
}

function signalGroup(pid, signal) {
  if (pid === undefined) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function groupAlive(pid) {
  try { return signalGroup(pid, 0) } catch { return true }
}

async function waitForGroupExit(pid) {
  const deadline = performance.now() + GROUP_GRACE_MS
  while (groupAlive(pid)) {
    if (performance.now() >= deadline) return false
    await delay(50)
  }
  return true
}

async function interruptTurn(state) {
  const { pid } = state.child
  const interrupted = signalGroup(pid, 'SIGTERM')
  if (interrupted && !await waitForGroupExit(pid)) {
    if (signalGroup(pid, 'SIGKILL') && !await waitForGroupExit(pid)) {
      throw new Error('pi process group still running after SIGKILL')
    }
  }
  state.clear()
  return interrupted
}

/**
 * Create one DSH-owned session descriptor.
 * @param text - first question, used as the title.
 * @param cwd - working directory.
 * @returns the descriptor, before pi writes the header.
 */
async function ownedThread(text, cwd) {
  const directory = await realpath(OWNED_DIR)
  const id = randomUUID()
  return {
    key: `pi:${id}`,
    tool: 'pi',
    id,
    path: join(directory, `${new Date().toISOString().replace(/[:.]/gu, '-')}_${id}.jsonl`),
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
    running: running.has(thread.path),
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
      const after = messageCursor(url)
      const thread = await lookup(key)
      if (thread === undefined) return json(response, 404, { ok: false, reason: 'unknown-thread' })
      const cache = await readMessages(thread)
      json(response, 200, { ok: true, ...view(thread), after: cache.total, messages: messagesSince(cache, after > cache.total ? 0 : after) })
    },
  })

  endpoint('/plugin/threads/stream', {
    GET: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const key = url.searchParams.get('key') ?? ''
      let after = messageCursor(url)
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
      let lastRunning = running.has(thread.path)
      let pushing = false
      let closed = false
      const push = async () => {
        if (closed || pushing || response.writableNeedDrain) return
        pushing = true
        try {
          const cache = await readMessages(thread)
          if (closed) return
          const active = running.has(thread.path)
          if (after > cache.total) after = 0
          if (cache.total > after || active !== lastRunning) {
            send('append', { messages: messagesSince(cache, after), after: cache.total, running: active })
            after = cache.total
            lastRunning = active
          }
        } catch (error) {
          ctx.logger?.warn?.('threads: stream failed for %s: %s', thread.key, String(error?.message ?? error))
          stop()
        } finally {
          pushing = false
        }
      }
      const timer = setInterval(() => { void push() }, SSE_INTERVAL_MS)
      const stop = () => {
        if (closed) return
        closed = true
        clearInterval(timer)
        try { response.end() } catch { /* already closed */ }
      }
      response.once('close', stop)
      send('ready', { ...view(thread), after })
      await push()
    },
  })

  endpoint('/plugin/threads/prompt', {
    POST: async (request, response) => {
      const payload = await readJson(request)
      const thread = await lookup(String(payload?.key ?? ''))
      if (thread === undefined) return json(response, 404, { ok: false, reason: 'unknown-thread' })
      const binding = await threadBinding(thread.path, await herdrPanes())
      if (binding.bound) {
        return json(response, 409, {
          ok: false,
          reason: 'attached-readonly',
          detail: '该会话由外部终端（herdr 面板）持有，只能只读，或分叉后继续。',
        })
      }
      const text = String(payload?.text ?? '').trim()
      if (text === '') return json(response, 400, { ok: false, reason: 'empty-prompt' })
      if (running.has(binding.path)) return json(response, 409, { ok: false, reason: 'turn-running' })
      startTurn({ ...thread, ...binding }, text)
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
      const state = running.get(registry.get(key)?.path)
      if (state === undefined) return json(response, 200, { ok: true, interrupted: false })
      state.interrupt ??= interruptTurn(state).finally(() => { state.interrupt = undefined })
      const interrupted = await state.interrupt
      json(response, 200, { ok: true, interrupted })
    },
  })

  endpoint('/plugin/threads/new', {
    POST: async (request, response) => {
      const payload = await readJson(request)
      await mkdir(OWNED_DIR, { recursive: true })
      const text = String(payload?.text ?? '').trim()
      const cwd = String(payload?.cwd ?? process.cwd())
      const thread = await ownedThread(text, cwd)
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
    const thread = await ownedThread(text, process.cwd()) // title = the user's own words
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

  // The Fleet routes are additive: a machine with no herdr still gets the thread routes above, and the Fleet page
  // reports the missing connection honestly. A failure to build the host is logged, never thrown at the host.
  try {
    applyFleetHost(ctx)
  } catch (error) {
    ctx.logger?.warn?.('fleet: routes not registered: %s', String(error?.message ?? error))
  }
}
