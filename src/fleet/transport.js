/**
 * Fleet client transports:
 *  - LiveTransport: single EventSource('/plugin/fleet/stream') + on-demand /frames, /screen, /act.
 *  - FixtureTransport: deterministic scenarios (`busy`, `blocked`, `calm`, `empty`, `offline`, `stale`)
 *    with exact timestamp rebasing (`now`, `stateSince`, `outputAt`, `lastOkAt`, `at`) and full
 *    contract-compliant act() simulation (including expectRevision -> 409 screen-changed and
 *    confirm === true guards).
 */

import { POLICIES, writability } from '../../lib/fleet/writability.js'

const BUILTIN_NOW = 1_800_000_000_000
const NO_CHECKS = {
  gate: 'none',
  startedAt: null,
  durationMs: null,
  baseRevision: null,
  headRevision: null,
  steps: [],
  failure: null,
}

function makeBuiltinFixtures() {
  const n = BUILTIN_NOW
  const healthOk = {
    connected: true,
    socket: '~/.config/herdr/herdr.sock',
    version: '0.9.5',
    protocol: 22,
    lastOkAt: n - 800,
    error: null,
    session: null,
  }
  const blockedPane = {
    id: 'w1:p1',
    workspaceId: 'w1',
    tabId: 'w1:t1',
    workspaceLabel: 'dsh-fleet',
    tabLabel: 'main',
    title: '审查构建脚本',
    cwd: '~/demo/work/dsh-fleet',
    focused: false,
    agent: { kind: 'claude', name: 'dsh-reviewer', display: 'claude · reviewer', session: null, interactiveReady: true },
    status: 'blocked',
    stalled: false,
    completionSeq: 3,
    stateChangeSeq: 12,
    stateSince: n - 240_000,
    outputAt: n - 240_000,
    revision: 412,
    summary: '等待批准：Bash — rm -rf dist/ && bun run build',
    summarySource: 'screen',
    writable: true,
    writableReason: null,
    checks: { ...NO_CHECKS },
  }
  const donePane = {
    id: 'w1:p2',
    workspaceId: 'w1',
    tabId: 'w1:t1',
    workspaceLabel: 'dsh-fleet',
    tabLabel: 'main',
    title: '运行单元测试',
    cwd: '~/demo/work/dsh-fleet',
    focused: false,
    agent: { kind: 'codex', name: 'dsh-tester', display: 'codex · tester', session: null, interactiveReady: true },
    status: 'done',
    stalled: false,
    completionSeq: 15,
    stateChangeSeq: 44,
    stateSince: n - 720_000,
    outputAt: n - 720_000,
    revision: 903,
    summary: '全部测试通过',
    summarySource: 'transcript',
    writable: true,
    writableReason: null,
    checks: {
      gate: 'passed',
      startedAt: null,
      durationMs: 2150,
      baseRevision: 'abc1234',
      headRevision: 'def5678',
      steps: [{ name: 'test', status: 'passed', durationMs: 2150, summary: 'all tests passed' }],
      failure: null,
    },
  }
  const workingPane = {
    id: 'w1:p3',
    workspaceId: 'w1',
    tabId: 'w1:t1',
    workspaceLabel: 'dsh-fleet',
    tabLabel: 'main',
    title: '实现控制室界面',
    cwd: '~/demo/work/dsh-fleet',
    focused: true,
    agent: { kind: 'pi', name: 'dsh-frontend', display: 'pi · frontend', session: { kind: 'path', source: 'herdr:pi' }, interactiveReady: true },
    status: 'working',
    stalled: false,
    completionSeq: 6,
    stateChangeSeq: 52,
    stateSince: n - 540_000,
    outputAt: n - 3_000,
    revision: 1288,
    summary: '正在更新 src/fleet/stage.jsx',
    summarySource: 'transcript',
    writable: true,
    writableReason: null,
    checks: { ...NO_CHECKS },
  }
  const idlePane = {
    id: 'w1:p4',
    workspaceId: 'w1',
    tabId: 'w1:t1',
    workspaceLabel: 'dsh-fleet',
    tabLabel: 'main',
    title: '文档整理',
    cwd: '~/demo/work/docs',
    focused: false,
    agent: { kind: 'opencode', name: 'docs-writer', display: 'opencode · docs', session: null, interactiveReady: true },
    status: 'idle',
    stalled: false,
    completionSeq: 1,
    stateChangeSeq: 4,
    stateSince: n - 1_800_000,
    outputAt: n - 1_800_000,
    revision: 64,
    summary: '',
    summarySource: 'none',
    writable: true,
    writableReason: null,
    checks: { ...NO_CHECKS },
  }
  const shellPane = {
    id: 'w1:p5',
    workspaceId: 'w1',
    tabId: 'w1:t1',
    workspaceLabel: 'dsh-fleet',
    tabLabel: 'main',
    title: 'zsh — dsh-fleet',
    cwd: '~/demo/work/dsh-fleet',
    focused: false,
    agent: null,
    status: 'unknown',
    stalled: false,
    completionSeq: 0,
    stateChangeSeq: 0,
    stateSince: n - 1_800_000,
    outputAt: n - 1_800_000,
    revision: 5,
    summary: '',
    summarySource: 'none',
    writable: false,
    writableReason: 'not-an-agent',
    checks: { ...NO_CHECKS },
  }

  const baseState = (overrides) => ({
    ok: true,
    protocol: 1,
    revision: 100,
    now: n,
    stale: false,
    machine: { id: 'local', label: '本机' },
    health: { ...healthOk },
    policy: { write: 'all' },
    workspaces: [{ id: 'w1', label: 'dsh-fleet', focused: true, tabCount: 1, paneCount: 0 }],
    panes: [],
    counts: { blocked: 0, done: 0, working: 0, idle: 0, unknown: 0, agents: 0, shells: 0, panes: 0 },
    ...overrides,
  })

  const buildScenario = (panes, stateOverrides = {}, screens = {}, frames = {}) => {
    const state = baseState({ panes, ...stateOverrides })
    recomputeCountsAndWorkspaces(state)
    return { state, frames, screens }
  }

  const blockedScreen = {
    ok: true,
    paneId: 'w1:p1',
    revision: 412,
    format: 'ansi',
    text: '\u001b[1;36mBash\u001b[0m rm -rf dist/ && bun run build\nDo you want to proceed?\n  1. Yes\n  2. No\n',
    cols: 120,
    rows: 32,
    at: n - 1000,
  }
  const blockedFrames = {
    ok: true,
    paneId: 'w1:p1',
    source: 'transcript',
    reason: null,
    agentKind: 'claude',
    sessionId: 'demo-session-1',
    frames: [
      { kind: 'session', id: 'f1', sessionId: 'demo-session-1', cwd: '~/demo/work/dsh-fleet' },
      { kind: 'text', id: 'f2', role: 'user', text: '清理构建产物并重新构建。', at: n - 300_000 },
      { kind: 'reasoning', id: 'f3', text: '需要先运行清理再执行 bun run build。' },
      { kind: 'work', id: 'f4', summary: '等待批准', rows: [{ verb: 'Bash', object: 'rm -rf dist/ && bun run build', outcome: null, ms: null }], tokens: 1200 },
    ],
    hasEarlier: false,
    partial: false,
    reset: false,
    unknownFrames: 0,
    cursor: { start: 'o:0', end: 'o:1024' },
  }

  const stalePanes = [workingPane, shellPane].map((p) => ({
    ...p,
    writable: false,
    writableReason: p.agent === null ? 'not-an-agent' : 'offline',
  }))

  return {
    about: 'Built-in neutral fallback fixtures for browser dev switcher',
    now: n,
    scenarios: {
      busy: buildScenario(
        [blockedPane, donePane, workingPane, idlePane, shellPane],
        {},
        { 'w1:p1': blockedScreen },
        { 'w1:p1': blockedFrames },
      ),
      blocked: buildScenario([blockedPane], {}, { 'w1:p1': blockedScreen }, { 'w1:p1': blockedFrames }),
      calm: buildScenario([idlePane]),
      empty: buildScenario([shellPane]),
      offline: buildScenario([], {
        revision: 0,
        stale: false,
        health: { connected: false, socket: null, version: null, protocol: null, lastOkAt: null, error: 'herdr socket not found', session: null },
      }),
      stale: buildScenario(stalePanes, {
        stale: true,
        health: { connected: false, socket: '~/.config/herdr/herdr.sock', version: '0.9.5', protocol: 22, lastOkAt: n - 45_000, error: 'ECONNREFUSED', session: null },
      }),
    },
  }
}

