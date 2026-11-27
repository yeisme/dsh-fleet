/**
 * The H5′ glue: turns the parts into the five things lib/http.js asks for
 * (`state()` / `onChange()` / `frames()` / `screen()` / `act()`).
 *
 * This is deliberately thin. Every decision lives in a module that can be tested alone:
 *  - what a State looks like                        -> lib/fleet/model.js   (buildState)
 *  - what a write may do                            -> lib/fleet/actions.js (createActions)
 *  - what a transcript frame looks like             -> lib/transcripts/     (readFrames)
 *  - what the durable settings are                  -> lib/fleet/store.js
 *  - what a gate verdict is                         -> lib/fleet/gate.js
 * The service owns only the wiring plus three bits of state the parts cannot own themselves: the current
 * snapshot, the last gate verdict per pane, and the "something changed" signal the SSE hub subscribes to.
 *
 * Fail-safe rule, same as everywhere else in this plugin: a pane the service cannot explain gets the contract's
 * "don't know" (no frames, empty screen, empty summary), never an invented value and never a thrown error that
 * would take the whole State down for every other pane.
 */
import { buildState } from './model.js'
import { createActions } from './actions.js'
import { readFrames, supportsKind } from '../transcripts/index.js'
import { runGate } from './gate.js'

/** How long a `screen` read may take before we give up and report the reason instead. */
const SCREEN_TIMEOUT_MS = 5000
/** Pane.read lines for the fleet screen view: enough to see an approval prompt, not a whole scrollback. */
const SCREEN_LINES = 40

/**
 * @param {object} deps
 * @param {object} deps.client HerdrClient (`request(method, params, opts)`)
 * @param {object} deps.herdr HerdrState: `.snapshot`, `.health`, `.stale`, `.revision`, EventEmitter `'change'`
 * @param {object} deps.store FleetStore
 * @param {object} [deps.summaries] whatever model.js' `summaries` expects (optional; '' when absent)
 * @param {Function} [deps.now]
 * @param {Function} [deps.spawn] gate runner process starter (injected so tests need no real processes)
 * @param {Function} [deps.readGateConfig] (cwd) => Promise<gate config>
 * @param {Function} [deps.readHead] (cwd) => Promise<string|null>
 * @param {Function} [deps.home]
 * @returns {{ state: Function, onChange: Function, frames: Function, screen: Function, act: Function, gate: Function, stop: Function }}
 */
