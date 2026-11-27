/**
 * The write path of the Fleet API (docs/design/FLEET-HOST.md §4, docs/design/FLEET-API.md §6): the only code that
 * types into, restarts, renames or closes somebody else's terminal. Everything here is organised around four rules.
 *
 *  1. Refuse before writing. Shape, state, policy and a stale screen are all decided before the first byte reaches
 *     herdr. The tests assert it on the fake herdr: after a refusal `writeRequests()` is empty.
 *  2. Never type blind. `answer` and `keys` carry the revision of the screen the user was looking at and are compared
 *     with a pane.get made right before sending (not the cache). A mismatch is `screen-changed`: never retried, and
 *     the fresh revision is never substituted for the client's (FLEET-API.md, "刻意为之的约束").
 *  3. Say what is known. A write that timed out has an UNKNOWN outcome, and a verb that finished only its first half
 *     says which half happened. Nothing is retried except the one documented registration race after a restart.
 *  4. Never echo what was typed. Logs carry `verb`, `pane`, the result and the duration. Messages and `detail` carry
 *     fixed text, enum values and herdr's short error codes: not `text`, `thenPrompt`, `keys`, and not herdr's own
 *     message either (herdr may quote what it was sent).
 *
 * Deliberately NOT carried over from the orchestrator this was adapted from: typing a refused prompt into the terminal
 * with bracketed paste, the hyphen form of the interrupt chord, the force flag on close, releasing the agent before a
 * restart, and its looser key list.
 */
import { loadContract, validateDef } from './schema.js'
import { FleetError } from './errors.js'
import { writability } from './writability.js'
import { HerdrError, isOfflineError } from '../herdr/protocol.js'

const contract = loadContract()

/** The verbs, in the contract's order. Derived, so the contract stays the single source of truth. */
const VERBS = contract.$defs.ActResponse.properties.verb.enum
const KEYS = new Set(contract.$defs.Key.enum)
const AGENT_NAME = new RegExp(contract.$defs.AgentName.pattern, 'u')
const NEEDS_CONFIRM = new Set(['restart', 'close'])

const requestDef = (verb) => `${verb[0].toUpperCase()}${verb.slice(1)}Request`
for (const verb of VERBS) {
  // A verb the contract names but has no request shape for would be accepted by nobody: fail at load, not at 3 a.m.
  if (contract.$defs[requestDef(verb)] === undefined) throw new Error(`the contract has no ${requestDef(verb)}`)
}

/** Pause between typing an answer and pressing Enter, so the TUI has taken the text in (as the orchestrator does). */
const ENTER_DELAY_MS = 150
/** agent.start returns before herdr has registered the agent; a prompt right after it can race that registry. */
const PROMPT_ATTEMPTS = 8
const PROMPT_RETRY_MS = 250
/** The read-back after a write is a courtesy: it must not hold the response hostage if herdr has gone quiet. */
const READ_BACK_TIMEOUT_MS = 2000

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
/**
 * Control characters other than tab, line feed and carriage return. Typed into a terminal they are key presses, not
 * text: ESC starts an escape sequence (including the paste terminator, which would turn the rest of a "pasted" message
 * into live keystrokes), 0x03 is Ctrl+C, 0x9B is an 8-bit CSI. That would be a way around the key whitelist, so such
 * text is refused up front. Not in the contract's schema: a host-side rule, reported as `invalid-request`.
 */
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
/** Text that holds a line break (or a tab) is sent as one bracketed paste: raw, each line break would submit. */
const NEEDS_PASTE = /[\r\n\t]/
const TEXT_FIELDS = { prompt: ['text'], answer: ['text'], restart: ['thenPrompt'] }

const UNKNOWN_PANE = /unknown (?:agent or )?pane/i
const BLOCKED_REFUSAL = /answer the question on screen first/i
/** herdr error codes are short identifiers; anything else is not passed through as one. */
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/
/** Codes of an attempt that failed while connecting: nothing can have reached herdr. */
const NOT_REACHED = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isAgent = (pane) => typeof pane.agent === 'string' && pane.agent !== ''