let cachedBuiltinFixtures = null
function getDefaultFixtures() {
  if (!cachedBuiltinFixtures) cachedBuiltinFixtures = makeBuiltinFixtures()
  return cachedBuiltinFixtures
}

export const TIME_FIELDS = Object.freeze(['now', 'stateSince', 'outputAt', 'lastOkAt', 'at'])

export const WHITELIST_KEYS = Object.freeze([
  'enter', 'esc', 'tab', 'shift+tab',
  'up', 'down', 'left', 'right',
  'space', 'backspace',
  'ctrl+c', 'ctrl+d',
  'y', 'n', '1', '2', '3', '4',
])

export const VERBS = Object.freeze([
  'prompt', 'answer', 'keys', 'interrupt', 'rename', 'restart', 'close',
])

export const SCENARIO_NAMES = Object.freeze([
  'busy', 'blocked', 'calm', 'empty', 'offline', 'stale',
])

const TIME_FIELD_SET = new Set(TIME_FIELDS)
const KEY_SET = new Set(WHITELIST_KEYS)
const VERB_SET = new Set(VERBS)
const NEEDS_CONFIRM = new Set(['restart', 'close'])
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

/**
 * Deep-clone `value` and shift ONLY epoch-ms instants listed in TIME_FIELDS by `delta`.
 * `null` stays `null`; durations (`ms`, `durationMs`) and revisions are untouched.
 */
