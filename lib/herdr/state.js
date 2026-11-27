/**
 * The host's cache of herdr's world.
 *
 * `session.snapshot` is the only source of truth. Events are invalidation hints: herdr offers no sequence number that
 * ties an event to a snapshot, so a refresh replaces the cache wholesale and nothing tries to merge deltas. On top of the
 * raw snapshot this adds the two facts herdr does not report, when a pane's state began (`stateSince`) and when its
 * output last moved (`outputAt`), by watching consecutive snapshots.
 *
 * Adapted from herdr-orchestrator/lib/state.js (code reuse only: this plugin has no runtime dependency on it). What
 * differs, and why:
 *  - a pane seen for the first time is stamped with the moment it was first seen. The orchestrator back-dated `outputAt`
 *    by a second, which invents an output time nobody observed;
 *  - an unreachable herdr is a state, not an exception: `health` / `stale` report it in the contract's `Health` shape and
 *    the last known snapshot stays available;
 *  - `revision` moves only when something a viewer can see moved (`snapshotSignature`), never for the passage of time;
 *  - a throwing listener cannot break a refresh, and `stop()` really stops everything, including an answer still on its
 *    way back from herdr.
 *
 * Events:
 *  - 'change' (snapshot, previous): the visible content moved. The first successful snapshot always counts (`previous`
 *    is the empty snapshot), so a consumer never has to special-case "nothing yet".
 *  - 'status' ({ status, error? }): the connection narrative, published on transitions only.
 *      'live'          herdr answers and the event stream is up
 *      'reconnecting'  herdr answers (or did) but the event stream is not up: it was lost, or is not re-established yet.
 *                      Snapshots keep coming from the safety poll. Never the very first status after start().
 *      'down'          the last refresh failed; `error` is the same sentence as `health.error`
 *    A consumer that rebuilds its view from `snapshot` + `health` on both 'change' and 'status' never misses a
 *    transition: recovering to an identical world fires 'status' but not 'change'.
 *  - 'listener-error' (error, event): a listener threw. Reported here, not as 'error', because an 'error' event nobody
 *    listens to throws.
 */
import { EventEmitter } from 'node:events'
import { HerdrError, isOfflineError } from './protocol.js'
import { EMPTY_SNAPSHOT, normalizeSnapshot, snapshotSignature } from './normalize.js'

/**
 * Broadcast subscriptions only: kinds that need no pane id. herdr validates every entry up front, so a pane-scoped kind
 * (`pane.output_matched`, `pane.agent_status_changed`, `pane.scroll_changed`) would get the WHOLE subscription rejected
 * as soon as that one pane closes. `worktree.*` is left out: the Fleet does not model worktrees. The 3 s safety poll is
 * the backstop for anything these do not announce.
 */
export const SUBSCRIPTIONS = Object.freeze([
  'workspace.created',
  'workspace.updated',
  'workspace.closed',
  'workspace.renamed',
  'workspace.focused',
  'workspace.moved',
  'workspace.reordered',
  'workspace.metadata_updated',
  'tab.created',
  'tab.closed',
  'tab.renamed',
  'tab.moved',
  'tab.focused',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.exited',
  'pane.focused',
  'pane.moved',
  'pane.agent_detected',
  'layout.updated',
].map((type) => Object.freeze({ type })))

/** setTimeout/setInterval treat anything above this as 1 ms, which would turn a typo into a busy loop. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** `health.error` is a sentence for a banner, not a dump: cap what a peer's message can contribute. */
const FAILURE_LIMIT = 200
/** What `health.error` says before herdr has been asked anything: the contract wants a reason for every `connected: false`. */
const NOT_CONTACTED = 'herdr has not answered yet'

const noop = () => {}

/** A timer length from configuration: a finite number of at least `min`, capped at what timers accept, else the fallback. */
function duration(value, fallback, min = 1) {
  return Number.isFinite(value) && value >= min ? Math.min(value, MAX_TIMER_MS) : fallback
}

