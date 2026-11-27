/**
 * FleetService: the host-side glue between HerdrState, transcripts, the state model, write actions, settings store,
 * and the project gate runner (docs/design/FLEET-HOST.md §2 & §5).
 *
 * Responsibilities:
 *  - `state()` returns a cached, contract-valid `State` synchronously (never waits on transcripts, screens, or gates);
 *  - `revision` increments only when the visible `State` (excluding `now` and `revision`) changes, notifying `onChange`;
 *  - background summary derivation (concurrency <= 2, cached per `(paneId, revision)`), best-effort and non-blocking;
 *  - background gate runner triggered on `working` -> `done` transitions for agent panes with a valid gate config;
 *  - `frames()` delegates to transcripts and falls back to `source: 'screen'` (connected) or `'none'` (offline);
 *  - `screen()` reads the visible ANSI screen via `pane.read`;
 *  - `act()` delegates to `createActions` (which validates, locks, writes, and refreshes state).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { buildState, deriveSummary } from './model.js'
import { createActions, mapHerdrError, validateRequest } from './actions.js'
import { FleetError } from './errors.js'
import { runGate } from './gate.js'
import { readGateConfig } from './gateconfig.js'
import { POLICIES, writability } from './writability.js'
import * as defaultTranscripts from '../transcripts/index.js'

const MAX_SUMMARY_CONCURRENCY = 2
const SUMMARY_SCREEN_TIMEOUT_MS = 3000
const SUMMARY_FRAME_LIMIT = 20
const MAX_ID_CHARS = 64
const MAX_GATE_OUTPUT_BYTES = 64 * 1024
const GIT_HEAD_TIMEOUT_MS = 5000

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Equality key for visible State changes: excludes `now` and `revision` themselves. */
function stateSignature(state) {
  return JSON.stringify({ ...state, now: 0, revision: 0 })
}

/**
 * Default child-process launcher for `runGate`. Never uses a shell, caps captured output, and kills the child if
 * aborted by the gate step deadline.
 */
function defaultGateSpawn(cmd, args = [], { cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('gate step aborted'), { code: 'ETIMEDOUT' }))
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
      return next.length > MAX_GATE_OUTPUT_BYTES ? next.slice(-MAX_GATE_OUTPUT_BYTES) : next
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
      reject(Object.assign(new Error('gate step timed out'), { code: 'ETIMEDOUT', stdout, stderr }))
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
      reject(Object.assign(error, { stdout, stderr }))
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ code, stdout, stderr })
    })
  })
}