function safeCode(code) {
  if (typeof code === 'number' && Number.isFinite(code)) return String(code)
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : 'unknown'
}

/** The verb, only if it is one of ours: a log line or a message must not carry whatever a client put in `verb`. */
function knownVerb(request) {
  try {
    return isObject(request) && VERBS.includes(request.verb) ? request.verb : null
  } catch {
    return null
  }
}

/**
 * Names of the fields the validator complained about, restricted to fields this verb really has: an unexpected
 * property is reported as such and not by name, because its name is whatever the client sent.
 */
function failingFields(def, errors) {
  const known = new Set(Object.keys(contract.$defs[def].properties))
  const fields = new Set()
  for (const message of errors) {
    const name = /^\$: missing required property "([^"]+)"/.exec(message)?.[1] ?? /^\$\.([A-Za-z0-9_]+)/.exec(message)?.[1]
    fields.add(known.has(name) ? name : '(unexpected field)')
  }
  return [...fields]
}

/**
 * Step 1 of act(): everything that can be decided from the request alone. Pure: no herdr, no state, no clock.
 * The classification order is FLEET-API.md §6 (test/contract.test.mjs `classify()` is its executable form): the first
 * check that fails decides the reason, so `confirm-required` is reported even when other fields are also wrong, and a
 * bad key is named as such rather than as a generic shape error.
 *
 * @param {unknown} request what the client sent (parsed JSON)
 * @returns {object} a private deep copy that is safe to act on
 * @throws {FleetError} invalid-request | unknown-verb | confirm-required | key-not-allowed
 */
export function validateRequest(request) {
  if (!isObject(request) || typeof request.verb !== 'string') {
    throw new FleetError('invalid-request', 'The request must be a JSON object with a string "verb".')
  }
  const { verb } = request
  if (!VERBS.includes(verb)) throw new FleetError('unknown-verb', `Unknown verb. Supported: ${VERBS.join(', ')}.`)
  // Strictly the boolean true: "true", "yes", 1 and a missing field all mean "nobody confirmed".
  if (NEEDS_CONFIRM.has(verb) && request.confirm !== true) {
    throw new FleetError('confirm-required', `${verb} needs "confirm": true (the boolean true, nothing else counts).`)
  }
  if (verb === 'keys' && Array.isArray(request.keys) && request.keys.some((key) => !KEYS.has(key))) {
    throw new FleetError('key-not-allowed', 'One or more keys are not on the allowed list.')
  }
  const def = requestDef(verb)
  const { errors } = validateDef(contract, def, request)
  if (errors.length > 0) throw new FleetError('invalid-request', `Invalid ${verb} request: check ${failingFields(def, errors).join(', ')}.`)
  for (const field of TEXT_FIELDS[verb] ?? []) {
    if (request[field] !== undefined && UNSAFE_TEXT.test(request[field])) {
      throw new FleetError('invalid-request', `Invalid ${verb} request: ${field} must not contain control characters other than tab and line breaks.`)
    }
  }
  return structuredClone(request)
}

function offlineMessage(code, write) {
  if (!write || NOT_REACHED.has(code)) return 'herdr is not reachable. Nothing was sent to the pane.'
  return 'The connection to herdr was lost before it answered, so whether the input was delivered is UNKNOWN. Check the pane before sending it again.'
}

/**
 * The one place a herdr failure becomes a FleetError (FLEET-HOST.md §4).
 *
 * @param {unknown} error whatever the client or the flow threw
 * @param {{ verb?: string, write?: boolean }} [context] `write` says whether a write had been attempted when this
 *   failed (default: yes, which is the cautious wording); a failed read says that nothing was written
 * @returns {FleetError}
 */