const stoppedError = () => new HerdrError('herdr state is stopped', { method: 'session.snapshot', code: 'state_stopped' })

/** A well-formed answer wraps the snapshot; a bare snapshot is accepted too. Anything else must not read as "no panes". */
function isSnapshotResult(result) {
  if (result === null || typeof result !== 'object') return false
  const { snapshot } = result
  if (snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)) return true
  return Array.isArray(result.panes)
}

/** One short human sentence: never a stack, never more than the first line of what the peer said. */
function describeFailure(error, socket) {
  if (isOfflineError(error)) return socket ? `herdr is not reachable at ${socket}` : 'herdr is not reachable'
  const text = typeof error?.message === 'string' ? error.message : String(error ?? '')
  const line = text.split('\n')[0].trim()
  if (line === '') return 'herdr request failed'
  const points = Array.from(line)
  return points.length > FAILURE_LIMIT ? `${points.slice(0, FAILURE_LIMIT - 1).join('')}…` : line
}

export class HerdrState extends EventEmitter {
  #client
  #pollIntervalMs
  #coalesceMs
  #now
  #session
  #backoff
  #nextDelayMs

  // What the world looked like at the last successful read.
  #snapshot = EMPTY_SNAPSHOT
  // null until the first success, so that first snapshot counts as a change even when it is as empty as EMPTY_SNAPSHOT.
  #signature = null
  #revision = 0
  #tracking = new Map() // paneId -> { status, revision, stateSince, outputAt }

  // Connection facts behind `health`.
  #connected = false
  #lastOkAt = null
  #failure = null // sentence for the most recent failed read; null after a success
  #published = null // the last 'status' payload, so only transitions are announced

  // Lifecycle. Work started before a stop() belongs to an older epoch and must not touch the state any more.
  #stopped = false
  #epoch = 0
  #starting = null
  #pollTimer = null
  #coalesceTimer = null
  #inflight = null
  #followUp = null
  #abort = null
  #subHandle = null
  #subscribing = null
  #attempt = null
  #supervised = null
  #wake = null

  /**
   * @param {{ socketPath?: string, request: Function, subscribe: Function, setSubscription?: Function }} client a HerdrClient
   * @param {{ pollIntervalMs?: number, coalesceMs?: number, now?: () => number, session?: string | null, reconnect?: { initialMs?: number, maxMs?: number } }} [options]
   *   `now` is the clock for every time this class stamps (pane time fields, `lastOkAt`, `updatedAt`); timers stay real.
   *   `session` is only reported in `health.session`. `reconnect` bounds the wait between attempts to get the event
   *   stream back: it starts at `initialMs`, doubles up to `maxMs`, and starts over after a success.
   */
  constructor(client, { pollIntervalMs = 3000, coalesceMs = 120, now = Date.now, session = null, reconnect = { initialMs: 500, maxMs: 8000 } } = {}) {
    super()
    this.setMaxListeners(0) // one listener per SSE page or consumer is normal here
    this.#client = client
    this.#pollIntervalMs = duration(pollIntervalMs, 3000)
    this.#coalesceMs = duration(coalesceMs, 120, 0)
    this.#now = typeof now === 'function' ? now : Date.now
    this.#session = typeof session === 'string' && session.length > 0 ? session : null
    const initialMs = duration(reconnect?.initialMs, 500)
    this.#backoff = { initialMs, maxMs: Math.max(initialMs, duration(reconnect?.maxMs, 8000)) }
    this.#nextDelayMs = initialMs
  }

