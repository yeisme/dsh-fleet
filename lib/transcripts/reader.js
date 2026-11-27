/**
 * Byte-level reading of a transcript: windows of whole lines, opaque cursors, and the signature that tells a replaced
 * file from a grown one. Nothing here knows what a record means; that is the adapters' job.
 *
 * Why byte offsets: a transcript is append-only and can be tens of megabytes, so a position must survive the file
 * growing, and a read must not cost the size of the file. Every offset handed out is the start or end of a line.
 */
import { createHash } from 'node:crypto'
import { FrameBuilder, isObject } from './frames.js'

const NEWLINE = 0x0a
/**
 * The signature covers the first line (at most this many bytes) and the bytes just before the cursor's offset. The
 * first line of an append-only file never changes once complete, and the bytes before the offset would differ if the
 * file had been rewritten in place, so a cursor from another file (or another life of this one) does not match.
 */
const SIGNATURE_HEAD = 256
const SIGNATURE_TAIL = 64
const NOTHING = Buffer.alloc(0)

export class Source {
  #head = null

  constructor(fs, fd, size) {
    this.fs = fs
    this.fd = fd
    /** The size when the file was opened: a read never looks past it, so one request sees one consistent file. */
    this.size = size
  }

  read(position, length) {
    const want = Math.max(0, Math.min(length, this.size - position))
    const buffer = Buffer.allocUnsafe(want)
    let filled = 0
    while (filled < want) {
      const got = this.fs.readSync(this.fd, buffer, filled, want - filled, position + filled)
      if (got === 0) break
      filled += got
    }
    return filled === want ? buffer : buffer.subarray(0, filled)
  }

