/**
 * Spawning new Fleet agent panes (optionally inside an isolated git worktree).
 *
 * Security & safety rules:
 *  - Zero shell execution: `git worktree add` always runs with `shell: false` and validated arguments.
 *  - Policy and connectivity are checked before touching git or herdr.
 *  - Newly spawned panes are recorded in `store.dshPanes` so the `dsh-only` policy recognizes them.
 *  - Prompt text is never logged and never echoed in errors or messages.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { FleetError } from './errors.js'
import { mapHerdrError } from './actions.js'
import { HerdrError, isOfflineError } from '../herdr/protocol.js'

export const SPAWN_KINDS = Object.freeze(['claude', 'codex', 'pi', 'opencode', 'gemini', 'grok'])

const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/
const BRANCH_RE = /^[a-z0-9/_-]{1,64}$/
const MAX_PROMPT_CHARS = 20_000
const MAX_OUTPUT_BYTES = 16 * 1024
const GIT_TIMEOUT_MS = 15_000
const PROMPT_ATTEMPTS = 8
const PROMPT_RETRY_MS = 250

const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
const UNKNOWN_PANE = /unknown (?:agent or )?pane/i

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function defaultSpawnExec(cmd, args = [], { cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('spawn aborted'), { code: 'ETIMEDOUT' }))
      return
    }
    let child
    try {
      child = nodeSpawn(cmd, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let killTimer = null

    const append = (current, chunk) => {
      const next = current + chunk
      return next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next
    }

    const cleanup = () => {
      clearTimeout(killTimer)
      signal?.removeEventListener?.('abort', onAbort)
    }

    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      try { child.kill('SIGTERM') } catch { /* already exited */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
      }, 1000)
      killTimer.unref?.()
      reject(Object.assign(new Error('spawn timed out'), { code: 'ETIMEDOUT' }))
    }

    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk) })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ code, stdout, stderr })
    })
  })
}

async function runExec(execFn, cmd, args, options) {
  const result = execFn(cmd, args, options)
  if (result && typeof result.then === 'function') {
    return await result
  }
  // Support raw ChildProcess-returning spawn functions as well.
  if (result && typeof result.once === 'function') {
    return await new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      result.stdout?.setEncoding?.('utf8')
      result.stderr?.setEncoding?.('utf8')
      result.stdout?.on?.('data', (chunk) => { stdout += chunk })
      result.stderr?.on?.('data', (chunk) => { stderr += chunk })
      result.once('error', reject)
      result.once('close', (code) => resolve({ code, stdout, stderr }))
    })
  }
  return result
}

function defaultAgentName(kind) {
  return `${kind}-${randomBytes(3).toString('hex')}`
}

/**
 * Create a new git worktree on a new branch with `shell: false`.
 *
 * @param {{ cwd: string, branch: string, worktreePath: string, spawn?: Function }} options
 * @returns {Promise<{ ok: true, cwd: string, branch: string }>}
 */
export async function createWorktree({ cwd, branch, worktreePath, spawn = defaultSpawnExec } = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '' || cwd.includes('\0') || !path.isAbsolute(cwd)) {
    throw new FleetError('invalid-request', 'cwd must be a non-empty absolute path.')
  }
  if (
    typeof branch !== 'string' ||
    !BRANCH_RE.test(branch) ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    branch.includes('//')
  ) {
    throw new FleetError('invalid-request', 'branch must match ^[a-z0-9/_-]{1,64}$ and be a safe git branch name.')
  }
  if (typeof worktreePath !== 'string' || worktreePath.trim() === '' || worktreePath.includes('\0') || worktreePath.startsWith('-')) {
    throw new FleetError('invalid-request', 'worktreePath must be a non-empty path.')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GIT_TIMEOUT_MS)
  timer.unref?.()
  try {
    const result = await runExec(
      spawn,
      'git',
      ['worktree', 'add', '-b', branch, worktreePath],
      { cwd, shell: false, signal: controller.signal },
    )
    if (!result || result.code !== 0) {
      throw new FleetError('internal', 'Failed to create git worktree.')
    }
    return { ok: true, cwd: worktreePath, branch }
  } catch (error) {
    if (error instanceof FleetError) throw error
    throw new FleetError('internal', 'Failed to create git worktree.')
  } finally {
    clearTimeout(timer)
  }
}