export function mapHerdrError(error, { verb, write = true } = {}) {
  if (error instanceof FleetError) return error
  if (!(error instanceof HerdrError)) return new FleetError('internal', 'Internal error.') // no stack, no message: it may quote input
  const what = VERBS.includes(verb) ? verb : 'request'
  if (isOfflineError(error)) return new FleetError('herdr-offline', offlineMessage(error.code, write))
  if (error.code === 'timeout') {
    return new FleetError('timeout', write
      ? `herdr did not answer the ${what} in time. Its outcome is UNKNOWN: the input may or may not have been delivered, so check the pane before sending it again.`
      : 'herdr did not answer in time. Nothing was sent to the pane.')
  }
  const message = String(error.message ?? '')
  // A prompt refused because the agent is waiting on a question: the cache was stale. Say so; never type it instead.
  if (error.code === 'agent_blocked' || BLOCKED_REFUSAL.test(message)) {
    return new FleetError('agent-blocked', 'The agent is waiting on a question on screen. Use answer or keys instead of prompt.', { status: 'blocked' })
  }
  if (UNKNOWN_PANE.test(message)) return new FleetError('unknown-pane', 'There is no pane with this id (it may have been closed).')
  return new FleetError('herdr-error', `herdr refused the ${what}.`, { code: safeCode(error.code) })
}

