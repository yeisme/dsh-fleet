/**
 * Agent session files -> the contract's conversation frames (docs/design/FLEET-HOST.md §2 and §6, FLEET-API.md §4).
 *
 * Adapted from herdr-orchestrator/lib/transcripts.js (code reuse only; the parsing is a reference, the output is the
 * contract's Frame, not the orchestrator's shape). What changed on purpose:
 *
 * - `before` really pages backwards, and pages are cut at frame boundaries, so paging a file page by page returns
 *   exactly the frames of one unpaged read, in order, each once;
 * - `after` returns what the appended bytes created or changed, and a changed tool run (a result that arrived) is
 *   returned again under the same id so a client can complete its pending row;
 * - cursors carry a signature, so a truncated or replaced file is a `reset`, not a corrupt page;
 * - Codex rollouts are chosen by cwd (locate.js), and every path is confined to the per-kind root.
 *
 * The file system is the synchronous `node:fs` surface (stat, fstat, open, read, close, realpath, readdir), injectable
 * so a test can count the bytes read. Reads are windows of the tail, never the whole file.
 */
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RUN_SPAN, TEXT_CAP } from './frames.js'
import { locate, readOnlyFlags } from './locate.js'
import { Region, Source, decodeEnd, decodeStart, encodeEnd, encodeStart, looksBinary, parseLines, readWindow } from './reader.js'
import * as claude from './claude.js'
import * as codex from './codex.js'
import * as pi from './pi.js'

export { RUN_SPAN, TEXT_CAP }

/** The default tail window: at most this much of a file is parsed per read. */
export const DEFAULT_WINDOW_BYTES = 2 * 1024 * 1024
export const DEFAULT_LIMIT = 80

const MAX_LIMIT = 500
/** A read starts small and doubles until it holds `limit` frames, so a short page of a huge file stays cheap. */
const FIRST_READ_BYTES = 128 * 1024
/** Only a window with no usable frame at all may grow past `windowBytes`, up to this much. */
const MAX_GROWTH_BYTES = 32 * 1024 * 1024
const PROBE_BYTES = 32 * 1024
const PROBES = 4
const SNIFF_BYTES = 1024
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

const ADAPTERS = { pi, claude, codex }
const ALIASES = new Map([['pi', 'pi'], ['claude', 'claude'], ['claude-code', 'claude'], ['claudecode', 'claude'], ['codex', 'codex']])
const NO_PARSE = Object.freeze({ entries: [], unknown: [], sessionId: null, openStart: null, objects: 0, bad: 0 })

const normalizeKind = (kind) => (typeof kind === 'string' ? ALIASES.get(kind.trim().toLowerCase()) ?? null : null)
const present = (cursor) => cursor !== undefined && cursor !== null && cursor !== ''
const missing = (reason) => ({ status: 'missing', reason })

export const supportsKind = (kind) => normalizeKind(kind) !== null

/**
 * @param {object} input
 * @param {string} input.kind transcript adapter: pi, claude or codex
 * @param {{ agent?: string, kind?: string, source?: string, value?: string } | null} input.session the herdr agent
 *   session as the host holds it; `value` is UNTRUSTED (see locate.js)
 * @param {string | null} input.cwd the pane's working directory; the fallback for finding the file
 * @param {string} [input.before] `cursor.start` of a response: the page that comes before it
 * @param {string} [input.after] `cursor.end` of a response: what was appended since
 * @param {number} [input.limit] frames per page (a page never holds more)
 * @param {number} [input.windowBytes] the most bytes parsed per read
 * @returns {Promise<{ status: 'ok', sessionId: string | null, frames: object[], hasEarlier: boolean, partial: boolean,
 *   reset: boolean, unknownFrames: number, cursor: { start: string | null, end: string | null } }
 *   | { status: 'missing', reason: 'no-transcript' | 'not-yet' | 'unsupported-agent' | 'unreadable' }>}
 * @throws {TypeError} when `before` and `after` are both given (the caller validates first)
 */
