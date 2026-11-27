/**
 * The Fleet state model: a normalized herdr snapshot (lib/herdr/normalize.js) plus what the host knows around it
 * (connection health, write policy, summaries, the clock) -> the public `State` of lib/fleet/contract.schema.json.
 * Pure: no I/O, and the clock is an argument (`Date.now()` is only the default when the caller leaves it out). Every
 * output is built fresh, so a caller can neither mutate what it passed in through the result nor the other way round.
 *
 * Rules that matter (docs/design/FLEET-HOST.md §5, docs/design/FLEET-API.md §2):
 *  - workspaces and counts are DERIVED FROM THE PANES, never copied from herdr's own counters, so the State agrees
 *    with itself (test/contract.test.mjs asserts that invariant on the fixtures);
 *  - nothing outside the contract is ever emitted: a value that would not validate is replaced by the contract's own
 *    "don't know" (agent name -> null, status -> 'unknown', summary -> '' / 'none'), not passed through;
 *  - what the browser must not see stays here: the agent session's `value` (a path or id) is dropped;
 *  - text is never invented: a summary is real text from a transcript or the screen, or it is empty.
 */
import { POLICIES, writability } from './writability.js'
import { isStalled } from './attention.js'

/** The CONTRACT's version (State.protocol). Not herdr's protocol number: that is State.health.protocol. */
export const CONTRACT_PROTOCOL = 1
/** Pane.summary's limit in the contract, counted in code points the way lib/fleet/schema.js counts maxLength. */
export const SUMMARY_MAX = 240
/** The contract's AgentName pattern. A name that fails it never reaches the browser. */
export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/
/** herdr's five statuses, which are also the contract's Status enum. */
export const STATUSES = Object.freeze(['working', 'blocked', 'done', 'idle', 'unknown'])
const SUMMARY_SOURCES = new Set(['transcript', 'screen'])
const ID_MAX = 64

const list = (value) => (Array.isArray(value) ? value : [])
const text = (value) => (typeof value === 'string' ? value : null)
const present = (value) => (typeof value === 'string' && value !== '' ? value : null)
/** A whole number >= 0 (the contract's `minimum: 0` integers), or null. */
const integer = (value) => (Number.isInteger(value) && value >= 0 ? value : null)
const count = (value) => integer(value) ?? 0
/** An instant the contract accepts (integer >= 0), or null. Fractions are floored: epoch-ms is whole milliseconds. */
const instant = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null)
const codePoints = (value) => [...value].length
const validId = (value) => typeof value === 'string' && value !== '' && codePoints(value) <= ID_MAX

/**
 * Cut `value` (a string) to at most `max` code points, ending in an ellipsis when something was cut. Counting and
 * cutting by code point (not UTF-16 unit) is what keeps an emoji or a CJK extension character from being split in half.
 */
export function clipText(value, max = SUMMARY_MAX) {
  const limit = Math.max(1, Math.floor(max)) // the ellipsis itself needs a slot
  const points = [...value]
  return points.length <= limit ? value : `${points.slice(0, limit - 1).join('')}…`
}

/* ------------------------------------------------------------------------------------------------ buildState */

function buildAgent(pane) {
  const kind = present(pane.agent)
  if (kind === null) return null
  const name = text(pane.agentName)
  const session = pane.agentSession
  return {
    kind,
    name: name !== null && AGENT_NAME.test(name) ? name : null,
    display: present(pane.displayAgent) ?? kind,
    // How herdr bound the session, and only that: `value` is a path/id that stays on the host (transcripts are read
    // here and reach the browser as frames). A session missing either half cannot be described, so it is null.
    session: typeof session?.kind === 'string' && typeof session.source === 'string' ? { kind: session.kind, source: session.source } : null,
    interactiveReady: typeof pane.interactiveReady === 'boolean' ? pane.interactiveReady : null,
  }
}

function summaryOf(summaries, id) {
  const entry = summaries !== null && typeof summaries === 'object' && Object.hasOwn(summaries, id) ? summaries[id] : null
  // Text without a known source, or a source without text, is not a summary: say nothing rather than attribute it wrongly.
  if (typeof entry?.text !== 'string' || entry.text.trim() === '' || !SUMMARY_SOURCES.has(entry.source)) return { summary: '', summarySource: 'none' }
  return { summary: clipText(entry.text), summarySource: entry.source }
}