/** herdr agent names are `[a-z][a-z0-9_-]{0,31}`; keep the agent's own name when it already is one. */
function restartName(pane) {
  if (typeof pane.agentName === 'string' && AGENT_NAME.test(pane.agentName)) return pane.agentName
  const cleaned = `${pane.agent}-${pane.id}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32)
  return cleaned === '' ? 'agent' : cleaned
}

const asPaste = (text) => (NEEDS_PASTE.test(text) ? `${PASTE_START}${text}${PASTE_END}` : text)

const screenChanged = (revision) => new FleetError(
  'screen-changed',
  'The screen changed after you looked at it, so nothing was sent. Look at the new screen and decide again.',
  { revision },
)

/**
 * @param {object} deps
 * @param {{ request: (method: string, params?: object, options?: object) => Promise<any> }} deps.client HerdrClient
 * @param {{ snapshot: object, health: { connected: boolean }, stale: boolean, refresh: (options?: object) => Promise<any> }} deps.state HerdrState-shaped
 * @param {{ policy: string, dshPanes: Set<string> }} deps.store FleetStore-shaped; read on every request, never cached here
 * @param {(entry: { verb: string | null, pane: string | null, ok: boolean, reason: string | null, ms: number }) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @returns {{ act: (request: unknown) => Promise<{ ok: true, verb: string, pane: string, revision: number | null }> }}
 */
export function createActions({ client, state, store, log = () => {}, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (typeof client?.request !== 'function') throw new TypeError('createActions: client needs a request() method')
  if (!isObject(state)) throw new TypeError('createActions: state is required')
  if (!isObject(store)) throw new TypeError('createActions: store is required')

  /** pane id -> the tail of the queue of actions for that pane. Different panes never wait for each other. */
  const locks = new Map()

  /** A broken logger must not turn a write that happened into an error (the client would send it again). */
  const emit = (entry) => {
    try {
      log(entry)
    } catch { /* see above */ }
  }

  /**
   * Same-pane actions run one at a time, so two answers cannot interleave their keystrokes. The fresh read that guards
   * `answer`/`keys` happens INSIDE the lock: the second of two identical answers then sees the screen the first one
   * changed and is refused, instead of typing into it blind.
   */
  async function withLock(paneId, task) {
    const previous = locks.get(paneId) ?? Promise.resolve()
    let release
    const mine = new Promise((resolve) => { release = resolve })
    const tail = previous.then(() => mine)
    locks.set(paneId, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (locks.get(paneId) === tail) locks.delete(paneId)
    }
  }

  const offline = () => new FleetError('herdr-offline', 'herdr is not reachable; the panes shown are the last known state. Nothing was sent to the pane.')

  /**
   * Step 2: what the cached state already tells us. No herdr traffic. Run before queueing (so a refusal never waits
   * behind someone else's action) and again once the lock is ours (the policy or the pane may have changed while we
   * queued; the check closest to the write is the one that counts).
   */
  function checkCached(paneId) {
    const connected = state.health?.connected === true
    const stale = state.stale === true
    const pane = state.snapshot?.panes?.find((candidate) => candidate.id === paneId)
    if (pane === undefined) {
      // An empty cache while herdr is down says nothing about whether the pane exists; do not call it a 404.
      throw !connected || stale ? offline() : new FleetError('unknown-pane', 'There is no pane with this id (it may have been closed).')
    }
    const decision = writability(
      { id: pane.id, isAgent: isAgent(pane) },
      // `?? null`: writability() reads `undefined` as "not given" and defaults it to 'all'; a store that failed to
      // produce a policy must not open everything. null is an unknown policy, which it treats as read-only.
      { policy: store.policy ?? null, dshPanes: store.dshPanes, connected, stale },
    )
    if (decision.writable) return pane
    switch (decision.reason) {
      case 'not-an-agent':
        throw new FleetError('not-an-agent', 'This pane is a plain shell, not an agent. Shells are read-only.')
      case 'policy-read-only':
        throw new FleetError('policy-denied', 'The write policy (read-only) does not allow this.', { policy: 'read-only' })
      case 'policy-dsh-only':
        throw new FleetError('policy-denied', 'The write policy (dsh-only) only allows panes DSH created, and this is not one.', { policy: 'dsh-only' })
      case 'offline':
        throw offline()
      default:
        throw new FleetError('internal', 'Internal error.') // a reason this code does not know: refuse rather than guess
    }
  }

  const read = (method, params) => client.request(method, params)
  /** `ctx.wrote` is set BEFORE the attempt: a failure from here on may have left something behind. */
  const write = (ctx, method, params) => {
    ctx.wrote = true
    return client.request(method, params)
  }

  /** pane.get right now (not the cache): the only trustworthy answer to "what is on that screen at this moment". */
  async function readFresh(paneId) {
    const info = (await read('pane.get', { pane_id: paneId }))?.pane
    const revision = info?.revision
    // Without a usable revision there is nothing to compare, and "can't tell" must mean "don't type".
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new FleetError('herdr-error', 'herdr returned a pane description without a usable revision. Nothing was sent to the pane.', { code: 'bad_reply' })
    }
    return { revision, status: typeof info.agent_status === 'string' ? info.agent_status : null }
  }

  /** The revision after the write, for the response. A failed read-back never turns a successful write into an error. */
  async function readBack(paneId) {
    try {
      const revision = (await client.request('pane.get', { pane_id: paneId }, { timeoutMs: READ_BACK_TIMEOUT_MS }))?.pane?.revision
      return Number.isSafeInteger(revision) && revision >= 0 ? revision : null
    } catch {
      return null
    }
  }

  async function refreshQuietly() {
    try {
      await state.refresh?.({ force: true })
    } catch { /* the write already happened; the next poll heals the cache */ }
  }

  /** Someone else may be handed this pane id after a close, and must not inherit its dsh-only access. */
  function forgetPane(paneId) {
    try {
      store.dshPanes?.delete?.(paneId)
    } catch { /* the pane is gone either way */ }
  }

  const flows = {
    async prompt({ pane: paneId, text }, pane, ctx) {
      // Cache-level refusal; herdr's own refusal (the cache being stale) is mapped in mapHerdrError. In neither case
      // does the text go anywhere else: a blocked agent is not listening for a new turn, and typing the prompt into
      // its terminal would answer whatever question is on screen with it.
      if (pane.agentStatus === 'blocked') {
        throw new FleetError('agent-blocked', 'The agent is waiting on a question on screen. Use answer or keys instead of prompt.', { status: 'blocked' })
      }
      await write(ctx, 'agent.prompt', { target: paneId, text })
    },

    async answer({ pane: paneId, text, enter, expectRevision }, pane, ctx) {
      const fresh = await readFresh(paneId)
      // Before the revision: text typed at an agent that is not asking anything lands in its normal input box.
      if (fresh.status !== 'blocked') {
        throw new FleetError('not-blocked', 'The agent is not waiting on a question, so an answer would land in its normal input box. Use prompt instead.')
      }
      if (fresh.revision !== expectRevision) throw screenChanged(fresh.revision)
      await write(ctx, 'pane.send_text', { pane_id: paneId, text: asPaste(text) })
      if (!enter) return
      // If the text did not go in, we never get here: Enter is not sent after a failed send_text.
      ctx.note = 'The text was typed, but Enter was not sent.'
      await sleep(ENTER_DELAY_MS)
      await write(ctx, 'pane.send_keys', { pane_id: paneId, keys: ['enter'] })
    },

    async keys({ pane: paneId, keys, expectRevision }, pane, ctx) {
      const fresh = await readFresh(paneId)
      if (fresh.revision !== expectRevision) throw screenChanged(fresh.revision)
      await write(ctx, 'pane.send_keys', { pane_id: paneId, keys })
    },

    /** One chord and nothing stronger: no revision needed, so it works on a pane that is busy producing output. */
    async interrupt({ pane: paneId }, pane, ctx) {
      await write(ctx, 'pane.send_keys', { pane_id: paneId, keys: ['ctrl+c'] })
    },

    async rename({ pane: paneId, name }, pane, ctx) {
      await write(ctx, 'agent.rename', { target: paneId, name })
    },

    /**
     * Only starts the agent again; nothing is killed. herdr refuses `agent.start` while the agent is alive, and that
     * refusal is reported as it is (`herdr-error` with its code) instead of being papered over.
     */
    async restart({ pane: paneId, thenPrompt }, pane, ctx) {
      await write(ctx, 'agent.start', { name: restartName(pane), kind: pane.agent, pane_id: paneId })
      if (thenPrompt === undefined) return
      ctx.note = 'The agent was restarted, but the follow-up prompt was not delivered.'
      for (let attempt = 1; ; attempt += 1) {
        try {
          await write(ctx, 'agent.prompt', { target: paneId, text: thenPrompt })
          return
        } catch (error) {
          // Only the registration race is retried. A timeout is not: the first try may have been delivered.
          const raced = error instanceof HerdrError && !isOfflineError(error) && error.code !== 'timeout' && UNKNOWN_PANE.test(String(error.message ?? ''))
          if (!raced) throw error
          if (attempt >= PROMPT_ATTEMPTS) {
            // The pane exists (we just started an agent in it): "unknown-pane" would send the client off to forget it.
            throw new FleetError('herdr-error', 'The agent was restarted, but herdr had not registered it in time, so the follow-up prompt was not delivered.', { code: safeCode(error.code) })
          }
          await sleep(PROMPT_RETRY_MS)
        }
      }
    },

    /** No force flag and no "only panes we created": who may close what is the write policy's call, made before this. */
    async close({ pane: paneId }, pane, ctx) {
      await write(ctx, 'pane.close', { pane_id: paneId })
      forgetPane(paneId)
    },
  }

  function describeFailure(error, ctx, verb) {
    const failure = mapHerdrError(error, { verb, write: ctx.wrote })
    // Half-done verbs say which half happened (only herdr failures: our own refusals all come before any write).
    if (ctx.note === null || !(error instanceof HerdrError)) return failure
    return new FleetError(failure.reason, `${ctx.note} ${failure.message}`, failure.detail)
  }

  /**
   * @throws {FleetError} always on failure; the transport turns it into the contract's ErrorResponse
   */
  async function act(request) {
    const started = now()
    const ctx = { wrote: false, note: null }
    let verb = null
    let pane = null
    let revision = null
    try {
      const valid = validateRequest(request)
      verb = valid.verb
      pane = valid.pane
      checkCached(pane)
      revision = await withLock(pane, async () => {
        const cached = checkCached(pane)
        await flows[verb](valid, cached, ctx)
        const after = verb === 'close' ? null : await readBack(pane)
        // Inside the lock on purpose: the next queued action then re-checks against a cache that knows about this one.
        await refreshQuietly()
        return after
      })
    } catch (error) {
      verb ??= knownVerb(request)
      const failure = describeFailure(error, ctx, verb)
      emit({ verb, pane, ok: false, reason: failure.reason, ms: Math.max(0, now() - started) })
      throw failure
    }
    emit({ verb, pane, ok: true, reason: null, ms: Math.max(0, now() - started) })
    return { ok: true, verb, pane, revision }
  }

  return { act }
}