export function rebaseTimestamps(value, delta) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => rebaseTimestamps(item, delta))
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (TIME_FIELD_SET.has(key) && typeof child === 'number' && Number.isFinite(child)) {
      out[key] = Math.max(0, Math.round(child + delta))
    } else {
      out[key] = rebaseTimestamps(child, delta)
    }
  }
  return out
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isValidId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
}

function hasOnlyKeys(obj, allowed) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return false
  }
  return true
}

/**
 * Contract-compliant request validation order (FLEET-API.md §6, steps 2-6).
 * Returns null if valid shape, or `{ ok: false, status, reason, message }`.
 */
export function validateActShape(request) {
  const fail = (status, reason, message) => ({ ok: false, status, reason, message })

  if (!isPlainObject(request) || typeof request.verb !== 'string') {
    return fail(400, 'invalid-request', '请求体必须是包含 verb 的对象')
  }
  if (!VERB_SET.has(request.verb)) {
    return fail(400, 'unknown-verb', `不支持的操作：${request.verb}`)
  }
  if (NEEDS_CONFIRM.has(request.verb) && request.confirm !== true) {
    return fail(400, 'confirm-required', `${request.verb} 需要显式确认（confirm: true）`)
  }
  if (request.verb === 'keys' && Array.isArray(request.keys) && request.keys.some((k) => !KEY_SET.has(k))) {
    return fail(400, 'key-not-allowed', '包含白名单之外的按键')
  }

  switch (request.verb) {
    case 'prompt':
      if (!hasOnlyKeys(request, new Set(['verb', 'pane', 'text']))
        || !isValidId(request.pane)
        || typeof request.text !== 'string'
        || request.text.length < 1 || request.text.length > 20000) {
        return fail(400, 'invalid-request', 'prompt 参数不合法')
      }
      return null
    case 'answer':
      if (!hasOnlyKeys(request, new Set(['verb', 'pane', 'text', 'enter', 'expectRevision']))
        || !isValidId(request.pane)
        || typeof request.text !== 'string'
        || request.text.length < 1 || request.text.length > 2000
        || typeof request.enter !== 'boolean'
        || !isNonNegInt(request.expectRevision)) {
        return fail(400, 'invalid-request', 'answer 参数不合法')
      }
      return null
    case 'keys':
      if (!hasOnlyKeys(request, new Set(['verb', 'pane', 'keys', 'expectRevision']))
        || !isValidId(request.pane)
        || !Array.isArray(request.keys)
        || request.keys.length < 1 || request.keys.length > 8
        || !isNonNegInt(request.expectRevision)) {
        return fail(400, 'invalid-request', 'keys 参数不合法')
      }
      return null
    case 'interrupt':
      if (!hasOnlyKeys(request, new Set(['verb', 'pane'])) || !isValidId(request.pane)) {
        return fail(400, 'invalid-request', 'interrupt 参数不合法')
      }
      return null
    case 'rename':
      if (!hasOnlyKeys(request, new Set(['verb', 'pane', 'name']))
        || !isValidId(request.pane)
        || typeof request.name !== 'string'
        || !AGENT_NAME_RE.test(request.name)) {
        return fail(400, 'invalid-request', 'name 必须匹配 ^[a-z][a-z0-9_-]{0,31}$')
      }
      return null
    case 'restart':
      if (!hasOnlyKeys(request, new Set(['verb', 'pane', 'confirm', 'thenPrompt']))
        || !isValidId(request.pane)
        || request.confirm !== true
        || ('thenPrompt' in request && (typeof request.thenPrompt !== 'string' || request.thenPrompt.length < 1 || request.thenPrompt.length > 20000))) {
        return fail(400, 'invalid-request', 'restart 参数不合法')
      }
      return null
    case 'close':
      if (!hasOnlyKeys(request, new Set(['verb', 'pane', 'confirm']))
        || !isValidId(request.pane)
        || request.confirm !== true) {
        return fail(400, 'invalid-request', 'close 参数不合法')
      }
      return null
    default:
      return fail(400, 'unknown-verb', '未知操作')
  }
}

