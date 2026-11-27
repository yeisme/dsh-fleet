/**
 * Finds the transcript file behind a herdr agent session, and decides whether it may be read at all.
 *
 * SECURITY. `session.value` is where herdr says the transcript is, and herdr only repeats what the process inside the
 * pane told it (any process can call `pane.report_agent` with an arbitrary `agent_session_path`). So the value is
 * untrusted: left alone it would turn this module into "read any .jsonl the user can read". Every read therefore goes
 * through `confineFile`:
 *
 * - the path is folded (`..`, `.`, repeated slashes) before anything else, and must lie inside the per-kind root
 *   under `home` (compared with a trailing separator, so `sessions-evil` is not `sessions`);
 * - it must name a `.jsonl` file;
 * - it is resolved with `realpath` and the root is checked AGAIN on the resolved path, so a symlink (or a symlinked
 *   directory) cannot lead out of the root;
 * - the target must be a regular file, and the caller opens exactly the resolved path.
 *
 * Whatever fails these checks is reported as "no transcript", without saying which check failed.
 */
import path from 'node:path'

const NO_TRANSCRIPT = Object.freeze({ missing: 'no-transcript' })
const NOT_YET = Object.freeze({ missing: 'not-yet' })
const UNREADABLE = Object.freeze({ missing: 'unreadable' })

/** Rollouts looked at when choosing by cwd, newest-created first; a window, so a huge history costs a bounded scan. */
const ROLLOUT_SCAN = 400
/** Of those, the most recently modified ones whose head is read to learn their cwd. */
const ROLLOUT_HEADS = 40
/** The first line of a rollout (session_meta) is about 27 KB because it embeds the base instructions. */
const HEAD_BYTES = 128 * 1024
const NEWLINE = 0x0a

const metaCache = new Map()

export function transcriptRoot(kind, home) {
  // Resolved so the lexical comparison in confineFile is between two absolute, folded paths.
  const base = path.resolve(home)
  switch (kind) {
    case 'pi': return path.join(base, '.pi', 'agent', 'sessions')
    case 'claude': return path.join(base, '.claude', 'projects')
    case 'codex': return path.join(base, '.codex', 'sessions')
    default: return null
  }
}