export function createFleetService({
  client,
  herdr,
  store,
  summaries,
  now = Date.now,
  spawn,
  readGateConfig,
  readHead,
  home,
} = {}) {
  if (client === undefined || client === null) throw new TypeError('createFleetService: `client` is required')
  if (herdr === undefined || herdr === null) throw new TypeError('createFleetService: `herdr` is required')
  if (store === undefined || store === null) throw new TypeError('createFleetService: `store` is required')

  /** Last gate verdict per pane: what lib/fleet/model.js renders as Pane.checks. */
  const gates = new Map()
  /** Panes with a gate in flight, so two clicks cannot run the same gate twice. */
  const running = new Set()
  const listeners = new Set()

  // actions.js names the herdr state object `state`; here that role is played by the HerdrState instance.
  const actions = createActions({ client, state: herdr, store, now })

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A broken listener must not stop the others: the SSE hub is one subscriber among potentially several.
      }
    }
  }

  // herdr's own "visible content changed" signal is what the browser needs; forwarding it is the whole job here.
  const onHerdrChange = () => notify()
  herdr.on?.('change', onHerdrChange)

  /** The pane the browser is talking about, or undefined. Accepts the id only: nothing else is addressable. */
  function findPane(paneId) {
    const panes = herdr.snapshot?.panes
    if (!Array.isArray(panes)) return undefined
    return panes.find((pane) => pane?.id === paneId)
  }

  function state() {
    return buildState({
      snapshot: herdr.snapshot,
      health: herdr.health,
      stale: herdr.stale,
      policy: { write: store.policy, dshPanes: store.dshPanes },
      now: now(),
      summaries,
      revision: herdr.revision,
      gates,
    })
  }

  function onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('onChange: `listener` must be a function')
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /**
   * Frames for one pane's transcript, in the contract's `FramesResponse` shape.
   *
   * Every way of having nothing to show is an ANSWER here, not an error: the fleet page asks this about whichever
   * pane is selected, and "a shell has no transcript" must render as an empty panel, not a failed request.
   * `reason` is the contract enum, so readFrames' own `unsupported-agent` / `no-transcript` / `not-yet` /
   * `unreadable` pass through unchanged and a shell maps onto `unsupported-agent` (its kind is not a transcript kind).
   *
   * An unknown pane is the one case the http layer must turn into 404, so it throws rather than pretending.
   */
  async function frames(paneId, query = {}) {
    const pane = findPane(paneId)
    if (pane === undefined) throw new Error('unknown-pane')

    const session = pane.agentSession ?? null
    const base = {
      ok: true,
      paneId,
      source: 'transcript',
      reason: null,
      agentKind: session === null ? null : String(session.agent ?? session.kind ?? '') || null,
      sessionId: null,
      frames: [],
      hasEarlier: false,
      partial: false,
      reset: false,
      unknownFrames: 0,
      cursor: { start: null, end: null },
    }

    // A shell, or an agent no transcript adapter understands: nothing to read, and saying why is the whole answer.
    // The adapter is chosen by the AGENT (pi/claude/codex), not by herdr's session `kind` (path/id): session.kind says
    // where the session is recorded, session.agent says which tool wrote it.
    const adapter = typeof session?.agent === 'string' ? session.agent.toLowerCase() : ''
    if (session === null || !supportsKind(adapter)) return { ...base, reason: 'unsupported-agent' }

    const page = await readFrames({
      kind: adapter,
      session,
      cwd: pane.foregroundCwd ?? pane.cwd ?? null,
      home,
      limit: query.limit,
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.after === undefined ? {} : { after: query.after }),
    })

    if (page.status === 'missing') return { ...base, reason: page.reason }
    return {
      ...base,
      sessionId: page.sessionId ?? null,
      frames: page.frames,
      hasEarlier: page.hasEarlier,
      partial: page.partial,
      reset: page.reset,
      unknownFrames: page.unknownFrames,
      cursor: page.cursor ?? { start: null, end: null },
    }
  }

  /**
   * The pane's visible screen, in the contract's `ScreenResponse`.
   *
   * `format` is the contract's `const "ansi"`: the pane view keeps colour, and the client decides how to render it.
   * Never throws for a readable pane: a failed read becomes empty text at revision 0, because the screen is a
   * nice-to-have next to the transcript and must not blank the panel when herdr is busy. An unknown pane throws so
   * the http layer can answer 404 instead of inventing an empty screen for a pane that does not exist.
   */
  async function screen(paneId) {
    const pane = findPane(paneId)
    if (pane === undefined) throw new Error('unknown-pane')
    const empty = {
      ok: true,
      paneId,
      revision: 0,
      format: 'ansi',
      text: '',
      cols: null,
      rows: null,
      at: now(),
    }
    try {
      const result = await client.request(
        'pane.read',
        { pane_id: paneId, source: 'visible', format: 'ansi', lines: SCREEN_LINES },
        { timeoutMs: SCREEN_TIMEOUT_MS },
      )
      const read = result?.read ?? {}
      return {
        ...empty,
        revision: Number.isInteger(read.revision) && read.revision >= 0 ? read.revision : Number.isInteger(pane.revision) && pane.revision >= 0 ? pane.revision : 0,
        text: typeof read.text === 'string' ? read.text : '',
        cols: Number.isInteger(read.cols) && read.cols >= 1 ? read.cols : null,
        rows: Number.isInteger(read.rows) && read.rows >= 1 ? read.rows : null,
      }
    } catch {
      return empty
    }
  }

  async function act(body) {
    const response = await actions.act(body)
    return response
  }

  /**
   * Run the gate for one pane and remember the verdict.
   *
   * Guards worth naming:
   *  - an unknown pane or a pane without a cwd stops here (there is nothing to verify);
   *  - one gate per pane at a time, so a double click cannot run two builds in one directory;
   *  - the async work is NOT awaited by the caller that merely depends on `gates`, so the SSE push that follows
   *    `notify()` carries `gate: 'running'` and the page can show it honestly while the steps execute.
   */
  async function gate(paneId) {
    const pane = findPane(paneId)
    if (pane === undefined) throw new Error('unknown-pane')
    const cwd = pane.foregroundCwd ?? pane.cwd ?? ''
    if (cwd === '') throw new Error('no-cwd')
    if (running.has(paneId)) throw new Error('gate-running')

    const config = typeof readGateConfig === 'function' ? await readGateConfig(cwd) : { steps: [] }
    if (!Array.isArray(config?.steps) || config.steps.length === 0) {
      gates.set(paneId, {
        gate: 'none', startedAt: null, durationMs: null, baseRevision: null, headRevision: null, steps: [], failure: null,
      })
      notify()
      return gates.get(paneId)
    }

    running.add(paneId)
    gates.set(paneId, {
      gate: 'running', startedAt: now(), durationMs: null, baseRevision: null, headRevision: null, steps: [], failure: null,
    })
    notify()

    try {
      const checks = await runGate({ cwd, config, spawn, now, readHead })
      gates.set(paneId, checks)
      return checks
    } finally {
      running.delete(paneId)
      notify()
    }
  }

  function stop() {
    listeners.clear()
    herdr.off?.('change', onHerdrChange)
  }

  return { state, onChange, frames, screen, act, gate, stop }
}
