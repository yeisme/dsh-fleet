/**
 * ExternalBotProvider: brings external personal Agent Bots (local HTTP/Webhook/daemon/IM bots) into the
 * Fleet control plane as contract-compliant Panes with frames, heartbeat TTL staleness, and safe action dispatch.
 *
 * Security & contract invariants:
 *  - Every emitted Pane validates against lib/fleet/contract.schema.json `#/$defs/Pane`.
 *  - Every emitted Frame validates against `#/$defs/Frame`; FramesResponse against `#/$defs/FramesResponse`.
 *  - `answer` enforces `expectRevision` strictly (409 `screen-changed`, never auto-retried).
 *  - Prompt/answer text and callback URLs/secrets are NEVER logged or echoed in errors or Panes.
 */
import { readFileSync } from 'node:fs'
import { FleetError } from '../errors.js'
import { isStalled } from '../attention.js'
import { AGENT_NAME, STATUSES, clipText, deriveSummary } from '../model.js'
import { POLICIES, writability } from '../writability.js'
import { validateRequest } from '../actions.js'
import { namespacePaneId } from './registry.js'

export const DEFAULT_TTL_MS = 60_000
export const DEFAULT_MAX_FRAMES = 200
export const DEFAULT_SWEEP_MS = 15_000
export const DEFAULT_CALLBACK_TIMEOUT_MS = 10_000

const SUPPORTED_BOT_VERBS = new Set(['prompt', 'answer', 'interrupt'])
const SUMMARY_SOURCES = new Set(['transcript', 'screen', 'none'])
const FRAME_ROLES = new Set(['user', 'assistant', 'system'])
const WORK_OUTCOMES = new Set(['ok', 'error', null])
const ID_MAX = 64
const DEFAULT_LIMIT = 80
const MAX_LIMIT = 200

const NO_CHECKS = Object.freeze({
  gate: 'none',
  startedAt: null,
  durationMs: null,
  baseRevision: null,
  headRevision: null,
  steps: Object.freeze([]),
  failure: null,
})

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const codePoints = (value) => [...value].length
const instant = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null)

function clampId(value, fallback) {
  const clean = nonEmpty(value)
  if (!clean) return fallback
  const points = [...clean]
  return points.length <= ID_MAX ? clean : points.slice(0, ID_MAX).join('')
}

function validateCallbackUrl(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new FleetError('invalid-request', 'callbackUrl must be a string URL.')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new FleetError('invalid-request', 'callbackUrl must be a valid http or https URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FleetError('invalid-request', 'callbackUrl must use http or https.')
  }
  return parsed.toString()
}

function normalizeStatus(value, fallback = 'idle') {
  if (value === undefined) return fallback
  if (typeof value === 'string' && STATUSES.includes(value)) return value
  throw new FleetError('invalid-request', `Invalid bot status. Expected one of: ${STATUSES.join(', ')}.`)
}

function normalizeRawId(id) {
  const clean = nonEmpty(id)
  if (!clean) throw new FleetError('invalid-request', 'Bot id must be a non-empty string.')
  return clean.startsWith('bot:') ? clean.slice(4) : clean
}

