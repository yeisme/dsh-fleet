/**
 * Attention ranking for the Fleet roster: which agent should a person look at first. Pure on purpose. The host
 * derives State with it (lib/fleet/model.js) and the browser bundle imports it to re-rank panes as the clock moves,
 * so this file imports nothing (no node:*), does no I/O and reads the clock only as a default argument.
 *
 * It works on the PUBLIC contract's Pane (lib/fleet/contract.schema.json): `status`, `outputAt`, `completionSeq`,
 * `stateSince`, `agent` (null = plain shell). Adapted from herdr-orchestrator/lib/model.js, whose pane is herdr's own
 * shape (`agentStatus`, ...); copied and reworked, never imported.
 */

/** A working agent silent for MORE than this long is "stalled" (exactly this long is not). */
export const STALL_MS = 180_000

/**
 * Lower = look at it sooner. Ordered by how much a person is needed, not by activity, so a dozen busy workers cannot
 * bury one approval dialog. A plain shell gets its own last rank instead of sharing idle's: the UI hides shells by
 * default and counts them (`counts.shells`), and a shared rank would let the tie-break interleave them with idle agents.
 */
export const ATTENTION_GROUPS = Object.freeze({
  blocked: 0, // waiting for an answer or an approval
  unread: 1, // finished and the user has not looked at the result
  stalled: 2, // working, but silent for longer than STALL_MS
  working: 3,
  unknown: 4, // herdr could not tell what it is doing ("not recognised": never guessed at)
  read: 5, // finished and already looked at
  idle: 6,
  shell: 7, // not an agent: never needs anyone
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * Working, has produced output at least once, and has been silent for longer than `stallMs`.
 * An agent whose output was never observed (`outputAt` null) is not "silent": there is nothing to measure from.
 */
export function isStalled(pane, now = Date.now(), stallMs = STALL_MS) {
  if (pane?.status !== 'working' || !finite(pane.outputAt)) return false
  return now - pane.outputAt > stallMs
}

// `seen` comes from the browser's storage; anything that is not a number counts as "never read" (0), which errs
// towards showing one unread badge too many rather than one too few.
const readMark = (seen, id) => {
  const mark = seen?.[id]
  return finite(mark) ? mark : 0
}

/** The user has read this pane's latest completion (`seen`: `{ [paneId]: last read completionSeq }`). */
export function isSeen(pane, seen = {}) {
  return readMark(seen, pane?.id) >= (finite(pane?.completionSeq) ? pane.completionSeq : 0)
}

/** FLEET-API.md: unread = `status === 'done' && completionSeq > cursor`. A pane that never completed anything is not unread. */
export function isUnread(pane, seen = {}) {
  return pane?.status === 'done' && !isSeen(pane, seen)
}

/**
 * Attention rank of one pane (see ATTENTION_GROUPS). `agent === null` is the only thing that makes a pane a shell, so a
 * partial pane object without an `agent` key is ranked as the agent it describes.
 */
export function attentionGroup(pane, { now = Date.now(), stallMs = STALL_MS, seen = {} } = {}) {
  if (pane?.agent === null) return ATTENTION_GROUPS.shell
  switch (pane?.status) {
    case 'blocked': return ATTENTION_GROUPS.blocked
    case 'done': return isUnread(pane, seen) ? ATTENTION_GROUPS.unread : ATTENTION_GROUPS.read
    case 'working': return isStalled(pane, now, stallMs) ? ATTENTION_GROUPS.stalled : ATTENTION_GROUPS.working
    case 'idle': return ATTENTION_GROUPS.idle
    default: return ATTENTION_GROUPS.unknown // 'unknown' and anything this code does not recognise
  }
}

// Locale-free on purpose ('en' is pinned): the reader's locale must not reshuffle the roster. `numeric` keeps
// 'w1:p2' ahead of 'w1:p10'.
const byId = new Intl.Collator('en', { numeric: true })

function compareRanked(a, b) {
  if (a.group !== b.group) return a.group - b.group
  // Longest in this state first; a pane whose start is unknown sorts after the ones that are known.
  const sinceA = finite(a.pane.stateSince) ? a.pane.stateSince : Infinity
  const sinceB = finite(b.pane.stateSince) ? b.pane.stateSince : Infinity
  if (sinceA !== sinceB) return sinceA < sinceB ? -1 : 1
  // After a host restart every pane shares one `stateSince`, so this tie-break is what keeps rows from jumping around.
  return byId.compare(String(a.pane.id), String(b.pane.id))
}

/**
 * Comparator for Array.prototype.sort: rank, then longest in state first, then id. Pass `now` explicitly when sorting:
 * a default `Date.now()` evaluated per comparison can flip a pane's stalled-ness mid-sort and break the comparator.
 */
export function attentionOrder(a, b, { now = Date.now(), stallMs = STALL_MS, seen = {} } = {}) {
  const ctx = { now, stallMs, seen }
  return compareRanked({ pane: a, group: attentionGroup(a, ctx) }, { pane: b, group: attentionGroup(b, ctx) })
}

/** A new array in attention order; the input is left alone. The clock is read once for the whole sort. */
export function sortByAttention(panes, { now = Date.now(), stallMs = STALL_MS, seen = {} } = {}) {
  const ctx = { now, stallMs, seen }
  return panes
    .map((pane) => ({ pane, group: attentionGroup(pane, ctx) }))
    .sort(compareRanked)
    .map(({ pane }) => pane)
}

/** "12s", "3m", "1h 5m", "2d"; "—" for anything that is not a non-negative number. Units only: no sentence, no locale. */
export function formatElapsed(ms) {
  if (!finite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  return `${Math.floor(hours / 24)}d`
}