/* ---------------------------------------------------------------------------- LiveTransport */

export class LiveTransport {
  constructor({ baseUrl = '/plugin/fleet', fetchImpl = globalThis.fetch?.bind(globalThis), EventSourceImpl = globalThis.EventSource } = {}) {
    this.kind = 'live'
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this._fetch = fetchImpl
    this._EventSource = EventSourceImpl
    this._listeners = new Set()
    this._stream = null
    this._state = null
  }

  _notify(state) {
    this._state = state
    for (const listener of this._listeners) {
      try { listener(state) } catch { /* isolate subscriber errors */ }
    }
  }

  _openStream() {
    if (this._stream || typeof this._EventSource !== 'function') return
    const es = new this._EventSource(`${this.baseUrl}/stream`)
    es.addEventListener('state', (event) => {
      try {
        const parsed = JSON.parse(event.data)
        if (parsed && parsed.ok === true) this._notify(parsed)
      } catch { /* ignore malformed SSE payload */ }
    })
    this._stream = es
  }

  _closeStream() {
    if (!this._stream) return
    try { this._stream.close() } catch { /* ignore */ }
    this._stream = null
  }

  subscribe(listener) {
    this._listeners.add(listener)
    if (this._state) listener(this._state)
    if (this._listeners.size === 1) {
      this._openStream()
      if (!this._state) {
        void this.getState().then((s) => {
          if (s && s.ok === true && this._listeners.size > 0) this._notify(s)
        }).catch(() => {})
      }
    }
    return () => {
      this._listeners.delete(listener)
      if (this._listeners.size === 0) this._closeStream()
    }
  }

  reconnect() {
    this._closeStream()
    if (this._listeners.size > 0) this._openStream()
    return this.getState().then((s) => {
      if (s && s.ok === true) this._notify(s)
      return s
    })
  }

