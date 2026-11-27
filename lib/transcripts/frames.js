/**
 * What the three transcript adapters (pi.js, claude.js, codex.js) share: small value helpers and the FrameBuilder that
 * turns records into the contract's frames (lib/fleet/contract.schema.json: session, text, reasoning, work, final).
 *
 * Two rules shape this file:
 *
 * 1. A frame is a function of the records alone, never of where a read window happened to start. Pages are cut at
 *    frame boundaries and the tests compare them with an unpaged parse, so the only state kept between records is the
 *    one tool run that is open (see `call`). Everything else a record needs is in the record.
 * 2. Nothing is invented. A value the record does not carry is null or absent, never a guess.
 */

/** Per-entry text cap in code points: one giant message must not bloat a response. */
export const TEXT_CAP = 8000
/**
 * A tool run never spans a multiple of this many bytes. Without it a transcript that is nothing but tool calls
 * (no text or reasoning in between) would be one frame whose first record could lie arbitrarily far back, and a page
 * would have to read all the way there to know where the frame starts. The split is positional, so every read window
 * agrees on it.
 */
export const RUN_SPAN = 1 << 20

const OBJECT_CAP = 120
const VERB_CAP = 64
const SUMMARY_VERBS = 3
const INPUT_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'task', 'notebook_path']
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T/

export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A non-empty string or null. */
export const str = (value) => (typeof value === 'string' && value !== '' ? value : null)

/** A non-negative integer (a duration or a token count) or null. Anything else is "unknown", not coerced. */
export const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null)

/** Epoch ms from the first candidate that is either a ms number or an ISO-8601 string. */
export function timeOf(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
    // Date.parse accepts oddities such as "12"; only a real ISO timestamp counts as a time here.
    if (typeof value === 'string' && ISO_PREFIX.test(value)) {
      const ms = Date.parse(value)
      if (Number.isFinite(ms) && ms >= 0) return ms
    }
  }
  return null
}

/** Cuts at `cap` code points (never inside a surrogate pair) and marks the cut with an ellipsis. */
export function clip(value, cap) {
  if (typeof value !== 'string') return ''
  // UTF-16 length is an upper bound of the code point count, so a short string needs no scan.
  if (value.length <= cap) return value
  let index = 0
  let points = 0
  while (index < value.length && points < cap) {
    index += value.codePointAt(index) > 0xffff ? 2 : 1
    points += 1
  }
  return index >= value.length ? value : `${value.slice(0, index)}…`
}

/** Collapses whitespace and clips; the preview is cut before collapsing so a huge input costs a bounded scan. */
function oneLine(value, cap) {
  return clip(value.slice(0, cap * 4).replace(/\s+/g, ' ').trim(), cap)
}

/** Message content as blocks: a bare string is one text block, anything unusable is none. */
export function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter(isObject) : []
}

/** The text blocks of a message, joined; `types` lists the block types that carry text for the calling agent. */
export function joinText(content, types = ['text']) {
  return blocksOf(content)
    .filter((block) => types.includes(block.type) && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
}

/** What a tool call was pointed at, as one short line: the field that names the target wins over a key listing. */
export function describeInput(input) {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (trimmed.startsWith('{')) {
      // Codex function calls carry their arguments as a JSON string.
      try {
        const parsed = JSON.parse(trimmed)
        if (isObject(parsed)) return describeInput(parsed)
      } catch { /* not JSON after all: describe the text itself */ }
    }
    return oneLine(trimmed, OBJECT_CAP)
  }
  if (!isObject(input)) return ''
  for (const key of INPUT_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value, OBJECT_CAP)
    if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string')) return oneLine(value.join(' '), OBJECT_CAP)
  }
  return clip(Object.keys(input).slice(0, 4).join(', '), 80)
}

/** `Read ×3 · Bash`: verbs in first-seen order with a count when repeated; neutral text, the client decides the wording. */
export function summarizeRows(rows) {
  const counts = new Map()
  for (const row of rows) counts.set(row.verb, (counts.get(row.verb) ?? 0) + 1)
  const parts = [...counts].map(([verb, n]) => (n > 1 ? `${verb} ×${n}` : verb))
  return parts.length > SUMMARY_VERBS + 1 ? `${parts.slice(0, SUMMARY_VERBS).join(' · ')} · +${parts.length - SUMMARY_VERBS}` : parts.join(' · ')
}

/**
 * Collects frames while an adapter walks the records of one window in file order.
 *
 * The adapter calls `begin` once per record, then any of the emitters. Frame ids are `f<record offset>.<n>` (n counts
 * the frames of one record), so they never change as the file grows and are unique within a transcript.
 *
 * Every entry remembers the byte range that produced it. `end` is the end of the last record that touched the entry,
 * which is how an `after` read tells "a frame that changed" (a tool run that got its result) from "a frame that was
 * already delivered".
 */