function validateSpawnRequest(request) {
  if (!isObject(request)) {
    throw new FleetError('invalid-request', 'The spawn request must be a JSON object.')
  }
  const { kind, cwd, name, prompt, worktree = false } = request
  if (typeof kind !== 'string' || !SPAWN_KINDS.includes(kind)) {
    throw new FleetError('invalid-request', `Invalid kind. Supported: ${SPAWN_KINDS.join(', ')}.`)
  }
  if (typeof cwd !== 'string' || cwd.trim() === '' || cwd.includes('\0')) {
    throw new FleetError('invalid-request', 'cwd must be a non-empty string.')
  }
  if (name !== undefined && (typeof name !== 'string' || !AGENT_NAME_RE.test(name))) {
    throw new FleetError('invalid-request', 'name must match ^[a-z][a-z0-9_-]{0,31}$.')
  }
  if (prompt !== undefined) {
    if (typeof prompt !== 'string') {
      throw new FleetError('invalid-request', 'prompt must be a string.')
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new FleetError('invalid-request', `prompt must be at most ${MAX_PROMPT_CHARS} characters.`)
    }
    if (UNSAFE_TEXT.test(prompt)) {
      throw new FleetError('invalid-request', 'prompt must not contain control characters other than tab and line breaks.')
    }
  }
  if (typeof worktree !== 'boolean') {
    throw new FleetError('invalid-request', 'worktree must be a boolean.')
  }
  if (worktree && !path.isAbsolute(cwd)) {
    throw new FleetError('invalid-request', 'cwd must be an absolute path when worktree is true.')
  }

  const paneId = typeof request.pane === 'string' && request.pane !== ''
    ? request.pane
    : typeof request.paneId === 'string' && request.paneId !== ''
      ? request.paneId
      : null

  return {
    kind,
    cwd,
    name: name ?? defaultAgentName(kind),
    prompt: prompt ?? '',
    worktree,
    paneId,
  }
}

/**
 * Spawn an agent in herdr, optionally creating an isolated git worktree first and sending an initial prompt.
 *
 * @param {object} deps
 * @param {{ request: Function }} deps.client
 * @param {{ health?: { connected?: boolean }, stale?: boolean }} deps.state
 * @param {{ policy: string, dshPanes?: Set<string>, addDshPane?: Function }} deps.store
 * @param {unknown} deps.request
 * @param {Function} [deps.spawnExec]
 * @param {(entry: object) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
export async function spawnAgent({
  client,
  state,
  store,
  request,
  spawnExec = defaultSpawnExec,
  log = () => {},
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof client?.request !== 'function') throw new TypeError('spawnAgent: client needs a request() method')
  if (!isObject(state)) throw new TypeError('spawnAgent: state is required')
  if (!isObject(store)) throw new TypeError('spawnAgent: store is required')

  const started = now()
  let paneId = null

  const emit = (entry) => {
    try {
      log(entry)
    } catch { /* a broken logger must not turn a spawn into an error */ }
  }

  try {
    const valid = validateSpawnRequest(request)

    const policy = store.policy ?? null
    if (policy !== 'all' && policy !== 'dsh-only') {
      throw new FleetError('policy-denied', 'The write policy (read-only) does not allow spawning agents.', {
        policy: policy ?? 'read-only',
      })
    }

    if (state.health?.connected !== true || state.stale === true) {
      throw new FleetError('herdr-offline', 'herdr is not reachable. Nothing was spawned.')
    }

    let effectiveCwd = valid.cwd
    let worktreeBranch = null
    if (valid.worktree) {
      worktreeBranch = `fleet/${valid.name}`
      const worktreePath = path.join(valid.cwd, '.worktrees', valid.name)
      const created = await createWorktree({
        cwd: valid.cwd,
        branch: worktreeBranch,
        worktreePath,
        spawn: spawnExec,
      })
      effectiveCwd = created.cwd
    }

    const startParams = {
      name: valid.name,
      kind: valid.kind,
      cwd: effectiveCwd,
    }
    if (valid.paneId !== null) startParams.pane_id = valid.paneId

    let startResult
    try {
      startResult = await client.request('agent.start', startParams)
    } catch (error) {
      throw mapHerdrError(error, { verb: 'spawn', write: true })
    }

    paneId = startResult?.agent?.pane_id
      ?? startResult?.pane_id
      ?? startResult?.pane?.pane_id
      ?? (typeof startResult?.pane === 'string' ? startResult.pane : null)
      ?? valid.paneId

    if (typeof paneId !== 'string' || paneId === '') {
      throw new FleetError('herdr-error', 'herdr did not return a pane id for the started agent.', { code: 'bad_reply' })
    }

    if (typeof store.addDshPane === 'function') {
      store.addDshPane(paneId)
    } else {
      store.dshPanes?.add?.(paneId)
    }

    if (valid.prompt.trim() !== '') {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await client.request('agent.prompt', { target: paneId, text: valid.prompt })
          break
        } catch (error) {
          const raced = error instanceof HerdrError
            && !isOfflineError(error)
            && error.code !== 'timeout'
            && UNKNOWN_PANE.test(String(error.message ?? ''))
          if (!raced) throw mapHerdrError(error, { verb: 'prompt', write: true })
          if (attempt >= PROMPT_ATTEMPTS) {
            throw new FleetError('herdr-error', 'The agent was spawned, but herdr had not registered it in time for the initial prompt.', { code: 'pane_not_found' })
          }
          await sleep(PROMPT_RETRY_MS)
        }
      }
    }

    emit({ verb: 'spawn', pane: paneId, ok: true, reason: null, ms: Math.max(0, now() - started) })
    return {
      ok: true,
      pane: paneId,
      kind: valid.kind,
      name: valid.name,
      cwd: effectiveCwd,
      worktree: worktreeBranch,
    }
  } catch (error) {
    const failure = error instanceof FleetError ? error : mapHerdrError(error, { verb: 'spawn', write: false })
    emit({ verb: 'spawn', pane: paneId, ok: false, reason: failure.reason, ms: Math.max(0, now() - started) })
    throw failure
  }
}