/**
 * The one pane that has focus. herdr's session-level focused pane id wins. Whether a pane's own `focused` flag is
 * session-wide or only "focused within its tab" is not verified against a live herdr, so the flags are only the
 * fallback, and only the first flagged pane counts: the State never shows two focused panes.
 */
function focusedPaneId(snapshot, panes) {
  const declared = present(snapshot.focused?.paneId)
  if (declared !== null) return declared
  return panes.find((pane) => pane?.focused === true)?.id ?? null
}

function buildHealth(health) {
  return {
    connected: health?.connected === true,
    socket: text(health?.socket),
    version: text(health?.version),
    protocol: integer(health?.protocol),
    lastOkAt: instant(health?.lastOkAt),
    error: text(health?.error),
    session: text(health?.session),
  }
}

function toSet(value) {
  if (value instanceof Set) return value
  return new Set(Array.isArray(value) ? value : [])
}

/**
 * @param {object} input
 * @param {object} input.snapshot   normalized herdr snapshot (EMPTY_SNAPSHOT before the first successful refresh)
 * @param {object} input.health     the contract's Health (HerdrState#health)
 * @param {boolean} input.stale     panes are the last-known ones: the connection dropped after a good snapshot
 * @param {{ write: string, dshPanes?: Set<string> | string[] }} input.policy   host write policy; State only publishes `write`
 * @param {number} [input.now]      host clock, epoch ms (State.now, and the reference for `stalled`); default: the clock
 * @param {Record<string, { text: string, source: string }>} [input.summaries]   per pane id; missing = no summary
 * @param {number} [input.revision] the service's State counter; falls back to the snapshot's own revision, then 0
 * @returns {object} State
 */
export function buildState({ snapshot, health, stale, policy, now = Date.now(), summaries, revision } = {}) {
  const source = snapshot ?? {}
  // Data from herdr is repaired below, but a clock that is not a time is the caller's bug and has no safe default:
  // a plausible-looking State built on the wrong "now" is worse than an error.
  const at = instant(now)
  if (at === null) throw new TypeError('buildState: `now` must be epoch milliseconds (a number >= 0)')
  const connected = health?.connected === true
  const isStale = stale === true
  // Fails closed, like writability(): a policy that is missing or not one of the three is published (and enforced) as
  // read-only. A caller that forgets the policy sees every pane locked at once, which is loud; the opposite default
  // would quietly allow writes.
  const write = POLICIES.includes(policy?.write) ? policy.write : 'read-only'
  const dshPanes = toSet(policy?.dshPanes)

  const workspaceLabels = new Map(list(source.workspaces).filter((workspace) => workspace?.id).map((workspace) => [workspace.id, present(workspace.label)]))
  const tabLabels = new Map(list(source.tabs).filter((tab) => tab?.id).map((tab) => [tab.id, present(tab.label)]))
  const rawPanes = list(source.panes)
  const focusedId = focusedPaneId(source, rawPanes)

  const panes = []
  for (const pane of rawPanes) {
    // A pane that cannot carry the contract's identity fields cannot be addressed by the browser either: leave it out
    // instead of publishing a State that fails its own schema.
    if (!validId(pane?.id) || !validId(pane.workspaceId) || !validId(pane.tabId)) continue
    const agent = buildAgent(pane)
    const status = agent !== null && STATUSES.includes(pane.agentStatus) ? pane.agentStatus : 'unknown' // a shell is never anything but unknown
    const outputAt = instant(pane.outputAt)
    const { writable, reason } = writability({ id: pane.id, isAgent: agent !== null }, { policy: write, dshPanes, connected, stale: isStale })
    panes.push({
      id: pane.id,
      workspaceId: pane.workspaceId,
      tabId: pane.tabId,
      workspaceLabel: workspaceLabels.get(pane.workspaceId) ?? pane.workspaceId,
      tabLabel: tabLabels.get(pane.tabId) ?? pane.tabId,
      title: text(pane.title) ?? '',
      cwd: present(pane.foregroundCwd) ?? present(pane.cwd) ?? '',
      focused: pane.id === focusedId,
      agent,
      status,
      stalled: isStalled({ status, outputAt }, at),
      completionSeq: count(pane.completionSeq),
      stateChangeSeq: count(pane.stateChangeSeq),
      // Never observed -> "since now": the first moment this host knew about it. 0 would read as "since 1970".
      stateSince: instant(pane.stateSince) ?? at,
      outputAt,
      revision: count(pane.revision),
      ...summaryOf(summaries, pane.id),
      writable,
      writableReason: reason,
    })
  }

  const counts = { blocked: 0, done: 0, working: 0, idle: 0, unknown: 0, agents: 0, shells: 0, panes: panes.length }
  const byWorkspace = new Map()
  for (const pane of panes) {
    if (pane.agent === null) counts.shells += 1
    else { counts.agents += 1; counts[pane.status] += 1 }
    const entry = byWorkspace.get(pane.workspaceId) ?? { id: pane.workspaceId, label: pane.workspaceLabel, focused: false, tabs: new Set(), paneCount: 0 }
    entry.focused ||= pane.focused
    entry.tabs.add(pane.tabId)
    entry.paneCount += 1
    byWorkspace.set(pane.workspaceId, entry)
  }
  // herdr's own workspace order, but only workspaces that have a pane in this State; a workspace herdr did not list
  // (an inconsistent snapshot) still appears, after the others, because its panes do.
  const workspaceOrder = new Set([...list(source.workspaces).map((workspace) => workspace?.id), ...byWorkspace.keys()])
  const workspaces = [...workspaceOrder].filter((id) => byWorkspace.has(id)).map((id) => {
    const { tabs, ...rest } = byWorkspace.get(id)
    return { ...rest, tabCount: tabs.size }
  })

  return {
    ok: true,
    protocol: CONTRACT_PROTOCOL,
    revision: integer(revision) ?? integer(source.revision) ?? 0,
    now: at,
    stale: isStale,
    machine: { id: 'local', label: '本机' },
    health: buildHealth(health),
    policy: { write },
    workspaces,
    panes,
    counts,
  }
}