/** Strictly inside: the root itself does not count, and the separator keeps `sessions-evil` out of `sessions`. */
export function isInside(root, candidate) {
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

/** Flags for opening a transcript: read-only, and never through a symlink at the last path component. */
export function readOnlyFlags(fs) {
  const constants = fs.constants ?? {}
  return (constants.O_RDONLY ?? 0) | (constants.O_NOFOLLOW ?? 0)
}

/**
 * @returns {{ path: string, dev: number, ino: number } | { missing: 'no-transcript' | 'not-yet' | 'unreadable' }}
 *   `path` is the fully resolved file, `dev`/`ino` let the opener notice a swap between this check and the open.
 */
export function confineFile(fs, kind, raw, home) {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0') || !path.isAbsolute(raw)) return NO_TRANSCRIPT
  const root = transcriptRoot(kind, home)
  if (root === null) return NO_TRANSCRIPT

  const lexical = path.resolve(raw)
  let realRoot = null
  try { realRoot = fs.realpathSync(root) } catch { /* no such root yet */ }
  // A caller may hand over the already resolved form of a symlinked root (a relocated ~/.claude, say).
  if (!isInside(root, lexical) && !(realRoot !== null && isInside(realRoot, lexical))) return NO_TRANSCRIPT
  if (!lexical.endsWith('.jsonl')) return NO_TRANSCRIPT

  let real
  try {
    real = fs.realpathSync(lexical)
  } catch (error) {
    return classify(fs, error, lexical, realRoot)
  }
  if (realRoot === null || !isInside(realRoot, real)) return NO_TRANSCRIPT
  if (!real.endsWith('.jsonl')) return NO_TRANSCRIPT

  let stat
  try { stat = fs.statSync(real) } catch { return UNREADABLE }
  if (!stat.isFile()) return UNREADABLE
  return { path: real, dev: stat.dev, ino: stat.ino }
}

function classify(fs, error, lexical, realRoot) {
  switch (error?.code) {
    case 'ENOENT': {
      // "Not there yet" must not become a way to ask about places outside the root: if the directory the file would be
      // in exists, it has to resolve inside the root too.
      try {
        const parent = fs.realpathSync(path.dirname(lexical))
        if (realRoot === null || (parent !== realRoot && !isInside(realRoot, parent))) return NO_TRANSCRIPT
      } catch { /* the directory is not there yet either */ }
      return NOT_YET
    }
    case 'ENOTDIR':
    case 'ENAMETOOLONG':
    case 'ELOOP':
      return NO_TRANSCRIPT
    default:
      // EACCES and anything else: something is there (or may be) but it cannot be used.
      return UNREADABLE
  }
}

/** A value with a path separator is a path (possibly relative to the pane's cwd); anything else is a session id. */
const isPathLike = (value) => /[\\/]/.test(value)

/**
 * @param {{ kind: 'pi' | 'claude' | 'codex', session: object | null, cwd: string | null, home: string, fs: object }} input
 */
export function locate({ kind, session, cwd, home, fs }) {
  const value = typeof session?.value === 'string' ? session.value : ''
  const directory = typeof cwd === 'string' && cwd !== '' && !cwd.includes('\0') && path.isAbsolute(cwd) ? path.resolve(cwd) : null
  if (value === '') return discover(fs, kind, { cwd: directory, home, id: null })
  if (isPathLike(value)) {
    // herdr reports a relative path against the pane's cwd; either way the result is confined below.
    const absolute = path.isAbsolute(value) ? value : directory === null ? null : path.resolve(directory, value)
    return absolute === null ? NO_TRANSCRIPT : confineFile(fs, kind, absolute, home)
  }
  return discover(fs, kind, { cwd: directory, home, id: value })
}

/**
 * Without a path from herdr the file is found by the pane's cwd; with a session id, by the file that carries the id.
 * An id that matches nothing is "no transcript", never "the newest file", which could be another session's.
 */
function discover(fs, kind, { cwd, home, id }) {
  if (cwd === null && id === null) return NO_TRANSCRIPT
  const root = transcriptRoot(kind, home)
  if (root === null) return NO_TRANSCRIPT
  let best = null
  if (kind === 'codex') best = discoverCodex(fs, root, cwd, id, home)
  else for (const dir of projectDirs(kind, root, cwd)) best = newer(best, newestJsonl(fs, dir, id))
  if (best === null) return NO_TRANSCRIPT
  return typeof best === 'string' ? confineFile(fs, kind, best, home) : confineFile(fs, kind, best.file, home)
}

const newer = (a, b) => (a === null || (b !== null && (b.mtimeMs > a.mtimeMs || (b.mtimeMs === a.mtimeMs && b.name > a.name))) ? b : a)

/** The directories that can hold this cwd's sessions. The names are encodings of the cwd and contain no separators. */
function projectDirs(kind, root, cwd) {
  if (cwd === null) return []
  if (kind === 'pi') return [path.join(root, `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)]
  // Claude Code turns every non-alphanumeric into a dash; older builds only did it for separators. Try both.
  return [...new Set([cwd.replace(/[^A-Za-z0-9]/g, '-'), cwd.replace(/[/\\]/g, '-')])].map((name) => path.join(root, name))
}

function newestJsonl(fs, dir, id) {
  let names
  try { names = fs.readdirSync(dir) } catch { return null }
  let best = null
  for (const name of names) {
    if (!name.endsWith('.jsonl') || (id !== null && !name.includes(id))) continue
    const file = path.join(dir, name)
    let stat
    try { stat = fs.statSync(file) } catch { continue }
    if (stat.isFile()) best = newer(best, { file, name, mtimeMs: stat.mtimeMs })
  }
  return best
}

/* ----------------------------------------------------------------------------------------------- Codex */

const sortedNames = (fs, dir, pattern) => {
  try { return fs.readdirSync(dir).filter((name) => pattern.test(name)).sort().reverse() } catch { return [] }
}

/** Rollout files, newest-created first (the names start with their timestamp, so name order is time order). */
function listRollouts(fs, root, limit) {
  const found = []
  for (const year of sortedNames(fs, root, /^\d{4}$/)) {
    for (const month of sortedNames(fs, path.join(root, year), /^\d{2}$/)) {
      for (const day of sortedNames(fs, path.join(root, year, month), /^\d{2}$/)) {
        const dir = path.join(root, year, month, day)
        for (const name of sortedNames(fs, dir, /^rollout-.*\.jsonl$/)) {
          found.push(path.join(dir, name))
          if (found.length >= limit) return found
        }
      }
    }
  }
  return found
}

/**
 * A rollout does not say where it belongs in its name or directory: the cwd is inside the file, in its first line.
 * So the choice is by that cwd (the orchestrator this was adapted from took the newest rollout of anyone), among the
 * most recently modified rollouts. Rollouts of spawned sub-agents carry the parent's cwd and are not the pane's own.
 */
function discoverCodex(fs, root, cwd, id, home) {
  const files = listRollouts(fs, root, ROLLOUT_SCAN)
  if (id !== null) {
    const hit = files.find((file) => path.basename(file).includes(id))
    return hit ?? null
  }
  const candidates = []
  for (const file of files) {
    try { candidates.push({ file, mtimeMs: fs.statSync(file).mtimeMs }) } catch { /* vanished or dangling */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? 1 : -1))
  for (const candidate of candidates.slice(0, ROLLOUT_HEADS)) {
    // Confine before reading even the head: a symlinked rollout must not be opened just to learn its cwd.
    const confined = confineFile(fs, 'codex', candidate.file, home)
    if (confined.path === undefined) continue
    const meta = sessionMeta(fs, confined.path)
    if (meta !== null && !meta.subAgent && sameDirectory(fs, meta.cwd, cwd)) return confined.path
  }
  return null
}

/** The head of a rollout never changes once written, so one read per (file, size, mtime) is enough. */
function sessionMeta(fs, file) {
  let stat
  try { stat = fs.statSync(file) } catch { return null }
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}`
  if (metaCache.has(key)) return metaCache.get(key)
  let meta = null
  let fd
  try {
    fd = fs.openSync(file, readOnlyFlags(fs))
    const buffer = Buffer.alloc(Math.min(HEAD_BYTES, stat.size))
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const end = buffer.subarray(0, bytes).indexOf(NEWLINE)
    if (end > 0) {
      const record = JSON.parse(buffer.toString('utf8', 0, end))
      if (record?.type === 'session_meta' && record.payload !== null && typeof record.payload === 'object') {
        meta = { cwd: typeof record.payload.cwd === 'string' ? record.payload.cwd : '', subAgent: typeof record.payload.parent_thread_id === 'string' }
      }
    }
  } catch { /* unreadable or not a rollout: it simply does not match */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch { /* nothing to do */ }
  }
  if (metaCache.size >= 512) metaCache.clear()
  metaCache.set(key, meta)
  return meta
}

/** cwd strings can differ by spelling (`/tmp` and `/private/tmp`), so compare resolved forms as well. */
function sameDirectory(fs, recorded, cwd) {
  if (typeof recorded !== 'string' || recorded === '' || cwd === null) return false
  const a = path.resolve(recorded)
  if (a === cwd) return true
  try { return fs.realpathSync(a) === fs.realpathSync(cwd) } catch { return false }
}