  signature(offset) {
    if (this.#head === null) {
      const head = this.read(0, Math.min(SIGNATURE_HEAD, this.size))
      const end = head.indexOf(NEWLINE)
      this.#head = end >= 0 ? head.subarray(0, end + 1) : head
    }
    const tailLength = Math.min(SIGNATURE_TAIL, offset)
    const tail = tailLength > 0 ? this.read(offset - tailLength, tailLength) : NOTHING
    return createHash('sha1').update(this.#head).update('\0').update(tail).digest('hex').slice(0, 12)
  }
}

/* ---------------------------------------------------------------------------------------------- cursors */

const base36 = (value) => value.toString(36)
const NUMBER = '([0-9a-z]{1,12})'
const END = new RegExp(`^e\\.${NUMBER}\\.(-|[0-9a-z]{1,12})\\.([0-9a-f]{12})$`)
const START = new RegExp(`^s\\.${NUMBER}\\.${NUMBER}\\.${NUMBER}\\.([0-9a-f]{12})$`)

const parse = (text) => {
  const value = Number.parseInt(text, 36)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * `end`: everything up to `eof` (the end of the last complete line) has been delivered. `open` is the first byte of
 * the tool run that was still open at that point, or null: an `after` read starts there so the run can be completed.
 */
export const encodeEnd = ({ eof, open, sig }) => `e.${base36(eof)}.${open === null ? '-' : base36(open)}.${sig}`

/**
 * `start`: the position of the first frame of a page. A frame is (record offset, index within the record), and a record
 * ends at `recEnd`; the previous page is everything that comes strictly before that frame, and reading it needs the
 * whole record, hence `recEnd`.
 */
export const encodeStart = (entry, sig) => `s.${base36(entry.start)}.${base36(entry.recEnd)}.${base36(entry.sub)}.${sig}`

export function decodeEnd(text) {
  const match = typeof text === 'string' ? END.exec(text) : null
  if (match === null) return null
  const eof = parse(match[1])
  const open = match[2] === '-' ? null : parse(match[2])
  if (eof === null || eof <= 0 || (match[2] !== '-' && (open === null || open >= eof))) return null
  return { eof, open, sig: match[3] }
}

export function decodeStart(text) {
  const match = typeof text === 'string' ? START.exec(text) : null
  if (match === null) return null
  const start = parse(match[1])
  const recEnd = parse(match[2])
  const sub = parse(match[3])
  if (start === null || recEnd === null || sub === null || start >= recEnd) return null
  return { start, recEnd, sub, sig: match[4] }
}

/* ---------------------------------------------------------------------------------------------- windows */

/**
 * The bytes before `end` read so far, which can be extended backwards without reading anything twice. A read that
 * has to grow (a short page of a huge file, a line longer than the window) therefore costs the final window once,
 * not the sum of the sizes it tried.
 */
export class Region {
  constructor(source, end) {
    this.source = source
    this.end = end
    this.readStart = end
    this.buffer = NOTHING
  }

  /** Makes the region cover at least `bytes` bytes before `end`, plus the one byte that classifies the first line. */
  grow(bytes) {
    const start = Math.max(0, this.end - bytes)
    const readStart = start > 0 ? start - 1 : 0
    if (readStart >= this.readStart) return
    const older = this.source.read(readStart, this.readStart - readStart)
    // The file shrank under the read: offsets would no longer line up, so this is an I/O failure, not a short page.
    if (older.length !== this.readStart - readStart) throw Object.assign(new Error('short read'), { code: 'EIO' })
    this.buffer = this.buffer.length === 0 ? older : Buffer.concat([older, this.buffer])
    this.readStart = readStart
  }

  /**
   * The complete lines in the region.
   *
   * A region that starts inside the file begins in the middle of some line: that half line is not a record and is
   * skipped. The byte just before the window says whether it happens to start on a line boundary. A line that is
   * still being written (no newline yet) is left out the same way, so a record is only ever read whole.
   *
   * @param {boolean} tail true when `end` is the end of the file, so the last line may be unfinished; otherwise `end`
   *   must be a line boundary and anything else means the cursor does not belong to this file
   * @param {boolean} requireLineStart true when the region must begin exactly on a line boundary (an `after` read)
   * @returns {{ invalid: true } | { lines: { offset: number, end: number, from: number, to: number }[], buffer: Buffer,
   *   windowStart: number, consumedTo: number }}
   *   `windowStart` is where the first complete line begins; `consumedTo` is where the last one ends.
   */
  lines({ tail, requireLineStart = false }) {
    const { buffer, readStart } = this
    let at = 0
    if (readStart > 0) {
      if (requireLineStart && buffer[0] !== NEWLINE) return { invalid: true }
      const first = buffer.indexOf(NEWLINE)
      // No newline at all: one line is longer than what was read. The caller grows the region.
      if (first < 0) return { lines: [], buffer, windowStart: readStart + 1, consumedTo: readStart }
      at = first + 1
    }
    if (!tail && (buffer.length === 0 || buffer[buffer.length - 1] !== NEWLINE)) return { invalid: true }
    const windowStart = readStart + at
    const lines = []
    while (at < buffer.length) {
      const newline = buffer.indexOf(NEWLINE, at)
      if (newline < 0) break
      lines.push({ offset: readStart + at, end: readStart + newline + 1, from: at, to: newline })
      at = newline + 1
    }
    return { lines, buffer, windowStart, consumedTo: readStart + at }
  }
}

/** One-shot read of the lines in `[end - bytes, end)`. */
export function readWindow(source, { end, bytes, tail, requireLineStart = false }) {
  const region = new Region(source, end)
  region.grow(bytes)
  return region.lines({ tail, requireLineStart })
}

/** Runs one adapter over a window's lines. Blank lines are skipped; non-JSON lines and non-objects count as unknown. */
export function parseLines(adapter, window, options) {
  const builder = new FrameBuilder(options)
  let objects = 0
  let bad = 0
  for (const line of window.lines) {
    builder.begin(line.offset, line.end)
    let text = window.buffer.toString('utf8', line.from, line.to)
    if (line.offset === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    if (text.trim() === '') continue
    let record
    try { record = JSON.parse(text) } catch { record = undefined }
    if (!isObject(record)) {
      builder.markUnknown()
      bad += 1
      continue
    }
    objects += 1
    if (!adapter.handle(record, builder)) builder.markUnknown()
  }
  return { ...builder.finish(), objects, bad }
}

/** Text files are valid UTF-8 without NUL; a transcript that is not is something else wearing a .jsonl name. */
export function looksBinary(buffer) {
  if (buffer.includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer, { stream: true })
    return false
  } catch {
    return true
  }
}