/* ---------------------------------------------------------------------------------------------- deriveSummary */

const none = () => ({ text: '', source: 'none' })
const oneLine = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')
const hasWords = (line) => /[\p{L}\p{N}]/u.test(line)

// This runs on the host's event loop over text nobody controls (a transcript line can be a minified blob, a screen can
// hold anything), so every pattern below is linear or bounded, and a single line is looked at only up to LINE_MAX.
// Real lines are far shorter; the cap just bounds the worst case (test/model.test.mjs feeds it adversarial lines).
const LINE_MAX = 2000
function capLine(line) {
  if (line.length <= LINE_MAX) return line
  const cut = line.slice(0, LINE_MAX)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut // never end on half of a surrogate pair
}

/**
 * Markdown line -> the words in it. Only syntax that would read as noise in a one-line roster row is removed
 * (quote/list markers, link targets, bold and code marks); no word is added, dropped or reordered.
 */
function plain(line) {
  return oneLine(line
    .replace(/^(?:>\s*)+/, '')
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]{0,300})\]\([^)]{0,2000}\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1'))
}

/**
 * The first line of a markdown message that says something: blank lines, code fences and what is inside them, rules
 * and table rows are skipped. A heading counts only when nothing else does ("## Summary" alone beats an empty row,
 * but a sentence under it beats the heading).
 */