/**
 * Build the `/bot` DSH command definition backed by a `FleetService`-shaped object.
 * Never logs or echoes prompt content.
 *
 * @param {{ state: () => { panes?: Array<object> }, act: (req: object) => Promise<object> }} fleetService
 */
export function createBotCommand(fleetService) {
  return {
    name: 'bot',
    description: 'List active Fleet agents/bots, or send a prompt to one',
    input: { hint: '[<name-or-paneId> <prompt>]' },
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput ?? '').trim()
      try {
        const panes = (fleetService.state()?.panes ?? []).filter((pane) => pane.agent !== null)
        if (raw === '') {
          if (panes.length === 0) {
            return { kind: 'success', text: 'No active agents or bots.' }
          }
          const lines = panes.map((pane) => {
            const label = pane.agent?.name ?? pane.agent?.display ?? pane.id
            const kind = pane.agent?.kind ?? 'agent'
            return `${label} (${pane.id}) [${kind}] — ${pane.status}`
          })
          return {
            kind: 'success',
            text: `Active agents (${panes.length}):\n${lines.join('\n')}`,
          }
        }
        const split = /^(\S+)\s+([\s\S]+)$/.exec(raw)
        if (!split) {
          return { kind: 'error', text: 'Usage: /bot <name-or-paneId> <prompt>' }
        }
        const targetRef = split[1]
        const promptText = split[2].trim()
        if (promptText === '') {
          return { kind: 'error', text: 'Usage: /bot <name-or-paneId> <prompt>' }
        }
        const target = panes.find((pane) => pane.id === targetRef || pane.agent?.name === targetRef)
        if (!target) {
          return { kind: 'error', text: `Unknown agent or bot: ${targetRef}` }
        }
        await fleetService.act({ verb: 'prompt', pane: target.id, text: promptText })
        const label = target.agent?.name ?? target.id
        return { kind: 'success', text: `Prompt sent to ${label} (${target.id}).` }
      } catch (error) {
        const message = typeof error?.reason === 'string' && typeof error?.message === 'string'
          ? error.message
          : 'Failed to dispatch prompt.'
        return { kind: 'error', text: message }
      }
    },
  }
}