export async function readFrames({
  kind,
  session = null,
  cwd = null,
  home = os.homedir(),
  before,
  after,
  limit = DEFAULT_LIMIT,
  signal,
  fs = nodeFs,
  windowBytes = DEFAULT_WINDOW_BYTES,
  textCap = TEXT_CAP,
  runSpan = RUN_SPAN,
} = {}) {
  if (present(before) && present(after)) throw new TypeError('readFrames: `before` and `after` cannot be combined')
  checkAbort(signal)
  const adapterKind = normalizeKind(kind)
  if (adapterKind === null) return missing('unsupported-agent')
  const located = locate({ kind: adapterKind, session, cwd, home, fs })
  if (located.path === undefined) return missing(located.missing)

  let fd
  try {
    fd = fs.openSync(located.path, readOnlyFlags(fs))
  } catch (error) {
    return missing(error?.code === 'ENOENT' ? 'not-yet' : error?.code === 'ELOOP' ? 'no-transcript' : 'unreadable')
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return missing('unreadable')
    // The file at the resolved path is no longer the one that was checked: do not read it.
    if (stat.dev !== located.dev || stat.ino !== located.ino) return missing('no-transcript')
    const ctx = {
      source: new Source(fs, fd, stat.size),
      size: stat.size,
      adapter: ADAPTERS[adapterKind],
      limit: Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
      windowBytes: Math.max(64, Number.isFinite(windowBytes) ? Math.trunc(windowBytes) : DEFAULT_WINDOW_BYTES),
      parseOptions: { textCap, runSpan },
      signal,
      fileId: UUID.exec(path.basename(located.path))?.[1] ?? null,
    }
    if (present(after)) return readAfter(ctx, after)
    if (present(before)) return readBefore(ctx, before)
    return readTail(ctx, false)
  } catch (error) {
    // I/O trouble (EACCES, EIO, a file that shrank mid-read) means "cannot be read"; anything else is a bug and surfaces.
    if (typeof error?.code === 'string') return missing('unreadable')
    throw error
  } finally {
    try { fs.closeSync(fd) } catch { /* nothing left to release */ }
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' })
}

/* ---------------------------------------------------------------------------------------------- results */

function ok(ctx, parsed, fields) {
  return {
    status: 'ok',
    sessionId: ctx.fileId ?? parsed.sessionId,
    frames: fields.frames,
    hasEarlier: fields.hasEarlier,
    partial: fields.partial,
    reset: fields.reset,
    unknownFrames: fields.unknownFrames,
    cursor: { start: fields.start, end: fields.end },
  }
}

function empty(ctx, reset) {
  return ok(ctx, NO_PARSE, { frames: [], hasEarlier: false, partial: false, reset, unknownFrames: 0, start: null, end: null })
}

/* ------------------------------------------------------------------------------------------------ pages */

/**
 * The newest page of the file (or of what ends at `end`), assembled from windows that grow until they hold enough.
 *
 * Frame boundaries must not depend on where a window starts. A tool run (a `work` frame) is the one frame built from
 * several records, so the first frame of a window that begins inside the file may be a run whose start lies before the
 * window: it is dropped here and returned by the older page, whose window reaches back far enough to hold the whole
 * run. Every other frame comes from one record and is the same whichever window it is read from.
 */
function collectPage(ctx, { end, tail, bound }) {
  const region = new Region(ctx.source, end)
  let bytes = Math.min(ctx.windowBytes, FIRST_READ_BYTES)
  // The read starts small; if that does not hold a page it goes straight to the full window, and only a window with
  // no usable frame at all may double beyond it. The region extends backwards, so no byte is read twice.
  const larger = (budget) => (bytes < ctx.windowBytes ? Math.min(ctx.windowBytes, budget) : Math.min(bytes * 2, budget))
  for (;;) {
    checkAbort(ctx.signal)
    region.grow(bytes)
    const window = region.lines({ tail })
    if (window.invalid) return { invalid: true }
    if (window.lines.length === 0) {
      if (window.windowStart > 0 && bytes < MAX_GROWTH_BYTES) {
        bytes = larger(MAX_GROWTH_BYTES)
        continue
      }
      return { entries: [], hasEarlier: false, windowStart: window.windowStart, eof: window.consumedTo, parsed: NO_PARSE }
    }
    const parsed = parseLines(ctx.adapter, window, ctx.parseOptions)
    let entries = parsed.entries
    let dropped = false
    if (window.windowStart > 0 && entries.length > 0 && entries[0].work) {
      entries = entries.slice(1)
      dropped = true
    }
    if (bound !== null) entries = entries.filter((entry) => entry.start < bound.start || (entry.start === bound.start && entry.sub < bound.sub))
    const budget = entries.length === 0 ? MAX_GROWTH_BYTES : ctx.windowBytes
    if (entries.length < ctx.limit && window.windowStart > 0 && bytes < budget) {
      bytes = larger(budget)
      continue
    }
    const selected = entries.slice(-ctx.limit)
    let hasEarlier = entries.length > selected.length || dropped
    if (!hasEarlier && selected.length > 0 && window.windowStart > 0) hasEarlier = hasEarlierFrames(ctx, window.windowStart)
    return { entries: selected, hasEarlier, windowStart: window.windowStart, eof: window.consumedTo, parsed }
  }
}

/** Is there any frame before `boundary`? Looks back a few blocks; if it cannot tell, it says yes. */
function hasEarlierFrames(ctx, boundary) {
  const block = Math.min(PROBE_BYTES, ctx.windowBytes)
  let end = boundary
  for (let step = 0; step < PROBES && end > 0; step += 1) {
    const window = readWindow(ctx.source, { end, bytes: block, tail: false })
    if (window.invalid) return true
    if (window.lines.length > 0 && parseLines(ctx.adapter, window, ctx.parseOptions).entries.length > 0) return true
    end = window.windowStart
  }
  return end > 0
}

function pageResult(ctx, page, { reset, tail, end, bound }) {
  const first = page.entries[0] ?? null
  // Unknown entries belong to the page whose byte range holds them, so the counts of consecutive pages add up.
  const from = first !== null && page.hasEarlier ? first.start : 0
  const to = bound === null ? Infinity : bound.start
  return ok(ctx, page.parsed, {
    frames: page.entries.map((entry) => entry.frame),
    hasEarlier: page.hasEarlier,
    partial: page.windowStart > 0 && end > ctx.windowBytes,
    reset,
    unknownFrames: page.parsed.unknown.filter((offset) => offset >= from && offset < to).length,
    start: first === null ? null : encodeStart(first, ctx.source.signature(first.recEnd)),
    // Only a read of the end of the file can say where "since" begins; an older page leaves it to the client.
    end: tail && page.eof > 0 ? encodeEnd({ eof: page.eof, open: page.parsed.openStart, sig: ctx.source.signature(page.eof) }) : null,
  })
}

function readTail(ctx, reset) {
  if (ctx.size === 0) return empty(ctx, reset)
  const page = collectPage(ctx, { end: ctx.size, tail: true, bound: null })
  if (page.invalid) return missing('unreadable')
  // Nothing that parses as a record at all: junk or a log wearing a .jsonl name.
  if (page.parsed.objects === 0 && (page.parsed.bad > 0 || looksBinary(ctx.source.read(0, SNIFF_BYTES)))) return missing('unreadable')
  return pageResult(ctx, page, { reset, tail: true, end: ctx.size, bound: null })
}

function readBefore(ctx, text) {
  const cursor = decodeStart(text)
  // A cursor that does not fit this file means the file is not the one the client was paging.
  if (cursor === null || cursor.recEnd > ctx.size || ctx.source.signature(cursor.recEnd) !== cursor.sig) return readTail(ctx, true)
  const page = collectPage(ctx, { end: cursor.recEnd, tail: false, bound: cursor })
  if (page.invalid) return readTail(ctx, true)
  return pageResult(ctx, page, { reset: false, tail: false, end: cursor.recEnd, bound: cursor })
}

function readAfter(ctx, text) {
  const cursor = decodeEnd(text)
  if (cursor === null || cursor.eof > ctx.size || ctx.source.signature(cursor.eof) !== cursor.sig) return readTail(ctx, true)
  // Start at the open tool run, if there was one, so a result that arrived can complete it.
  const from = cursor.open ?? cursor.eof
  // The appended part does not fit a window: frames would be missing between the client's last one and this read.
  if (ctx.size - from > ctx.windowBytes) return readTail(ctx, true)
  const window = readWindow(ctx.source, { end: ctx.size, bytes: ctx.size - from, tail: true, requireLineStart: true })
  if (window.invalid) return readTail(ctx, true)
  const eof = window.consumedTo
  if (eof <= cursor.eof) {
    // Nothing complete was appended (a line may be half written). The same cursor stays valid.
    return ok(ctx, NO_PARSE, { frames: [], hasEarlier: false, partial: false, reset: false, unknownFrames: 0, start: null, end: text })
  }
  const parsed = parseLines(ctx.adapter, window, ctx.parseOptions)
  const fresh = parsed.entries.filter((entry) => entry.end > cursor.eof)
  // More than a page of news: give the newest page and say so, rather than return a window with a hole before it.
  if (fresh.length > ctx.limit) return readTail(ctx, true)
  return ok(ctx, parsed, {
    frames: fresh.map((entry) => entry.frame),
    hasEarlier: fresh.length > 0 && fresh[0].start > 0,
    partial: false,
    reset: false,
    unknownFrames: parsed.unknown.filter((offset) => offset >= cursor.eof).length,
    start: fresh.length === 0 ? null : encodeStart(fresh[0], ctx.source.signature(fresh[0].recEnd)),
    end: encodeEnd({ eof, open: parsed.openStart, sig: ctx.source.signature(eof) }),
  })
}