function normalizeFrame(input, seq, now) {
  if (!isPlainObject(input) || typeof input.kind !== 'string') {
    throw new FleetError('invalid-request', 'Frame must be an object with a string "kind".')
  }
  const id = clampId(input.id, `f:${seq}`)
  switch (input.kind) {
    case 'session': {
      if (typeof input.sessionId !== 'string' || typeof input.cwd !== 'string') {
        throw new FleetError('invalid-request', 'session frame requires string sessionId and cwd.')
      }
      return { kind: 'session', id, sessionId: input.sessionId, cwd: input.cwd }
    }
    case 'text': {
      if (!FRAME_ROLES.has(input.role) || typeof input.text !== 'string') {
        throw new FleetError('invalid-request', 'text frame requires valid role and string text.')
      }
      const at = input.at === undefined ? now : input.at === null ? null : instant(input.at)
      if (input.at !== undefined && input.at !== null && at === null) {
        throw new FleetError('invalid-request', 'text frame "at" must be a non-negative integer or null.')
      }
      return { kind: 'text', id, role: input.role, text: input.text, at }
    }
    case 'reasoning': {
      if (typeof input.text !== 'string') {
        throw new FleetError('invalid-request', 'reasoning frame requires string text.')
      }
      return { kind: 'reasoning', id, text: input.text }
    }
    case 'work': {
      if (typeof input.summary !== 'string' || !Array.isArray(input.rows)) {
        throw new FleetError('invalid-request', 'work frame requires string summary and rows array.')
      }
      const rows = input.rows.map((row) => {
        if (!isPlainObject(row) || typeof row.verb !== 'string' || typeof row.object !== 'string') {
          throw new FleetError('invalid-request', 'work row requires string verb and object.')
        }
        const outcome = row.outcome === undefined ? null : row.outcome
        if (!WORK_OUTCOMES.has(outcome)) {
          throw new FleetError('invalid-request', 'work row outcome must be ok, error, or null.')
        }
        const ms = row.ms === undefined || row.ms === null ? null : instant(row.ms)
        if (row.ms !== undefined && row.ms !== null && ms === null) {
          throw new FleetError('invalid-request', 'work row ms must be a non-negative integer or null.')
        }
        return { verb: row.verb, object: row.object, outcome, ms }
      })
      const tokens = input.tokens === undefined || input.tokens === null ? null : instant(input.tokens)
      if (input.tokens !== undefined && input.tokens !== null && tokens === null) {
        throw new FleetError('invalid-request', 'work frame tokens must be a non-negative integer or null.')
      }
      return { kind: 'work', id, summary: input.summary, rows, tokens }
    }
    case 'final': {
      if (typeof input.text !== 'string' || typeof input.reason !== 'string') {
        throw new FleetError('invalid-request', 'final frame requires string text and reason.')
      }
      const ms = input.ms === undefined || input.ms === null ? null : instant(input.ms)
      if (input.ms !== undefined && input.ms !== null && ms === null) {
        throw new FleetError('invalid-request', 'final frame ms must be a non-negative integer or null.')
      }
      return { kind: 'final', id, text: input.text, reason: input.reason, ms }
    }
    default:
      throw new FleetError('invalid-request', 'Unsupported frame kind.')
  }
}

function parseCursor(cursor) {
  if (cursor === undefined || cursor === null) return null
  if (typeof cursor !== 'string' || !/^seq:\d+$/.test(cursor)) {
    throw new FleetError('invalid-request', 'Invalid frames cursor.')
  }
  return Number(cursor.slice(4))
}

function cloneChecks(checks) {
  if (!isPlainObject(checks)) return { ...NO_CHECKS, steps: [] }
  return {
    gate: checks.gate ?? 'none',
    startedAt: checks.startedAt ?? null,
    durationMs: checks.durationMs ?? null,
    baseRevision: checks.baseRevision ?? null,
    headRevision: checks.headRevision ?? null,
    steps: Array.isArray(checks.steps)
      ? checks.steps.map((step) => ({ name: step.name, status: step.status, durationMs: step.durationMs, summary: step.summary }))
      : [],
    failure: isPlainObject(checks.failure)
      ? { step: checks.failure.step, reason: checks.failure.reason, excerpt: checks.failure.excerpt }
      : null,
  }
}