/** Default git HEAD reader for `runGate`: returns the HEAD SHA, or null outside a git repo. */
async function defaultReadHead(cwd) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GIT_HEAD_TIMEOUT_MS)
  timer.unref?.()
  try {
    const result = await defaultGateSpawn('git', ['rev-parse', 'HEAD'], { cwd, signal: controller.signal })
    if (result.code !== 0) return null
    const sha = result.stdout.trim().split(/\r?\n/)[0] ?? ''
    return sha !== '' && [...sha].length <= 64 ? sha : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export class FleetService {
  #client
  #state
  #transcripts
  #store
  #registry
  #config
  #now
  #actions
  #gate

  #revision = 0
  #stateSignature = null
  #cachedState = null
  #listeners = new Set()
  #notifying = false

  // Summary derivation state: cached by paneId -> { revision, status, entry }, bounded concurrency <= 2.
  #summaries = new Map()
  #summaryQueue = new Map()
  #summaryInflight = new Map() // paneId -> `${revision}:${status}`
  #summaryActive = 0
  #summaryConcurrency

  // Gate runner state: paneId -> Checks, previous agent status per pane, and per-pane run token.
  #gates = new Map()
  #prevStatuses = new Map()
  #gateTokens = new Map()

  #stopped = false
  #starting = null
  #attached = false
  #onStateChange
  #onStateStatus
  #unsubRegistry = null

  /**
   * @param {object} deps
   * @param {{ request: Function }} deps.client
   * @param {{ snapshot: object, health: object, stale: boolean, start?: Function, stop?: Function, refresh?: Function, on?: Function, off?: Function }} deps.state
   * @param {{ readFrames: Function, supportsKind?: Function }} [deps.transcripts]
   * @param {{ policy: string, dshPanes: Set<string>, setPolicy?: Function }} deps.store
   * @param {{ listPanes: Function, onChange?: Function, resolve?: Function, resolvePane?: Function, providers?: Function }} [deps.registry]
   * @param {{ home?: string, summaryConcurrency?: number, gate?: { readConfig?: Function, run?: Function, spawn?: Function, readHead?: Function } }} [deps.config]
   * @param {() => number} [deps.now]
   * @param {(ms: number) => Promise<void>} [deps.sleep]
   * @param {(entry: object) => void} [deps.log]
   */
  constructor({
    client,
    state,
    transcripts = defaultTranscripts,
    store,
    registry = null,
    config = {},
    now = Date.now,
    sleep,
    log = () => {},
  } = {}) {
    if (typeof client?.request !== 'function') throw new TypeError('FleetService: client needs a request() method')
    if (!isObject(state)) throw new TypeError('FleetService: state is required')
    if (typeof transcripts?.readFrames !== 'function') throw new TypeError('FleetService: transcripts needs a readFrames() function')
    if (!isObject(store)) throw new TypeError('FleetService: store is required')

    this.#client = client
    this.#state = state
    this.#transcripts = transcripts
    this.#store = store
    this.#registry = isObject(registry) ? registry : null
    this.#config = isObject(config) ? config : {}
    this.#now = typeof now === 'function' ? now : Date.now

    const requestedConcurrency = this.#config.summaryConcurrency
    this.#summaryConcurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency >= 1
      ? Math.min(requestedConcurrency, MAX_SUMMARY_CONCURRENCY)
      : MAX_SUMMARY_CONCURRENCY

    const gateConfig = isObject(this.#config.gate) ? this.#config.gate : {}
    this.#gate = {
      readConfig: typeof gateConfig.readConfig === 'function' ? gateConfig.readConfig : readGateConfig,
      run: typeof gateConfig.run === 'function' ? gateConfig.run : runGate,
      spawn: typeof gateConfig.spawn === 'function' ? gateConfig.spawn : defaultGateSpawn,
      readHead: typeof gateConfig.readHead === 'function' ? gateConfig.readHead : defaultReadHead,
    }

    this.#actions = createActions({ client, state, store, log, now: () => this.#clock(), sleep })

    this.#onStateChange = () => {
      if (this.#stopped) return
      this.#handleSnapshotUpdate()
    }
    this.#onStateStatus = () => {
      if (this.#stopped) return
      this.#recompute()
    }

    const initial = this.#buildState(0)
    this.#cachedState = initial
    this.#stateSignature = stateSignature(initial)
    this.#seedStatuses(this.#state.snapshot)
  }

  get revision() { return this.#revision }

  /**
   * Synchronously return the cached contract-valid `State`. Never triggers I/O.
   * Re-checks policy/stalled changes synchronously if not inside an `onChange` callback.
   */
  state() {
    if (!this.#notifying && !this.#stopped) {
      if (this.#store.policy !== this.#cachedState.policy.write) this.#recompute()
    }
    return { ...this.#cachedState, now: this.#clock() }
  }

  /** Subscribe to visible `State` changes (`revision` increments). Returns an unsubscribe function. */
  onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('FleetService.onChange: listener must be a function')
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  async start() {
    if (this.#starting) return this.#starting
    this.#stopped = false
    this.#attach()
    this.#starting = (async () => {
      await this.#state.start?.()
      if (this.#stopped) return
      this.#handleSnapshotUpdate()
    })()
    return this.#starting
  }

  stop() {
    this.#stopped = true
    this.#starting = null
    this.#detach()
    this.#summaryQueue.clear()
    this.#summaryInflight.clear()
    // Advance gate tokens so any in-flight gate run discards its result on completion.
    for (const [paneId, token] of this.#gateTokens) this.#gateTokens.set(paneId, token + 1)
    this.#state.stop?.()
  }

  /**
   * Read normalized conversation frames for a pane, falling back to `source: 'screen'` (when herdr is connected)
   * or `source: 'none'` (when offline/stale) if no transcript is available.
   */
  async frames(paneId, { before, after, limit } = {}) {
    if (typeof paneId !== 'string' || paneId === '' || paneId.length > MAX_ID_CHARS) {
      throw new FleetError('invalid-request', 'pane is required.')
    }
    if (before !== undefined && after !== undefined) {
      throw new FleetError('invalid-request', 'before and after are mutually exclusive.')
    }
    const external = this.#resolveExternalPane(paneId)
    if (external) {
      if (typeof external.provider.frames !== 'function') {
        return {
          ok: true,
          paneId,
          source: 'none',
          reason: 'unsupported-agent',
          agentKind: null,
          sessionId: null,
          frames: [],
          hasEarlier: false,
          partial: false,
          reset: false,
          unknownFrames: 0,
          cursor: { start: null, end: null },
        }
      }
      const query = {}
      if (before !== undefined) query.before = before
      if (after !== undefined) query.after = after
      if (limit !== undefined) query.limit = limit
      const result = await external.provider.frames(external.rawId, query, { policy: this.#store.policy })
      return isObject(result) ? { ...result, paneId } : result
    }
    const pane = this.#findPane(paneId)
    if (pane === undefined) {
      const connected = this.#state.health?.connected === true
      const stale = this.#state.stale === true
      if (!connected && !stale) throw new FleetError('herdr-offline', 'herdr is not reachable.')
      throw new FleetError('unknown-pane', 'There is no pane with this id (it may have been closed).')
    }

    const canReadScreen = this.#state.health?.connected === true && this.#state.stale !== true
    const fallbackSource = canReadScreen ? 'screen' : 'none'
    const agentKind = typeof pane.agent === 'string' && pane.agent !== '' ? pane.agent : null

    if (agentKind === null) {
      return {
        ok: true,
        paneId: pane.id,
        source: fallbackSource,
        reason: 'unsupported-agent',
        agentKind: null,
        sessionId: null,
        frames: [],
        hasEarlier: false,
        partial: false,
        reset: false,
        unknownFrames: 0,
        cursor: { start: null, end: null },
      }
    }

    const options = {
      kind: agentKind,
      session: pane.agentSession ?? null,
      cwd: pane.foregroundCwd || pane.cwd || null,
      before,
      after,
      limit,
    }
    if (this.#config.home !== undefined) options.home = this.#config.home

    const result = await this.#transcripts.readFrames(options)
    if (result?.status === 'ok') {
      return {
        ok: true,
        paneId: pane.id,
        source: 'transcript',
        reason: null,
        agentKind,
        sessionId: result.sessionId ?? null,
        frames: Array.isArray(result.frames) ? result.frames : [],
        hasEarlier: result.hasEarlier === true,
        partial: result.partial === true,
        reset: result.reset === true,
        unknownFrames: Number.isInteger(result.unknownFrames) && result.unknownFrames >= 0 ? result.unknownFrames : 0,
        cursor: {
          start: typeof result.cursor?.start === 'string' ? result.cursor.start : null,
          end: typeof result.cursor?.end === 'string' ? result.cursor.end : null,
        },
      }
    }

    return {
      ok: true,
      paneId: pane.id,
      source: fallbackSource,
      reason: result?.reason ?? 'no-transcript',
      agentKind,
      sessionId: null,
      frames: [],
      hasEarlier: false,
      partial: false,
      reset: false,
      unknownFrames: 0,
      cursor: { start: null, end: null },
    }
  }

  /** Read the visible ANSI screen for a pane via `pane.read` or its registered external provider. */
  async screen(paneId) {
    if (typeof paneId !== 'string' || paneId === '' || paneId.length > MAX_ID_CHARS) {
      throw new FleetError('invalid-request', 'pane is required.')
    }
    const external = this.#resolveExternalPane(paneId)
    if (external) {
      if (typeof external.provider.screen !== 'function') {
        throw new FleetError('herdr-offline', 'Live screen is not available for this provider.')
      }
      const result = await external.provider.screen(external.rawId, { policy: this.#store.policy })
      return isObject(result) ? { ...result, paneId } : result
    }
    if (this.#state.health?.connected !== true || this.#state.stale === true) {
      throw new FleetError('herdr-offline', 'herdr is not reachable.')
    }
    let result
    try {
      result = await this.#client.request('pane.read', {
        pane_id: paneId,
        source: 'visible',
        format: 'ansi',
      })
    } catch (error) {
      throw mapHerdrError(error, { write: false })
    }
    const read = result?.read
    const revision = read?.revision
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new FleetError('herdr-error', 'herdr returned a screen without a usable revision.', { code: 'bad_reply' })
    }
    return {
      ok: true,
      paneId,
      revision,
      format: 'ansi',
      text: typeof read?.text === 'string' ? read.text : '',
      cols: Number.isInteger(read?.cols) && read.cols >= 1 ? read.cols : null,
      rows: Number.isInteger(read?.rows) && read.rows >= 1 ? read.rows : null,
      at: this.#clock(),
    }
  }

  /** Execute a validated write verb via `createActions` or a registered external provider. */
  async act(request) {
    const paneId = isObject(request) && typeof request.pane === 'string' ? request.pane : null
    const external = paneId ? this.#resolveExternalPane(paneId) : null
    if (external) {
      const valid = validateRequest(request)
      const policy = this.#store.policy
      if (policy === 'read-only') {
        throw new FleetError('policy-denied', 'The write policy (read-only) does not allow this.', { policy: 'read-only' })
      }
      if (policy === 'dsh-only' && !this.#store.dshPanes.has(paneId)) {
        throw new FleetError('policy-denied', 'The write policy (dsh-only) does not allow writing to this pane.', { policy: 'dsh-only' })
      }
      if (typeof external.provider.act !== 'function') {
        throw new FleetError('policy-denied', 'This provider does not support write actions.', { policy: 'read-only' })
      }
      const forwarded = external.rawId === paneId ? valid : { ...valid, pane: external.rawId }
      const response = await external.provider.act(forwarded, { policy })
      if (!this.#stopped) this.#recompute()
      return isObject(response) ? { ...response, pane: paneId } : response
    }
    const response = await this.#actions.act(request)
    if (!this.#stopped) this.#recompute()
    return response
  }

  /** Update the host write policy, sync external providers if supported, and broadcast state changes. */
  setPolicy(policy) {
    if (typeof policy !== 'string' || !POLICIES.includes(policy)) {
      throw new FleetError('invalid-request', `Invalid write policy. Expected one of: ${POLICIES.join(', ')}.`)
    }
    this.#store.setPolicy(policy)
    if (this.#registry && typeof this.#registry.providers === 'function') {
      for (const provider of this.#registry.providers()) {
        if (typeof provider?.setPolicy === 'function') {
          provider.setPolicy(policy)
        } else if (isObject(provider) && '_policy' in provider && typeof provider._policy !== 'function') {
          provider._policy = policy
        }
      }
    }
    if (!this.#stopped) this.#recompute()
    return { ok: true, policy: { write: policy } }
  }

  /* ---------------------------------------------------------------------------------------------- internals */

  #clock() {
    const value = Number(this.#now())
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
  }

  #attach() {
    if (this.#attached) return
    this.#attached = true
    this.#state.on?.('change', this.#onStateChange)
    this.#state.on?.('status', this.#onStateStatus)
    if (this.#registry && typeof this.#registry.onChange === 'function') {
      this.#unsubRegistry = this.#registry.onChange(() => {
        if (this.#stopped) return
        this.#recompute()
      })
    }
  }

  #detach() {
    if (!this.#attached) return
    this.#attached = false
    this.#state.off?.('change', this.#onStateChange)
    this.#state.off?.('status', this.#onStateStatus)
    if (typeof this.#unsubRegistry === 'function') {
      try { this.#unsubRegistry() } catch { /* ignore */ }
    }
    this.#unsubRegistry = null
  }

  #resolveExternalPane(paneId) {
    if (!this.#registry || typeof paneId !== 'string' || paneId === '') return null
    const resolver = typeof this.#registry.resolve === 'function'
      ? this.#registry.resolve.bind(this.#registry)
      : typeof this.#registry.resolvePane === 'function'
        ? this.#registry.resolvePane.bind(this.#registry)
        : null
    if (!resolver) return null
    const target = resolver(paneId)
    if (!target || target.provider?.kind === 'herdr') return null
    return target
  }

  #findPane(paneId) {
    return this.#state.snapshot?.panes?.find((candidate) => candidate.id === paneId)
  }

  #summaryMap() {
    const out = {}
    for (const [paneId, cached] of this.#summaries) out[paneId] = cached.entry
    return out
  }

  #buildState(revision) {
    const base = buildState({
      snapshot: this.#state.snapshot,
      health: this.#state.health,
      stale: this.#state.stale,
      policy: { write: this.#store.policy, dshPanes: this.#store.dshPanes },
      now: this.#clock(),
      summaries: this.#summaryMap(),
      revision,
      gates: this.#gates,
    })
    if (!this.#registry || typeof this.#registry.listPanes !== 'function') return base

    const writePolicy = base.policy.write
    const dshPanes = this.#store.dshPanes
    const rawExternal = this.#registry.listPanes({ now: base.now, policy: writePolicy })
    const externalList = Array.isArray(rawExternal) ? rawExternal : []
    if (externalList.length === 0) return base

    const mergedPanes = []
    const seenIds = new Set()
    let hasFocused = false
    for (const pane of base.panes) {
      seenIds.add(pane.id)
      if (pane.focused) hasFocused = true
      mergedPanes.push(pane)
    }

    for (const pane of externalList) {
      if (!isObject(pane) || typeof pane.id !== 'string' || pane.id === '') continue
      if (seenIds.has(pane.id)) continue
      seenIds.add(pane.id)
      let next = pane
      if (hasFocused && next.focused === true) {
        next = { ...next, focused: false }
      } else if (next.focused === true) {
        hasFocused = true
      }
      if (next.writable !== false) {
        const decision = writability(
          { id: next.id, isAgent: next.agent !== null },
          { policy: writePolicy, dshPanes, connected: true, stale: false },
        )
        if (decision.writable !== next.writable || decision.reason !== next.writableReason) {
          next = { ...next, writable: decision.writable, writableReason: decision.reason }
        }
      }
      mergedPanes.push(next)
    }

    const counts = { blocked: 0, done: 0, working: 0, idle: 0, unknown: 0, agents: 0, shells: 0, panes: mergedPanes.length }
    const byWorkspace = new Map()
    for (const pane of mergedPanes) {
      if (pane.agent === null) counts.shells += 1
      else { counts.agents += 1; counts[pane.status] += 1 }
      const entry = byWorkspace.get(pane.workspaceId) ?? {
        id: pane.workspaceId,
        label: pane.workspaceLabel,
        focused: false,
        tabs: new Set(),
        paneCount: 0,
      }
      entry.focused ||= pane.focused
      entry.tabs.add(pane.tabId)
      entry.paneCount += 1
      byWorkspace.set(pane.workspaceId, entry)
    }
    const workspaceOrder = new Set([...base.workspaces.map((workspace) => workspace.id), ...byWorkspace.keys()])
    const workspaces = [...workspaceOrder].filter((id) => byWorkspace.has(id)).map((id) => {
      const { tabs, ...rest } = byWorkspace.get(id)
      return { ...rest, tabCount: tabs.size }
    })

    return { ...base, workspaces, panes: mergedPanes, counts }
  }

  #recompute() {
    const candidate = this.#buildState(this.#revision)
    const signature = stateSignature(candidate)
    if (signature === this.#stateSignature) {
      this.#cachedState = candidate
      return false
    }
    this.#revision += 1
    this.#stateSignature = signature
    this.#cachedState = { ...candidate, revision: this.#revision }
    this.#notify()
    return true
  }

  #notify() {
    if (this.#stopped || this.#listeners.size === 0) return
    this.#notifying = true
    try {
      for (const listener of [...this.#listeners]) {
        try {
          listener()
        } catch { /* a failing listener must not break other subscribers or the service */ }
      }
    } finally {
      this.#notifying = false
    }
  }

  #seedStatuses(snapshot) {
    for (const pane of snapshot?.panes ?? []) {
      if (pane?.id) this.#prevStatuses.set(pane.id, pane.agent ? pane.agentStatus : null)
    }
  }

  #handleSnapshotUpdate() {
    const panes = this.#state.snapshot?.panes ?? []
    const liveIds = new Set()

    for (const pane of panes) {
      if (!pane?.id) continue
      liveIds.add(pane.id)
      const isAgent = typeof pane.agent === 'string' && pane.agent !== ''
      const prevStatus = this.#prevStatuses.get(pane.id)
      const nextStatus = isAgent ? pane.agentStatus : null

      if (isAgent && prevStatus === 'working' && nextStatus === 'done') {
        void this.#triggerGate(pane)
      } else if (isAgent && nextStatus === 'working' && this.#gates.get(pane.id)?.gate === 'running') {
        // Agent resumed working while a gate was running: invalidate that in-flight run.
        this.#gateTokens.set(pane.id, (this.#gateTokens.get(pane.id) ?? 0) + 1)
      }

      this.#prevStatuses.set(pane.id, nextStatus)
      this.#scheduleSummary(pane)
    }

    // Prune state for vanished panes.
    for (const id of [...this.#prevStatuses.keys()]) {
      if (!liveIds.has(id)) {
        this.#prevStatuses.delete(id)
        this.#summaries.delete(id)
        this.#summaryQueue.delete(id)
        this.#summaryInflight.delete(id)
        this.#gates.delete(id)
        if (this.#gateTokens.has(id)) this.#gateTokens.set(id, this.#gateTokens.get(id) + 1)
      }
    }

    this.#recompute()
  }

  /* ---------------------------------------------------------------------------------------------- summaries */

  #scheduleSummary(pane) {
    const isAgent = typeof pane.agent === 'string' && pane.agent !== ''
    const status = isAgent ? pane.agentStatus : 'unknown'
    if (!isAgent || (status !== 'done' && status !== 'working' && status !== 'blocked')) {
      this.#summaryQueue.delete(pane.id)
      this.#summaries.delete(pane.id)
      return
    }
    const key = `${pane.revision}:${status}`
    const cached = this.#summaries.get(pane.id)
    if (cached && cached.revision === pane.revision && cached.status === status) return
    if (this.#summaryInflight.get(pane.id) === key) return
    this.#summaryQueue.set(pane.id, { pane, status, key })
    this.#drainSummaryQueue()
  }

  #drainSummaryQueue() {
    while (!this.#stopped && this.#summaryActive < this.#summaryConcurrency && this.#summaryQueue.size > 0) {
      const next = this.#summaryQueue.entries().next()
      if (next.done) break
      const [paneId, job] = next.value
      this.#summaryQueue.delete(paneId)
      this.#summaryActive += 1
      this.#summaryInflight.set(paneId, job.key)
      void this.#runSummaryJob(job).finally(() => {
        if (this.#summaryInflight.get(paneId) === job.key) this.#summaryInflight.delete(paneId)
        this.#summaryActive -= 1
        this.#drainSummaryQueue()
      })
    }
  }

  async #runSummaryJob({ pane, status }) {
    let entry = { text: '', source: 'none' }
    try {
      if (status === 'blocked') {
        if (this.#state.health?.connected === true && this.#state.stale !== true) {
          const result = await this.#client.request(
            'pane.read',
            { pane_id: pane.id, source: 'visible', format: 'text' },
            { timeoutMs: SUMMARY_SCREEN_TIMEOUT_MS },
          )
          const screenText = typeof result?.read?.text === 'string' ? result.read.text : ''
          entry = deriveSummary({ status: 'blocked', screenText })
        }
      } else {
        const options = {
          kind: pane.agent,
          session: pane.agentSession ?? null,
          cwd: pane.foregroundCwd || pane.cwd || null,
          limit: SUMMARY_FRAME_LIMIT,
        }
        if (this.#config.home !== undefined) options.home = this.#config.home
        const result = await this.#transcripts.readFrames(options)
        if (result?.status === 'ok') {
          entry = deriveSummary({ status, frames: result.frames })
        }
      }
    } catch {
      entry = { text: '', source: 'none' }
    }
    if (this.#stopped) return
    const current = this.#findPane(pane.id)
    if (!current || current.revision !== pane.revision || current.agentStatus !== status) return
    this.#summaries.set(pane.id, { revision: pane.revision, status, entry })
    this.#recompute()
  }

  /* ---------------------------------------------------------------------------------------------- gate runner */

  async #triggerGate(pane) {
    const cwd = pane.foregroundCwd || pane.cwd
    if (typeof cwd !== 'string' || cwd === '') return

    const token = (this.#gateTokens.get(pane.id) ?? 0) + 1
    this.#gateTokens.set(pane.id, token)

    let gateConfig
    try {
      gateConfig = await this.#gate.readConfig(cwd)
    } catch {
      return
    }
    if (this.#stopped || this.#gateTokens.get(pane.id) !== token) return
    if (!Array.isArray(gateConfig?.steps) || gateConfig.steps.length === 0) return

    this.#gates.set(pane.id, {
      gate: 'running',
      startedAt: this.#clock(),
      durationMs: null,
      baseRevision: null,
      headRevision: null,
      steps: [],
      failure: null,
    })
    this.#recompute()

    let checks
    try {
      checks = await this.#gate.run({
        cwd,
        config: gateConfig,
        spawn: this.#gate.spawn,
        readHead: this.#gate.readHead,
        now: () => this.#clock(),
      })
    } catch {
      checks = {
        gate: 'failed',
        startedAt: this.#clock(),
        durationMs: 0,
        baseRevision: null,
        headRevision: null,
        steps: [],
        failure: { step: '', reason: 'gate runner error', excerpt: '' },
      }
    }
    if (this.#stopped || this.#gateTokens.get(pane.id) !== token) return
    if (!this.#findPane(pane.id)) return
    this.#gates.set(pane.id, checks)
    this.#recompute()
  }
}

/**
 * Factory wrapper used by `lib/fleet/host.js` (accepts `herdr` as an alias for `state`, plus flat gate/home options).
 */
export function createFleetService(options = {}) {
  const {
    herdr,
    state = herdr,
    home,
    spawn,
    readHead,
    readGateConfig: readConfig,
    config = {},
    ...rest
  } = options
  const mergedConfig = {
    ...config,
    ...(home === undefined ? {} : { home }),
    gate: {
      ...(isObject(config?.gate) ? config.gate : {}),
      ...(typeof readConfig === 'function' ? { readConfig } : {}),
      ...(typeof spawn === 'function' ? { spawn } : {}),
      ...(typeof readHead === 'function' ? { readHead } : {}),
    },
  }
  const service = new FleetService({ ...rest, state, config: mergedConfig })
  if (typeof readConfig === 'function') service.__readGateConfigForTests = readConfig
  return service
}