  async _json(url, init) {
    if (typeof this._fetch !== 'function') {
      return { ok: false, status: 503, reason: 'herdr-offline', message: 'fetch 不可用' }
    }
    try {
      const response = await this._fetch(url, { credentials: 'same-origin', ...init })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = { ok: false, reason: 'internal', message: `HTTP ${response.status}` }
      }
      if (payload && typeof payload === 'object') {
        return { status: response.status, ...payload }
      }
      return { ok: false, status: response.status, reason: 'internal', message: '响应格式错误' }
    } catch (error) {
      return { ok: false, status: 503, reason: 'herdr-offline', message: String(error?.message ?? error) }
    }
  }

  async getState() {
    return await this._json(`${this.baseUrl}/state`)
  }

  async getFrames(paneId, { after, before, limit } = {}) {
    const params = new URLSearchParams({ pane: paneId })
    if (after !== undefined && after !== null) params.set('after', String(after))
    if (before !== undefined && before !== null) params.set('before', String(before))
    if (limit !== undefined && limit !== null) params.set('limit', String(limit))
    return await this._json(`${this.baseUrl}/frames?${params.toString()}`)
  }

  async getScreen(paneId) {
    const params = new URLSearchParams({ pane: paneId })
    return await this._json(`${this.baseUrl}/screen?${params.toString()}`)
  }

  async act(request) {
    return await this._json(`${this.baseUrl}/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
  }

  async setPolicy(write) {
    return await this._json(`${this.baseUrl}/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ write }),
    })
  }

  async registerBot(bot) {
    return await this._json(`${this.baseUrl}/bots/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bot),
    })
  }

  close() {
    this._listeners.clear()
    this._closeStream()
  }
}

/* ---------------------------------------------------------------------------- FixtureTransport */

function recomputeCountsAndWorkspaces(state) {
  const counts = { blocked: 0, done: 0, working: 0, idle: 0, unknown: 0, agents: 0, shells: 0, panes: state.panes.length }
  const wsMap = new Map()
  for (const pane of state.panes) {
    if (pane.agent === null) counts.shells += 1
    else {
      counts.agents += 1
      if (pane.status in counts) counts[pane.status] += 1
    }
    const existing = wsMap.get(pane.workspaceId) ?? {
      id: pane.workspaceId,
      label: pane.workspaceLabel,
      focused: false,
      tabs: new Set(),
      paneCount: 0,
    }
    existing.tabs.add(pane.tabId)
    existing.paneCount += 1
    existing.focused ||= pane.focused
    wsMap.set(pane.workspaceId, existing)
  }
  state.counts = counts
  state.workspaces = [...wsMap.values()].map((w) => ({
    id: w.id,
    label: w.label,
    focused: w.focused,
    tabCount: w.tabs.size,
    paneCount: w.paneCount,
  }))
}

export class FixtureTransport {
  constructor({ scenario = 'busy', fixtures = getDefaultFixtures(), now = () => Date.now(), delta } = {}) {
    this.kind = 'fixture'
    this._fixtures = fixtures
    this._now = now
    this._fixedDelta = typeof delta === 'number' ? delta : null
    this._listeners = new Set()
    this._seq = 1
    this.setScenario(scenario)
  }

  get scenario() {
    return this._scenarioName
  }

  setScenario(name) {
    if (!this._fixtures?.scenarios?.[name]) {
      throw new Error(`unknown fixture scenario: ${name}`)
    }
    this._scenarioName = name
    const d = this._fixedDelta !== null ? this._fixedDelta : this._now() - this._fixtures.now
    this._delta = d
    const raw = this._fixtures.scenarios[name]
    this._state = rebaseTimestamps(raw.state, d)
    this._frames = rebaseTimestamps(raw.frames, d)
    this._screens = rebaseTimestamps(raw.screens, d)
    this._notify()
  }

  _notify() {
    const snap = structuredClone(this._state)
    for (const listener of this._listeners) {
      try { listener(snap) } catch { /* isolate */ }
    }
  }

  subscribe(listener) {
    this._listeners.add(listener)
    listener(structuredClone(this._state))
    return () => {
      this._listeners.delete(listener)
    }
  }

  async reconnect() {
    this._state.now = this._now()
    this._notify()
    return structuredClone(this._state)
  }

  async getState() {
    return structuredClone(this._state)
  }

  async getFrames(paneId, { after, before, limit } = {}) {
    if (after && before) {
      return { ok: false, status: 400, reason: 'invalid-request', message: 'before 与 after 不能同时指定' }
    }
    const pane = this._state.panes.find((p) => p.id === paneId)
    if (!pane) {
      return { ok: false, status: 404, reason: 'unknown-pane', message: `pane 不存在：${paneId}` }
    }
    const entry = this._frames[paneId]
    if (!entry) {
      return {
        ok: true,
        paneId,
        source: this._state.health.connected && !this._state.stale ? 'screen' : 'none',
        reason: 'no-transcript',
        agentKind: pane.agent?.kind ?? null,
        sessionId: null,
        frames: [],
        hasEarlier: false,
        partial: false,
        reset: false,
        unknownFrames: 0,
        cursor: { start: null, end: null },
      }
    }
    const cloned = structuredClone(entry)
    if (after && after === cloned.cursor?.end) {
      return { ...cloned, frames: [], hasEarlier: false, reset: false }
    }
    if (before && cloned.hasEarlier) {
      const earlierFrame = {
        kind: 'text',
        id: `earlier-${paneId}-${this._seq++}`,
        role: 'user',
        text: '（更早的历史记录已加载）先梳理一下现有模块边界。',
        at: Math.max(0, (cloned.frames.find((f) => typeof f.at === 'number')?.at ?? this._state.now) - 120_000),
      }
      return {
        ...cloned,
        frames: [earlierFrame],
        hasEarlier: false,
        cursor: { start: 'o:0', end: cloned.cursor?.start ?? null },
      }
    }
    if (typeof limit === 'number' && limit > 0 && cloned.frames.length > limit) {
      cloned.frames = cloned.frames.slice(-limit)
      cloned.hasEarlier = true
    }
    return cloned
  }

  async getScreen(paneId) {
    if (!this._state.health.connected || this._state.stale) {
      return { ok: false, status: 503, reason: 'herdr-offline', message: 'herdr 未连接，无法读取屏幕' }
    }
    const pane = this._state.panes.find((p) => p.id === paneId)
    if (!pane) {
      return { ok: false, status: 404, reason: 'unknown-pane', message: `pane 不存在：${paneId}` }
    }
    const screen = this._screens[paneId]
    if (!screen) {
      return {
        ok: true,
        paneId,
        revision: pane.revision,
        format: 'ansi',
        text: `\u001b[2m(${pane.title})\u001b[0m\n`,
        cols: 120,
        rows: 32,
        at: this._now(),
      }
    }
    const copy = structuredClone(screen)
    copy.revision = pane.revision
    return copy
  }

  /** Helper for tests & dev simulation: advance a pane's revision & screen text to trigger screen-changed. */
  bumpPaneRevision(paneId, screenText) {
    const pane = this._state.panes.find((p) => p.id === paneId)
    if (!pane) return null
    pane.revision += 1
    this._state.revision += 1
    if (this._screens[paneId]) {
      this._screens[paneId].revision = pane.revision
      if (typeof screenText === 'string') this._screens[paneId].text = screenText
      this._screens[paneId].at = this._now()
    }
    this._notify()
    return pane.revision
  }

  async act(request) {
    const shapeErr = validateActShape(request)
    if (shapeErr) return shapeErr

    const pane = this._state.panes.find((p) => p.id === request.pane)
    if (!pane) {
      return { ok: false, status: 404, reason: 'unknown-pane', message: `pane 不存在：${request.pane}` }
    }
    if (pane.agent === null) {
      return { ok: false, status: 409, reason: 'not-an-agent', message: '普通终端面板只读，不支持写操作' }
    }
    if (this._state.policy.write === 'read-only' || (!pane.writable && (pane.writableReason === 'policy-read-only' || pane.writableReason === 'policy-dsh-only'))) {
      return {
        ok: false,
        status: 403,
        reason: 'policy-denied',
        message: '当前写策略不允许操作该面板',
        detail: { policy: this._state.policy.write },
      }
    }
    if (!this._state.health.connected || this._state.stale) {
      return { ok: false, status: 503, reason: 'herdr-offline', message: 'herdr 未连接，无法执行写操作' }
    }

    if (request.verb === 'prompt' && pane.status === 'blocked') {
      return {
        ok: false,
        status: 409,
        reason: 'agent-blocked',
        message: 'Agent 正在等待审批或回答，请使用 answer 或 keys',
        detail: { status: pane.status },
      }
    }
    if (request.verb === 'answer' && pane.status !== 'blocked') {
      return {
        ok: false,
        status: 409,
        reason: 'not-blocked',
        message: 'Agent 当前未在等待回答，请改用 prompt',
        detail: { status: pane.status },
      }
    }
    if ((request.verb === 'answer' || request.verb === 'keys') && request.expectRevision !== pane.revision) {
      return {
        ok: false,
        status: 409,
        reason: 'screen-changed',
        message: '屏幕内容已变化，已拒绝发送按键/回答，请刷新屏幕后重试',
        detail: { revision: pane.revision },
      }
    }

    const nowMs = this._now()
    this._state.now = nowMs
    this._state.revision += 1

    const appendFrame = (frame) => {
      if (this._frames[pane.id] && this._frames[pane.id].source === 'transcript') {
        this._frames[pane.id].frames.push(frame)
        this._frames[pane.id].cursor.end = `o:${Date.now()}:${this._seq}`
      }
    }

    if (request.verb === 'prompt') {
      pane.revision += 1
      pane.status = 'working'
      pane.stalled = false
      pane.stateSince = nowMs
      pane.outputAt = nowMs
      pane.summary = request.text.slice(0, 240)
      pane.summarySource = 'transcript'
      appendFrame({ kind: 'text', id: `sim-${this._seq++}`, role: 'user', text: request.text, at: nowMs })
    } else if (request.verb === 'answer') {
      pane.revision += 1
      pane.status = 'working'
      pane.stalled = false
      pane.stateSince = nowMs
      pane.outputAt = nowMs
      pane.summary = `已回复：${request.text.slice(0, 120)}`
      pane.summarySource = 'screen'
      appendFrame({ kind: 'text', id: `sim-${this._seq++}`, role: 'user', text: request.text, at: nowMs })
      if (this._screens[pane.id]) {
        this._screens[pane.id].revision = pane.revision
        this._screens[pane.id].text += `\n\u001b[32m> ${request.text}\u001b[0m\n`
        this._screens[pane.id].at = nowMs
      }
    } else if (request.verb === 'keys') {
      pane.revision += 1
      const lastKey = request.keys[request.keys.length - 1]
      if (lastKey === 'ctrl+c' || lastKey === 'esc') {
        pane.status = 'idle'
        pane.stalled = false
        pane.stateSince = nowMs
      } else if (pane.status === 'blocked') {
        pane.status = 'working'
        pane.stalled = false
        pane.stateSince = nowMs
        pane.outputAt = nowMs
        pane.summary = `已发送按键：${request.keys.join(' ')}`
      }
      if (this._screens[pane.id]) {
        this._screens[pane.id].revision = pane.revision
        this._screens[pane.id].text += `\n\u001b[2m[keys: ${request.keys.join(' ')}]\u001b[0m\n`
        this._screens[pane.id].at = nowMs
      }
    } else if (request.verb === 'interrupt') {
      pane.revision += 1
      pane.status = 'idle'
      pane.stalled = false
      pane.stateSince = nowMs
      pane.summary = '已中断'
    } else if (request.verb === 'rename') {
      pane.revision += 1
      pane.agent.name = request.name
    } else if (request.verb === 'restart') {
      pane.revision += 1
      pane.status = request.thenPrompt ? 'working' : 'idle'
      pane.stalled = false
      pane.stateSince = nowMs
      pane.outputAt = nowMs
      pane.summary = request.thenPrompt ? request.thenPrompt.slice(0, 240) : '已重启'
    } else if (request.verb === 'close') {
      this._state.panes = this._state.panes.filter((p) => p.id !== pane.id)
      delete this._frames[pane.id]
      delete this._screens[pane.id]
      recomputeCountsAndWorkspaces(this._state)
      this._notify()
      return { ok: true, verb: 'close', pane: pane.id, revision: null }
    }

    recomputeCountsAndWorkspaces(this._state)
    this._notify()
    return { ok: true, verb: request.verb, pane: pane.id, revision: pane.revision }
  }

  _recomputeWritability() {
    const write = this._state.policy?.write ?? 'read-only'
    const connected = Boolean(this._state.health?.connected)
    const stale = Boolean(this._state.stale)
    const dshPanes = new Set(
      this._state.panes
        .filter((p) => typeof p.agent?.name === 'string' && p.agent.name.startsWith('dsh-'))
        .map((p) => p.id),
    )
    for (const pane of this._state.panes) {
      const { writable, reason } = writability(
        { id: pane.id, isAgent: pane.agent !== null },
        { policy: write, dshPanes, connected, stale },
      )
      pane.writable = writable
      pane.writableReason = reason
    }
  }

  async setPolicy(write) {
    if (typeof write !== 'string' || !POLICIES.includes(write)) {
      return {
        ok: false,
        status: 400,
        reason: 'invalid-request',
        message: '无效的写策略，仅支持 all / dsh-only / read-only',
      }
    }
    this._state.policy = { write }
    this._recomputeWritability()
    this._state.now = this._now()
    this._state.revision += 1
    this._notify()
    return { ok: true, policy: { write } }
  }

  async registerBot(bot) {
    if (!isPlainObject(bot) || typeof bot.id !== 'string' || bot.id.trim() === '') {
      return {
        ok: false,
        status: 400,
        reason: 'invalid-request',
        message: 'Bot id 必须是非空字符串',
      }
    }
    const trimmedId = bot.id.trim()
    const rawId = trimmedId.startsWith('bot:') ? trimmedId.slice(4).trim() : trimmedId
    if (!rawId) {
      return {
        ok: false,
        status: 400,
        reason: 'invalid-request',
        message: 'Bot id 必须是非空字符串',
      }
    }
    const paneId = `bot:${rawId}`.slice(0, 64)
    const nowMs = this._now()
    const kind = typeof bot.kind === 'string' && bot.kind.trim() ? bot.kind.trim() : 'bot'
    const rawName = typeof bot.name === 'string' ? bot.name.trim() : ''
    const agentName = AGENT_NAME_RE.test(rawName)
      ? rawName
      : (AGENT_NAME_RE.test(rawId) ? rawId : null)
    const display = typeof bot.display === 'string' && bot.display.trim()
      ? bot.display.trim()
      : (rawName || `${kind} · ${rawId}`)
    const title = typeof bot.title === 'string' && bot.title.trim()
      ? bot.title.trim()
      : (rawName || rawId)
    const summary = typeof bot.summary === 'string' ? bot.summary.trim().slice(0, 240) : ''
    const status = ['working', 'blocked', 'done', 'idle', 'unknown'].includes(bot.status)
      ? bot.status
      : 'idle'

    const pane = {
      id: paneId,
      workspaceId: 'bots',
      tabId: paneId,
      workspaceLabel: 'Agent Bots',
      tabLabel: kind,
      title,
      cwd: typeof bot.cwd === 'string' && bot.cwd.trim() ? bot.cwd.trim() : '~',
      focused: false,
      agent: {
        kind,
        name: agentName,
        display,
        session: null,
        interactiveReady: true,
      },
      status,
      stalled: false,
      completionSeq: 0,
      stateChangeSeq: 1,
      stateSince: nowMs,
      outputAt: nowMs,
      revision: 1,
      summary,
      summarySource: summary ? 'transcript' : 'none',
      writable: true,
      writableReason: null,
      checks: { ...NO_CHECKS, steps: [] },
    }

    const existingIdx = this._state.panes.findIndex((p) => p.id === paneId)
    if (existingIdx >= 0) {
      pane.revision = (this._state.panes[existingIdx].revision ?? 0) + 1
      this._state.panes[existingIdx] = pane
    } else {
      this._state.panes.push(pane)
    }

    if (!this._frames[paneId]) {
      this._frames[paneId] = {
        ok: true,
        paneId,
        source: 'transcript',
        reason: null,
        agentKind: kind,
        sessionId: paneId,
        frames: summary
          ? [{ kind: 'text', id: `bot-init-${this._seq++}`, role: 'assistant', text: summary, at: nowMs }]
          : [],
        hasEarlier: false,
        partial: false,
        reset: false,
        unknownFrames: 0,
        cursor: { start: 'o:0', end: `o:${this._seq}` },
      }
    }

    this._recomputeWritability()
    recomputeCountsAndWorkspaces(this._state)
    this._state.now = nowMs
    this._state.revision += 1
    this._notify()
    return { ok: true, pane: structuredClone(pane) }
  }

  close() {
    this._listeners.clear()
  }
}