export class ExternalBotProvider {
  /**
   * @param {object} [options]
   * @param {string} [options.id='external-bots']
   * @param {string | null} [options.configPath=null] optional path to static bots JSON file
   * @param {number} [options.ttlMs=60000] heartbeat TTL in ms
   * @param {number} [options.maxFrames=200] max frames retained per bot
   * @param {number} [options.sweepIntervalMs=15000] periodic TTL sweep interval when started
   * @param {number} [options.timeoutMs=10000] webhook callback timeout
   * @param {() => number} [options.now=Date.now]
   * @param {typeof fetch} [options.fetcher=globalThis.fetch]
   * @param {string | (() => { write?: string, dshPanes?: Set<string> })} [options.policy='all']
   * @param {(entry: { verb: string | null, pane: string | null, ok: boolean, reason: string | null, ms: number }) => void} [options.log]
   */
  constructor({
    id = 'external-bots',
    configPath = null,
    ttlMs = DEFAULT_TTL_MS,
    maxFrames = DEFAULT_MAX_FRAMES,
    sweepIntervalMs = DEFAULT_SWEEP_MS,
    timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
    now = Date.now,
    fetcher = globalThis.fetch,
    policy = 'all',
    log = () => {},
  } = {}) {
    this.id = id
    this.kind = 'external-bots'
    this.idPrefix = 'bot:'
    this._configPath = configPath
    this._ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : DEFAULT_TTL_MS
    this._maxFrames = Number.isInteger(maxFrames) && maxFrames > 0 ? maxFrames : DEFAULT_MAX_FRAMES
    this._sweepIntervalMs = Number.isFinite(sweepIntervalMs) && sweepIntervalMs > 0 ? Math.floor(sweepIntervalMs) : DEFAULT_SWEEP_MS
    this._timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_CALLBACK_TIMEOUT_MS
    this._now = now
    this._fetcher = fetcher
    this._policy = policy
    this._log = log

    /** @type {Map<string, object>} keyed by public paneId (`bot:<rawId>`) */
    this._bots = new Map()
    /** @type {Set<() => void>} */
    this._listeners = new Set()
    /** @type {Map<string, Promise<void>>} */
    this._locks = new Map()
    this._sweepTimer = null
  }

  _notify() {
    for (const listener of [...this._listeners]) {
      try {
        listener()
      } catch { /* broken listener must not break provider */ }
    }
  }

  _emitLog(entry) {
    try {
      this._log(entry)
    } catch { /* logging must never fail an action */ }
  }

  _resolvePolicy() {
    const value = typeof this._policy === 'function' ? this._policy() : this._policy
    if (typeof value === 'string') {
      return { write: POLICIES.includes(value) ? value : 'read-only', dshPanes: new Set() }
    }
    if (isPlainObject(value)) {
      const write = POLICIES.includes(value.write) ? value.write : 'read-only'
      const dshPanes = value.dshPanes instanceof Set ? value.dshPanes : new Set(Array.isArray(value.dshPanes) ? value.dshPanes : [])
      return { write, dshPanes }
    }
    return { write: 'read-only', dshPanes: new Set() }
  }

  _findBot(id) {
    if (typeof id !== 'string' || id.trim() === '') return null
    const trimmed = id.trim()
    const direct = this._bots.get(trimmed)
    if (direct) return direct
    const paneId = namespacePaneId(normalizeRawId(trimmed), this.idPrefix)
    return this._bots.get(paneId) ?? null
  }

  _isStale(bot, at) {
    if (bot.lastHeartbeatAt === null) return true
    return at - bot.lastHeartbeatAt > bot.ttlMs
  }

  _toPane(bot, at) {
    const stale = this._isStale(bot, at)
    const { write, dshPanes } = this._resolvePolicy()
    const hasCallback = bot.callbackUrl !== null
    let writable
    let writableReason
    if (!hasCallback) {
      writable = false
      writableReason = 'policy-read-only'
    } else {
      const decision = writability(
        { id: bot.paneId, isAgent: true },
        { policy: write, dshPanes, connected: !stale, stale },
      )
      writable = decision.writable
      writableReason = decision.reason
    }

    const validName = typeof bot.name === 'string' && AGENT_NAME.test(bot.name) ? bot.name : null
    const summaryText = typeof bot.summary === 'string' && bot.summary.trim() !== '' ? clipText(bot.summary) : ''
    const summarySource = summaryText !== '' && SUMMARY_SOURCES.has(bot.summarySource) && bot.summarySource !== 'none'
      ? bot.summarySource
      : 'none'

    return {
      id: bot.paneId,
      workspaceId: bot.workspaceId,
      tabId: bot.tabId,
      workspaceLabel: bot.workspaceLabel,
      tabLabel: bot.tabLabel,
      title: bot.title,
      cwd: bot.cwd,
      focused: false,
      agent: {
        kind: bot.agentKind,
        name: validName,
        display: bot.display,
        session: { kind: bot.agentKind, source: bot.source },
        interactiveReady: hasCallback && !stale ? bot.interactiveReady : false,
      },
      status: bot.status,
      stalled: isStalled({ status: bot.status, outputAt: bot.outputAt }, at),
      completionSeq: bot.completionSeq,
      stateChangeSeq: bot.stateChangeSeq,
      stateSince: bot.stateSince,
      outputAt: bot.outputAt,
      revision: bot.revision,
      summary: summaryText,
      summarySource,
      writable,
      writableReason,
      checks: cloneChecks(bot.checks),
    }
  }