export class FrameBuilder {
  entries = []
  /** Offsets of the records that were not understood. */
  unknown = []
  sessionId = null
  offset = 0
  recEnd = 0
  #sub = 0
  #run = null
  #textCap
  #runSpan

  constructor({ textCap = TEXT_CAP, runSpan = RUN_SPAN } = {}) {
    this.#textCap = textCap
    this.#runSpan = runSpan
  }

  begin(offset, recEnd) {
    this.offset = offset
    this.recEnd = recEnd
    this.#sub = 0
  }

  markUnknown() {
    this.unknown.push(this.offset)
  }

  noteSession(id) {
    if (typeof id === 'string' && id !== '') this.sessionId = id
  }

  #emit(make, work = false) {
    const sub = this.#sub
    this.#sub += 1
    const entry = { frame: make(`f${this.offset.toString(36)}.${sub}`), start: this.offset, recEnd: this.recEnd, sub, end: this.recEnd, work, tokens: null, tokenKeys: null, calls: null }
    this.entries.push(entry)
    return entry
  }

  /** Any frame that is not tool activity ends the tool run, so frames stay in transcript order. */
  #closeRun() {
    this.#run = null
  }

  session(sessionId, cwd) {
    this.#closeRun()
    this.noteSession(sessionId)
    this.#emit((id) => ({ kind: 'session', id, sessionId: sessionId ?? '', cwd: cwd ?? '' }))
  }

  text(role, value, at = null) {
    if (typeof value !== 'string' || value.trim() === '') return
    this.#closeRun()
    this.#emit((id) => ({ kind: 'text', id, role, text: clip(value, this.#textCap), at }))
  }

  system(value) {
    this.text('system', value, null)
  }

  reasoning(value) {
    if (typeof value !== 'string' || value.trim() === '') return
    this.#closeRun()
    this.#emit((id) => ({ kind: 'reasoning', id, text: clip(value, this.#textCap) }))
  }

  final({ text = '', reason, ms = null }) {
    this.#closeRun()
    this.#emit((id) => ({ kind: 'final', id, text: clip(text, this.#textCap), reason, ms: count(ms) }))
  }

  /**
   * A tool call joins the open run, or opens one. A run is the consecutive tool activity between two other frames:
   * calls and their results, in any interleaving. It stays open until some other frame is emitted.
   */
  call({ callId, verb, object = '', at = null, usage = null }) {
    let run = this.#run
    if (run !== null && Math.floor(this.offset / this.#runSpan) !== Math.floor(run.start / this.#runSpan)) run = null
    if (run === null) {
      run = this.#emit((id) => ({ kind: 'work', id, summary: '', rows: [], tokens: null }), true)
      run.calls = new Map()
      run.tokenKeys = new Set()
      this.#run = run
    }
    const row = { verb: clip(str(verb) ?? 'tool', VERB_CAP), object, outcome: null, ms: null }
    run.frame.rows.push(row)
    if (typeof callId === 'string' && callId !== '') run.calls.set(callId, { row, at })
    run.end = this.recEnd
    if (usage !== null) this.tokens(usage)
  }

  /**
   * Pairs a result with its call. Only the open run is searched: a result for a call outside it (an older run, or one
   * before the window began) is ignored, so a frame never depends on records outside the run it belongs to.
   * `ms` is the agent's own duration when it records one, else the time between the call and its result.
   */
  result({ callId, outcome, ms = null, at = null }) {
    const run = this.#run
    if (run === null || typeof callId !== 'string') return false
    const call = run.calls.get(callId)
    if (call === undefined) return false
    if (call.row.outcome !== null) return true
    call.row.outcome = outcome === 'error' ? 'error' : 'ok'
    call.row.ms = count(ms) ?? (at !== null && call.at !== null && at >= call.at ? at - call.at : null)
    run.end = this.recEnd
    return true
  }

  /** Output tokens of the model response behind the open run; `key` stops one response being counted twice. */
  tokens({ key = null, output }) {
    const run = this.#run
    const n = count(output)
    if (run === null || n === null) return
    if (key !== null) {
      if (run.tokenKeys.has(key)) return
      run.tokenKeys.add(key)
    }
    run.tokens = (run.tokens ?? 0) + n
    run.end = this.recEnd
  }

  finish() {
    for (const entry of this.entries) {
      if (!entry.work) continue
      entry.frame.summary = summarizeRows(entry.frame.rows)
      entry.frame.tokens = entry.tokens
    }
    return { entries: this.entries, unknown: this.unknown, sessionId: this.sessionId, openStart: this.#run?.start ?? null }
  }
}