function firstMeaningfulLine(markdown) {
  let heading = ''
  let inFence = false
  for (const raw of String(markdown).split(/\r?\n/)) {
    const line = capLine(raw.trim())
    if (/^(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence || line === '' || /^([-*_])(?:\s*\1){2,}$/.test(line) || line.startsWith('|')) continue
    const asHeading = /^#{1,6}\s+(.*)$/.exec(line)
    const words = plain(asHeading ? asHeading[1] : line)
    if (!hasWords(words)) continue
    if (asHeading) { heading ||= words; continue }
    return words
  }
  return heading
}

/** The agent's closing words of the CURRENT turn: assistant text (or a `final` frame's text), newest first, back to the last user message. */
function lastAssistantLine(frames) {
  for (const frame of [...list(frames)].reverse()) {
    if (frame?.kind === 'text' && frame.role === 'user') return '' // an older turn's answer is not this turn's outcome
    const closing = (frame?.kind === 'text' && frame.role === 'assistant') || frame?.kind === 'final'
    const line = closing && typeof frame.text === 'string' ? firstMeaningfulLine(frame.text) : ''
    if (line) return line
  }
  return ''
}

/** The most recent tool action of the current turn, as "<verb> <object>". */
function lastWorkRow(frames) {
  for (const frame of [...list(frames)].reverse()) {
    if (frame?.kind === 'text' && frame.role === 'user') return ''
    if (frame?.kind !== 'work') continue
    for (const row of [...list(frame.rows)].reverse()) {
      const line = [oneLine(row?.verb), oneLine(row?.object)].filter(Boolean).join(' ')
      if (line) return line
    }
  }
  return ''
}

// OSC (window title, hyperlinks) first, then CSI (SGR colours, cursor moves, ...), then every other escape (an ESC,
// optional intermediate bytes, one final byte: "ESC ( B" charset selects, "ESC 7" cursor saves, ...); any control byte
// left over except newline and tab goes too (a bare carriage return would glue lines together).
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const ESCAPE = /\u001b[ -/]*[0-~]/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g
export const stripAnsi = (value) => value.replace(OSC, '').replace(CSI, '').replace(ESCAPE, '').replace(CONTROL, '')

// "...?", "...？", or "...? [y/N]" / "...? (y/n)": a line that ends like a question.
const QUESTION = /[?？]\s*(?:[(\[][^)\]]{0,24}[)\]])?$/u
// Box borders around a dialog line ("│ Do you want to proceed?   │"). Trimmed by hand: an end-anchored regex for this
// backtracks quadratically on a long run of border characters in the middle of a line.
const BORDER_CHARS = '│┃║╎┆┊'
function trimBorders(line) {
  const isBorder = (char) => char === ' ' || BORDER_CHARS.includes(char)
  let start = 0
  let end = line.length
  while (start < end && isBorder(line[start])) start += 1
  while (end > start && isBorder(line[end - 1])) end -= 1
  return line.slice(start, end)
}

/**
 * What a blocked agent is asking, from the visible screen. The screen of an approval dialog ends in its options and a
 * footer, so "the last lines" would be "1. Yes / 2. No": the question is the last line that reads like one, within
 * the bottom of the screen. If nothing does, the last line with words in it is the best real text there is.
 */
function questionOnScreen(screenText) {
  const lines = stripAnsi(screenText).split(/\r?\n/).map((line) => capLine(trimBorders(oneLine(line)))).filter(hasWords).slice(-20)
  return lines.findLast((line) => QUESTION.test(line)) ?? lines.at(-1) ?? ''
}

/**
 * The one-line "what is it doing" for a pane, from what the agent itself produced. Never invented: when there is
 * nothing real to show the answer is empty, not a guess.
 *  - done    -> the first meaningful line of the agent's last words in the current turn      (source 'transcript')
 *  - working -> its most recent tool action, "<verb> <object>"                                 (source 'transcript')
 *  - blocked -> the question on the visible screen, ANSI stripped                              (source 'screen')
 *  - anything else -> ''                                                                       (source 'none')
 * @param {{ status?: string, frames?: object[], screenText?: string }} input  frames: the contract's Frame[]
 * @returns {{ text: string, source: 'transcript' | 'screen' | 'none' }} text is at most SUMMARY_MAX code points
 */
export function deriveSummary({ status, frames, screenText } = {}) {
  let found = ''
  let source = 'none'
  if (status === 'done') { found = lastAssistantLine(frames); source = 'transcript' }
  else if (status === 'working') { found = lastWorkRow(frames); source = 'transcript' }
  else if (status === 'blocked' && typeof screenText === 'string') { found = questionOnScreen(screenText); source = 'screen' }
  return found === '' ? none() : { text: clipText(found), source }
}