  async _withLock(paneId, task) {
    const previous = this._locks.get(paneId) ?? Promise.resolve()
    let release
    const mine = new Promise((resolve) => { release = resolve })
    const tail = previous.then(() => mine)
    this._locks.set(paneId, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this._locks.get(paneId) === tail) this._locks.delete(paneId)
    }
  }

  onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('ExternalBotProvider.onChange: listener must be a function')
    this._listeners.add(listener)
    return () => { this._listeners.delete(listener) }
  }

  /** Load static bot definitions from `configPath` if configured and present. */
  loadConfig(path = this._configPath) {
    if (!path) return []
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.bots) ? parsed.bots : null
    if (list === null) throw new Error('ExternalBotProvider.loadConfig: config must be an array or { bots: [...] }')
    const registered = []
    for (const entry of list) {
      registered.push(this.register({ ...entry, source: 'config' }))
    }
    return registered
  }

  start() {
    if (this._configPath) this.loadConfig(this._configPath)
    if (this._sweepTimer === null) {
      this._sweepTimer = setInterval(() => this.sweep(), this._sweepIntervalMs)
      this._sweepTimer.unref?.()
    }
  }

  stop() {
    if (this._sweepTimer !== null) {
      clearInterval(this._sweepTimer)
      this._sweepTimer = null
    }
  }

  /** Check all bots against TTL; notify listeners if any bot newly became stale/offline. */
  sweep(at = this._now()) {
    let changed = false
    for (const bot of this._bots.values()) {
      const stale = this._isStale(bot, at)
      if (stale !== bot.lastObservedStale) {
        bot.lastObservedStale = stale
        changed = true
      }
    }
    if (changed) this._notify()
    return changed
  }

  /**
   * Register or update an external bot.
   * @param {object} input
   * @returns {object} contract-compliant Pane
   */
  register(input) {
    if (!isPlainObject(input)) throw new FleetError('invalid-request', 'Bot registration payload must be a JSON object.')
    const rawId = normalizeRawId(input.id)
    const paneId = namespacePaneId(rawId, this.idPrefix)
    const at = this._now()
    const callbackUrl = validateCallbackUrl(input.callbackUrl ?? input.webhookUrl)
    const status = normalizeStatus(input.status, 'idle')
    const existing = this._bots.get(paneId)

    const ttlMs = input.ttlMs !== undefined
      ? (Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? Math.floor(input.ttlMs) : (() => { throw new FleetError('invalid-request', 'ttlMs must be a positive number.') })())
      : (existing?.ttlMs ?? this._ttlMs)

    const agentKind = nonEmpty(input.kind ?? input.agentKind) ?? existing?.agentKind ?? 'bot'
    const display = nonEmpty(input.display ?? input.displayName) ?? existing?.display ?? rawId
    const title = typeof input.title === 'string' ? input.title : (existing?.title ?? display)
    const workspaceId = clampId(input.workspaceId, existing?.workspaceId ?? 'bots')
    const workspaceLabel = typeof input.workspaceLabel === 'string' ? input.workspaceLabel : (existing?.workspaceLabel ?? 'Agent Bots')
    const tabId = clampId(input.tabId, existing?.tabId ?? paneId)
    const tabLabel = typeof input.tabLabel === 'string' ? input.tabLabel : (existing?.tabLabel ?? display)
    const cwd = typeof input.cwd === 'string' ? input.cwd : (existing?.cwd ?? '')
    const name = typeof input.name === 'string' ? input.name : (existing?.name ?? (AGENT_NAME.test(rawId) ? rawId : null))
    const source = nonEmpty(input.source) ?? existing?.source ?? 'dynamic'
    const summary = typeof input.summary === 'string' ? input.summary : (existing?.summary ?? '')
    const summarySource = SUMMARY_SOURCES.has(input.summarySource)
      ? input.summarySource
      : (summary.trim() !== '' ? 'transcript' : (existing?.summarySource ?? 'none'))
    const screenText = typeof input.screenText === 'string' ? input.screenText : (existing?.screenText ?? '')
    const interactiveReady = typeof input.interactiveReady === 'boolean'
      ? input.interactiveReady
      : (existing?.interactiveReady ?? (callbackUrl !== null))
    const capabilities = Array.isArray(input.capabilities)
      ? new Set(input.capabilities.filter((v) => SUPPORTED_BOT_VERBS.has(v)))
      : (existing?.capabilities ?? new Set(SUPPORTED_BOT_VERBS))

    const statusChanged = existing ? existing.status !== status : false
    const bot = existing ?? {
      rawId,
      paneId,
      frames: [],
      frameSeq: 0,
      droppedFrames: false,
      sessionId: nonEmpty(input.sessionId) ?? `${paneId}-session`,
      revision: 1,
      completionSeq: status === 'done' ? 1 : 0,
      stateChangeSeq: 0,
      stateSince: at,
      outputAt: summary.trim() !== '' ? at : null,
      checks: cloneChecks(input.checks),
      lastObservedStale: false,
    }

    if (existing) {
      bot.revision += 1
      if (statusChanged) {
        bot.stateChangeSeq += 1
        bot.stateSince = at
        if (status === 'done') bot.completionSeq += 1
      }
      if (input.checks !== undefined) bot.checks = cloneChecks(input.checks)
    }

    bot.agentKind = agentKind
    bot.name = name
    bot.display = display
    bot.title = title
    bot.workspaceId = workspaceId
    bot.workspaceLabel = workspaceLabel
    bot.tabId = tabId
    bot.tabLabel = tabLabel
    bot.cwd = cwd
    bot.status = status
    bot.summary = summary
    bot.summarySource = summarySource
    bot.screenText = screenText
    bot.callbackUrl = callbackUrl
    bot.capabilities = capabilities
    bot.interactiveReady = interactiveReady
    bot.source = source
    bot.ttlMs = ttlMs
    bot.lastHeartbeatAt = input.initialOffline === true ? null : at
    bot.lastObservedStale = this._isStale(bot, at)

    this._bots.set(paneId, bot)
    this._notify()
    return this._toPane(bot, at)
  }

  /**
   * Record a heartbeat for an existing bot, optionally updating status/summary/screenText/title/cwd.
   * @param {string} id raw or namespaced bot id
   * @param {object} [patch]
   * @returns {object} updated contract-compliant Pane
   */
  heartbeat(id, patch = {}) {
    if (!isPlainObject(patch)) throw new FleetError('invalid-request', 'Heartbeat patch must be a JSON object.')
    const bot = this._findBot(id)
    if (!bot) throw new FleetError('unknown-pane', 'There is no bot with this id.')

    const at = this._now()
    const wasStale = this._isStale(bot, at)
    let visibleChanged = wasStale

    if (patch.status !== undefined) {
      const nextStatus = normalizeStatus(patch.status)
      if (nextStatus !== bot.status) {
        bot.status = nextStatus
        bot.stateChangeSeq += 1
        bot.stateSince = at
        if (nextStatus === 'done') bot.completionSeq += 1
        visibleChanged = true
      }
    }
    if (patch.summary !== undefined) {
      if (typeof patch.summary !== 'string') throw new FleetError('invalid-request', 'summary must be a string.')
      if (patch.summary !== bot.summary) {
        bot.summary = patch.summary
        bot.summarySource = SUMMARY_SOURCES.has(patch.summarySource)
          ? patch.summarySource
          : (patch.summary.trim() !== '' ? 'transcript' : 'none')
        bot.outputAt = at
        visibleChanged = true
      }
    }
    if (patch.screenText !== undefined) {
      if (typeof patch.screenText !== 'string') throw new FleetError('invalid-request', 'screenText must be a string.')
      if (patch.screenText !== bot.screenText) {
        bot.screenText = patch.screenText
        bot.outputAt = at
        if (bot.status === 'blocked' && patch.summary === undefined) {
          const derived = deriveSummary({ status: 'blocked', screenText: patch.screenText })
          if (derived.text) {
            bot.summary = derived.text
            bot.summarySource = derived.source
          }
        }
        visibleChanged = true
      }
    }
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string') throw new FleetError('invalid-request', 'title must be a string.')
      if (patch.title !== bot.title) { bot.title = patch.title; visibleChanged = true }
    }
    if (patch.cwd !== undefined) {
      if (typeof patch.cwd !== 'string') throw new FleetError('invalid-request', 'cwd must be a string.')
      if (patch.cwd !== bot.cwd) { bot.cwd = patch.cwd; visibleChanged = true }
    }
    if (patch.interactiveReady !== undefined) {
      if (typeof patch.interactiveReady !== 'boolean' && patch.interactiveReady !== null) {
        throw new FleetError('invalid-request', 'interactiveReady must be boolean or null.')
      }
      if (patch.interactiveReady !== bot.interactiveReady) { bot.interactiveReady = patch.interactiveReady; visibleChanged = true }
    }
    if (patch.outputAt !== undefined) {
      const nextOut = patch.outputAt === null ? null : instant(patch.outputAt)
      if (patch.outputAt !== null && nextOut === null) throw new FleetError('invalid-request', 'outputAt must be a non-negative integer or null.')
      if (nextOut !== bot.outputAt) { bot.outputAt = nextOut; visibleChanged = true }
    }

    bot.lastHeartbeatAt = at
    bot.lastObservedStale = false
    if (visibleChanged) {
      bot.revision += 1
      this._notify()
    }
    return this._toPane(bot, at)
  }

  /**
   * Append a normalized contract Frame into the bot's ring buffer.
   * @param {string} id raw or namespaced bot id
   * @param {object} rawFrame
   * @returns {object} normalized contract Frame
   */
  recordEvent(id, rawFrame) {
    const bot = this._findBot(id)
    if (!bot) throw new FleetError('unknown-pane', 'There is no bot with this id.')

    const at = this._now()
    const seq = bot.frameSeq + 1
    const frame = normalizeFrame(rawFrame, seq, at)
    bot.frameSeq = seq
    bot.frames.push({ seq, frame })
    if (bot.frames.length > this._maxFrames) {
      bot.frames.splice(0, bot.frames.length - this._maxFrames)
      bot.droppedFrames = true
    }

    if (frame.kind === 'session' && frame.sessionId) {
      bot.sessionId = frame.sessionId
      if (frame.cwd) bot.cwd = frame.cwd
    }

    bot.lastHeartbeatAt = at
    bot.lastObservedStale = false
    bot.outputAt = at
    bot.revision += 1

    const derived = deriveSummary({
      status: bot.status === 'idle' || bot.status === 'unknown' ? 'done' : bot.status,
      frames: bot.frames.map((entry) => entry.frame),
      screenText: bot.screenText,
    })
    if (derived.text !== '') {
      bot.summary = derived.text
      bot.summarySource = derived.source
    }

    this._notify()
    return frame
  }

  /** List contract-compliant Panes for all registered external bots. */
  listPanes({ now } = {}) {
    const at = instant(now) ?? this._now()
    return [...this._bots.values()].map((bot) => this._toPane(bot, at))
  }

  /** Detailed bot listing for `/plugin/fleet/bots/list` (never exposes callbackUrl secrets). */
  listBots({ now } = {}) {
    const at = instant(now) ?? this._now()
    return [...this._bots.values()].map((bot) => {
      const stale = this._isStale(bot, at)
      return {
        id: bot.paneId,
        rawId: bot.rawId,
        online: !stale,
        stale,
        lastHeartbeatAt: bot.lastHeartbeatAt,
        ttlMs: bot.ttlMs,
        hasCallback: bot.callbackUrl !== null,
        frameCount: bot.frames.length,
        pane: this._toPane(bot, at),
      }
    })
  }

  /** Read paginated frames from the bot's ring buffer in contract `FramesResponse` shape. */
  async frames(id, { before, after, limit = DEFAULT_LIMIT } = {}) {
    const bot = this._findBot(id)
    if (!bot) throw new FleetError('unknown-pane', 'There is no bot with this id.')
    if (before !== undefined && after !== undefined) {
      throw new FleetError('invalid-request', 'before and after are mutually exclusive.')
    }
    const clampedLimit = Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : DEFAULT_LIMIT
    const beforeSeq = parseCursor(before)
    const afterSeq = parseCursor(after)

    if (bot.frames.length === 0) {
      return {
        ok: true,
        paneId: bot.paneId,
        source: afterSeq !== null ? 'transcript' : 'none',
        reason: afterSeq !== null ? null : 'not-yet',
        agentKind: bot.agentKind,
        sessionId: bot.sessionId,
        frames: [],
        hasEarlier: false,
        partial: bot.droppedFrames,
        reset: false,
        unknownFrames: 0,
        cursor: { start: null, end: null },
      }
    }

    const oldestSeq = bot.frames[0].seq
    let slice
    let hasEarlier = false
    let reset = false

    if (afterSeq !== null) {
      if (afterSeq < oldestSeq - 1) {
        // The requested cursor fell off the ring buffer: tell the client to reset with the latest window.
        reset = true
        slice = bot.frames.slice(-clampedLimit)
        hasEarlier = bot.frames.length > slice.length || bot.droppedFrames
      } else {
        const newer = bot.frames.filter((entry) => entry.seq > afterSeq)
        slice = newer.slice(-clampedLimit)
        hasEarlier = false
      }
    } else if (beforeSeq !== null) {
      const earlier = bot.frames.filter((entry) => entry.seq < beforeSeq)
      slice = earlier.slice(-clampedLimit)
      hasEarlier = earlier.length > slice.length || (slice.length > 0 && slice[0].seq === oldestSeq && bot.droppedFrames)
    } else {
      slice = bot.frames.slice(-clampedLimit)
      hasEarlier = bot.frames.length > slice.length || bot.droppedFrames
    }

    return {
      ok: true,
      paneId: bot.paneId,
      source: 'transcript',
      reason: null,
      agentKind: bot.agentKind,
      sessionId: bot.sessionId,
      frames: slice.map((entry) => structuredClone(entry.frame)),
      hasEarlier,
      partial: bot.droppedFrames,
      reset,
      unknownFrames: 0,
      cursor: slice.length > 0
        ? { start: `seq:${slice[0].seq}`, end: `seq:${slice.at(-1).seq}` }
        : { start: null, end: null },
    }
  }

  /** Return a contract `ScreenResponse` for an online bot (used for blocked approval views). */
  async screen(id) {
    const bot = this._findBot(id)
    if (!bot) throw new FleetError('unknown-pane', 'There is no bot with this id.')
    const at = this._now()
    if (this._isStale(bot, at)) {
      throw new FleetError('herdr-offline', 'External bot is offline.')
    }
    return {
      ok: true,
      paneId: bot.paneId,
      revision: bot.revision,
      format: 'ansi',
      text: bot.screenText || bot.summary || '',
      cols: null,
      rows: null,
      at,
    }
  }

  /**
   * Dispatch a safe action (`prompt`, `answer`, `interrupt`) to the bot's configured callback URL.
   * Enforces policy, staleness, blocked state, and `expectRevision` on `answer` BEFORE invoking the fetcher.
   */
  async act(request) {
    const started = this._now()
    let verb = null
    let paneId = null
    try {
      const valid = validateRequest(request)
      verb = valid.verb
      paneId = valid.pane

      if (!SUPPORTED_BOT_VERBS.has(verb)) {
        throw new FleetError('invalid-request', `External bots only support ${[...SUPPORTED_BOT_VERBS].join(', ')}.`)
      }

      const bot = this._findBot(paneId)
      if (!bot) throw new FleetError('unknown-pane', 'There is no bot with this id.')
      paneId = bot.paneId

      const revision = await this._withLock(paneId, async () => {
        const at = this._now()
        const { write, dshPanes } = this._resolvePolicy()
        const stale = this._isStale(bot, at)

        if (write === 'read-only') {
          throw new FleetError('policy-denied', 'The write policy (read-only) does not allow this.', { policy: 'read-only' })
        }
        if (write === 'dsh-only' && !dshPanes.has(paneId)) {
          throw new FleetError('policy-denied', 'The write policy (dsh-only) does not allow writing to this bot.', { policy: 'dsh-only' })
        }
        if (bot.callbackUrl === null) {
          throw new FleetError('policy-denied', 'This bot has no callback URL configured and is read-only.', { policy: 'read-only' })
        }
        if (!bot.capabilities.has(verb)) {
          throw new FleetError('policy-denied', `This bot does not allow the ${verb} action.`, { policy: 'read-only' })
        }
        if (stale) {
          throw new FleetError('herdr-offline', 'External bot is offline; nothing was sent.')
        }

        if (verb === 'prompt' && bot.status === 'blocked') {
          throw new FleetError('agent-blocked', 'The bot is waiting on a question. Use answer instead of prompt.', { status: 'blocked' })
        }
        if (verb === 'answer') {
          if (bot.status !== 'blocked') {
            throw new FleetError('not-blocked', 'The bot is not waiting on a question. Use prompt instead.')
          }
          if (bot.revision !== valid.expectRevision) {
            throw new FleetError(
              'screen-changed',
              'The bot state changed after you looked at it, so nothing was sent. Refresh and decide again.',
              { revision: bot.revision },
            )
          }
        }

        const payload = { verb, pane: bot.paneId, botId: bot.rawId }
        if (verb === 'prompt') payload.text = valid.text
        if (verb === 'answer') {
          payload.text = valid.text
          payload.enter = valid.enter
          payload.expectRevision = valid.expectRevision
        }

        await this._dispatchCallback(bot.callbackUrl, payload)
        bot.revision += 1
        bot.outputAt = this._now()
        bot.lastHeartbeatAt = bot.outputAt
        bot.lastObservedStale = false
        this._notify()
        return bot.revision
      })

      this._emitLog({ verb, pane: paneId, ok: true, reason: null, ms: Math.max(0, this._now() - started) })
      return { ok: true, verb, pane: paneId, revision }
    } catch (error) {
      const failure = error instanceof FleetError ? error : new FleetError('internal', 'Internal error.')
      this._emitLog({ verb, pane: paneId, ok: false, reason: failure.reason, ms: Math.max(0, this._now() - started) })
      throw failure
    }
  }

  async _dispatchCallback(url, payload) {
    if (typeof this._fetcher !== 'function') {
      throw new FleetError('herdr-offline', 'No HTTP fetcher is available for external bot callbacks.')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this._timeoutMs)
    timer.unref?.()
    let response
    try {
      response = await this._fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new FleetError('timeout', 'External bot callback timed out; its outcome is unknown.')
      }
      throw new FleetError('herdr-offline', 'External bot callback could not be reached.')
    } finally {
      clearTimeout(timer)
    }

    if (!response?.ok) {
      const code = Number.isInteger(response?.status) ? String(response.status) : 'callback_error'
      throw new FleetError('herdr-error', 'External bot callback rejected the action.', { code })
    }
  }
}