  /** Before the first successful read this is EMPTY_SNAPSHOT itself. */
  get snapshot() { return this.#snapshot }

  /** Counts visible changes since construction; time alone never moves it. Comparable within this process only. */
  get revision() { return this.#revision }

  /** The contract's `Health`. `connected` means the most recent read succeeded; `version`/`protocol` are the last seen. */
  get health() {
    const socket = this.#client.socketPath
    return {
      connected: this.#connected,
      socket: typeof socket === 'string' ? socket : null,
      version: this.#snapshot.version,
      protocol: this.#snapshot.protocol,
      lastOkAt: this.#lastOkAt,
      error: this.#connected ? null : (this.#failure ?? NOT_CONTACTED),
      session: this.#session,
    }
  }

  /**
   * There is old data to show, and the latest read failed. A state that never connected is not stale: it has nothing
   * old to be stale about (docs/design/FLEET-API.md §2).
   */
  get stale() { return this.#signature !== null && !this.#connected }

  /**
   * Read once, open the event stream and keep a safety poll running. Never rejects because herdr is missing: health says
   * so, the poll keeps trying, and the stream is brought up as soon as herdr answers. Calling it again is a no-op until
   * stop().
   */
  start() {
    if (this.#starting) return this.#starting
    this.#stopped = false
    this.#published = null // a fresh run announces where it stands, even if it ends up where the last one stopped
    const epoch = this.#epoch
    // Events are hints and can be lost, so a slow poll runs underneath them for as long as the state runs.
    this.#pollTimer = setInterval(() => { this.refresh().catch(noop) }, this.#pollIntervalMs)
    this.#pollTimer.unref?.()
    this.#starting = this.#boot(epoch)
    return this.#starting
  }

  async #boot(epoch) {
    await this.refresh().catch(noop) // a failure is already recorded in health
    if (!this.#alive(epoch)) return this
    if (!(await this.ensureSubscribed())) this.#reconnect(epoch).catch(noop)
    return this
  }

  /**
   * Stop everything: timers, the event stream, the read on the wire. Afterwards nothing fires and nothing more reaches
   * herdr; a refresh() still waiting for its answer rejects, and an answer that arrives late is dropped.
   */
  stop() {
    this.#stopped = true
    this.#epoch += 1
    this.#starting = null
    clearInterval(this.#pollTimer)
    clearTimeout(this.#coalesceTimer)
    this.#pollTimer = null
    this.#coalesceTimer = null
    this.#wake?.()
    this.#supervised = null
    this.#abort?.abort()
    this.#abort = null
    this.#inflight = null
    this.#followUp = null
    this.#attempt?.cancel()
    this.#attempt = null
    this.#subscribing = null
    const handle = this.#subHandle
    this.#subHandle = null
    if (handle) {
      handle.close()
      this.#client.setSubscription?.(null)
    }
  }

  /**
   * Read the session now and replace the cache. At most one read is on the wire: concurrent callers share it. A failure
   * rejects with the HerdrError (callers decide); the poll and event-driven refreshes swallow it, and `health` records it
   * either way.
   *
   * `force` means "a read that starts after this call". The read already on the wire may have been taken before whatever
   * made the caller ask (a write it just made), so a forced call waits for that one and reads once more; every forced
   * caller in that window shares the single follow-up.
   *
   * @returns {Promise<object>} the snapshot this read produced
   */
  refresh({ force = false } = {}) {
    if (this.#stopped) return Promise.reject(stoppedError())
    if (!this.#inflight) return this.#launch()
    if (!force) return this.#inflight
    if (!this.#followUp) {
      const epoch = this.#epoch
      const followUp = this.#inflight.then(noop, noop).then(() => {
        if (this.#followUp === followUp) this.#followUp = null
        if (!this.#alive(epoch)) throw stoppedError()
        // Someone may have started a read in the gap; it started after the forced call too, so it serves.
        return this.#inflight ?? this.#launch()
      })
      this.#followUp = followUp
    }
    return this.#followUp
  }

  /**
   * Ask for a refresh soon. A burst of events costs one read: the first event arms a timer, the rest ride on it. The read
   * is forced: an event that arrives while a read is on the wire may describe something that read was taken too early
   * to see, so it must not be folded into it.
   */
  scheduleRefresh() {
    if (this.#stopped || this.#coalesceTimer) return
    this.#coalesceTimer = setTimeout(() => {
      this.#coalesceTimer = null
      this.refresh({ force: true }).catch(noop)
    }, this.#coalesceMs)
    this.#coalesceTimer.unref?.()
  }

  /**
   * Open the event stream if it is not open. Failures are non-fatal (the poll still works) and concurrent callers share
   * one attempt, so two of them can never open two streams.
   *
   * @returns {Promise<boolean>} whether the stream is up when this settles
   */
  ensureSubscribed() {
    if (this.#stopped) return Promise.resolve(false)
    if (this.#subHandle) return Promise.resolve(true)
    if (!this.#subscribing) {
      const subscribing = this.#subscribe(this.#epoch).finally(() => {
        if (this.#subscribing === subscribing) this.#subscribing = null
      })
      this.#subscribing = subscribing
    }
    return this.#subscribing
  }

  #alive(epoch) { return !this.#stopped && this.#epoch === epoch }

  #clock() {
    const value = Number(this.#now())
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
  }

  #launch() {
    const epoch = this.#epoch
    const controller = new AbortController()
    this.#abort = controller
    const inflight = this.#read(epoch, controller.signal).finally(() => {
      if (this.#inflight !== inflight) return // stop() already let go of this one
      this.#inflight = null
      this.#abort = null
    })
    this.#inflight = inflight
    return inflight
  }

  async #read(epoch, signal) {
    let result
    try {
      result = await this.#client.request('session.snapshot', {}, { signal })
      if (!isSnapshotResult(result)) {
        throw new HerdrError('herdr returned an unexpected answer to session.snapshot', { method: 'session.snapshot', code: 'malformed' })
      }
    } catch (error) {
      if (!this.#alive(epoch)) throw error // cancelled by stop(): not a herdr failure, nothing to record
      this.#failed(error)
      throw error
    }
    if (!this.#alive(epoch)) throw stoppedError() // the answer outlived the state: drop it
    return this.#accept(result)
  }

  #failed(error) {
    this.#connected = false
    this.#failure = describeFailure(error, this.#client.socketPath)
    this.#publishStatus()
  }

  #accept(result) {
    const now = this.#clock()
    const next = this.#track(normalizeSnapshot(result), now)
    const signature = snapshotSignature(next)
    const changed = signature !== this.#signature
    const previous = this.#snapshot
    if (changed) this.#revision += 1
    this.#signature = signature
    // Always adopt the fresh read, changed or not: fields the signature ignores (an agent session's `value`, version)
    // stay current without costing a revision.
    const snapshot = { ...next, updatedAt: now, revision: this.#revision }
    this.#snapshot = snapshot
    this.#connected = true
    this.#failure = null
    this.#lastOkAt = now
    // Listeners run last, against a fully updated state.
    if (changed) this.#emit('change', snapshot, previous)
    this.#publishStatus()
    return snapshot
  }

  /**
   * Attach the time dimension by comparing each pane with the previous read. A pane keeps `stateSince` until its agent
   * status changes and `outputAt` until its revision changes. A pane new to us is stamped with the moment we first saw
   * it, and one that vanishes is forgotten, so it is "new" again if it returns.
   */
  #track(snapshot, now) {
    const seen = new Set()
    const panes = snapshot.panes.map((pane) => {
      seen.add(pane.id)
      const known = this.#tracking.get(pane.id)
      const entry = {
        status: pane.agentStatus,
        revision: pane.revision,
        stateSince: known && known.status === pane.agentStatus ? known.stateSince : now,
        outputAt: known && known.revision === pane.revision ? known.outputAt : now,
      }
      this.#tracking.set(pane.id, entry)
      return { ...pane, stateSince: entry.stateSince, outputAt: entry.outputAt }
    })
    for (const id of this.#tracking.keys()) {
      if (!seen.has(id)) this.#tracking.delete(id)
    }
    return { ...snapshot, panes }
  }

  async #subscribe(epoch) {
    let handle = null
    let lost = false
    let release = noop
    const cancelled = new Promise((resolve) => { release = resolve })
    const attempt = {
      cancel: () => {
        handle?.close()
        release()
      },
    }
    this.#attempt = attempt
    try {
      handle = this.#client.subscribe(SUBSCRIPTIONS, {
        onEvent: () => this.scheduleRefresh(),
        onLost: () => {
          lost = true // lost before we adopted it: the check below sees it
          this.#lost(handle)
        },
      })
      // A handle closed from our side never settles `ready`, so cancel() must be able to end the wait.
      await Promise.race([handle.ready, cancelled])
    } catch {
      handle?.close()
      return false
    } finally {
      if (this.#attempt === attempt) this.#attempt = null
    }
    if (!this.#alive(epoch) || lost) {
      handle.close()
      return false
    }
    this.#subHandle = handle
    this.#client.setSubscription?.(handle)
    this.#publishStatus()
    return true
  }

  #lost(handle) {
    if (this.#stopped || this.#subHandle !== handle) return
    this.#subHandle = null
    this.#client.setSubscription?.(null)
    this.#publishStatus()
    this.#reconnect(this.#epoch).catch(noop)
  }

  /**
   * Get the event stream back. Each round waits, reads an authoritative snapshot, then re-subscribes: the window the
   * lost stream missed is unknown, so the read comes first and the stream only has to cover what happens next. A failed
   * round doubles the wait (up to the cap); success resets it. One loop per epoch.
   */
  async #reconnect(epoch) {
    if (!this.#alive(epoch) || this.#supervised === epoch) return
    this.#supervised = epoch
    try {
      while (this.#alive(epoch)) {
        const delay = this.#nextDelayMs
        this.#nextDelayMs = Math.min(delay * 2, this.#backoff.maxMs)
        await this.#sleep(delay)
        if (!this.#alive(epoch)) return
        try {
          await this.refresh({ force: true })
        } catch {
          continue // health already says why; wait longer and try again
        }
        if (await this.ensureSubscribed()) {
          this.#nextDelayMs = this.#backoff.initialMs
          return
        }
      }
    } finally {
      if (this.#supervised === epoch) this.#supervised = null
    }
  }

  /** A sleep that stop() can cut short, so a stopped state does not linger behind a pending backoff timer. */
  #sleep(ms) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        if (this.#wake === finish) this.#wake = null
        resolve()
      }
      const timer = setTimeout(finish, ms)
      timer.unref?.()
      this.#wake = finish
    })
  }

  #publishStatus() {
    const next = this.#failure !== null
      ? { status: 'down', error: this.#failure }
      : { status: this.#subHandle ? 'live' : 'reconnecting' }
    const last = this.#published
    if (last === null && next.status === 'reconnecting') return // nothing was lost yet: the stream is simply not up yet
    if (last !== null && last.status === next.status && last.error === next.error) return
    this.#published = next
    this.#emit('status', { ...next })
  }

  /**
   * Run every listener inside its own try/catch: a throwing listener must not make a refresh reject (the cache is
   * already updated by now) nor keep the listeners behind it from running. Rejected promises count as throws.
   */
  #emit(event, ...args) {
    if (this.#stopped) return
    for (const listener of this.rawListeners(event)) { // raw: a once() wrapper must unregister itself when called
      try {
        const returned = listener.apply(this, args)
        if (typeof returned?.then === 'function') returned.then(undefined, (error) => this.#listenerFailed(event, error))
      } catch (error) {
        this.#listenerFailed(event, error)
      }
    }
  }

  #listenerFailed(event, error) {
    if (event !== 'listener-error') this.#emit('listener-error', error, event) // a failing reporter cannot report itself
  }
}
