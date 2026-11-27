/**
 * Durable settings of the Fleet host: the write policy, and the panes DSH itself created (the allow-list the
 * `dsh-only` policy consults). One tiny JSON document at an injected path.
 *
 * More careful than "save a JSON file" because the policy decides who may type into terminals, so a storage accident
 * must never LOOSEN it:
 *  - Writes are atomic (temp file in the same directory, fsync, rename). A concurrent reader or a crash sees the old
 *    document or the new one, never a torn one. A torn file would read as "corrupt", and corrupt means defaults.
 *  - Missing file at start: defaults (`all`, the product default). Unparseable file at start: defaults, with a
 *    `diagnostic`. Parseable file holding a policy this code does not know: `read-only` (fail closed, the same rule
 *    as writability()).
 *  - A file that becomes unreadable WHILE running never changes what is already in force: the last good values stay.
 *  - Every mutation re-reads the file first and applies its change to what it finds, so two stores on one file (a
 *    reloaded plugin next to the instance it replaced) do not erase each other's unrelated field. A conflict on the
 *    same field is last-writer-wins; there is no lock.
 *  - Reads never throw. Writes throw (and leave the values in force untouched) because a setting that silently failed
 *    to persist would revert to the permissive default after a restart.
 */
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { POLICIES } from './writability.js'

export const DEFAULT_POLICY = 'all'

const FORMAT_VERSION = 1
/** The document is a few hundred bytes; anything bigger is not ours and is not worth parsing. */
const MAX_BYTES = 1024 * 1024
/** The contract's Id: 1-64 characters. */
const MAX_ID_LENGTH = 64
/** How long a read of the file may be reused before looking again (0 = look on every access). */
const DEFAULT_MAX_STALE_MS = 50

let tempSeq = 0

const isId = (value) => typeof value === 'string' && value.length >= 1 && value.length <= MAX_ID_LENGTH

/** @returns {{ policy: string, ids: string[], note: string | null } | null} null when the text is not a settings document at all */
function parseDocument(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  let policy = DEFAULT_POLICY
  let note = null
  // Present but unrecognized (a typo, a value from a newer version) is NOT the same as absent: do not widen.
  if (Object.hasOwn(raw, 'policy')) {
    if (POLICIES.includes(raw.policy)) {
      policy = raw.policy
    } else {
      policy = 'read-only'
      note = 'the policy in the settings file is not recognized; treating it as read-only'
    }
  }
  const ids = Array.isArray(raw.dshPanes) ? [...new Set(raw.dshPanes.filter(isId))] : []
  return { policy, ids, note }
}

const REPLACE = Symbol('replace contents without persisting')

/**
 * The `dshPanes` Set. A real Set (writability() only needs `.has`), but every mutation writes through to the file, so
 * `store.dshPanes.add(id)` cannot be silently lost the way a mutation of a defensive copy would be.
 */
class DshPaneSet extends Set {
  #commit

  constructor(commit) {
    super()
    this.#commit = commit
  }

  /** Used by the store to mirror the file; deliberately bypasses the persisting overrides below. */
  [REPLACE](ids) {
    super.clear()
    for (const id of ids) super.add(id)
  }

  add(value) {
    if (!isId(value)) throw new TypeError('a pane id is a non-empty string of at most 64 characters')
    this.#commit((state) => (state.ids.includes(value) ? null : { ...state, ids: [...state.ids, value] }))
    return this
  }

  delete(value) {
    let removed = false
    this.#commit((state) => {
      if (!state.ids.includes(value)) return null
      removed = true
      return { ...state, ids: state.ids.filter((id) => id !== value) }
    })
    return removed
  }

  clear() {
    this.#commit((state) => (state.ids.length === 0 ? null : { ...state, ids: [] }))
  }
}

export class FleetStore {
  #file
  #maxStaleMs
  #policy = DEFAULT_POLICY
  #panes
  /** Text of the file as last seen, so an unchanged file is not parsed again. */
  #raw = null
  #checkedAt = null
  #diagnostic = null

  /** @param {{ file: string, maxStaleMs?: number }} options `file` is injected, never derived here */
  constructor({ file, maxStaleMs = DEFAULT_MAX_STALE_MS } = {}) {
    if (typeof file !== 'string' || file === '') throw new TypeError('FleetStore needs the path of its settings file')
    this.#file = file
    this.#maxStaleMs = Number.isFinite(maxStaleMs) && maxStaleMs >= 0 ? maxStaleMs : DEFAULT_MAX_STALE_MS
    this.#panes = new DshPaneSet((change) => this.#commit(change))
    this.#refresh()
  }

  get file() { return this.#file }

  /** 'all' | 'dsh-only' | 'read-only' */
  get policy() {
    this.#sync()
    return this.#policy
  }

  /** Why the file was not (fully) used, or null: shown to the operator, never to the browser. */
  get diagnostic() { return this.#diagnostic }

  /**
   * Panes DSH created. Mutations (`add`, `delete`, `clear`) persist before they return and throw if they cannot.
   * Read it through the store each time (not from a long-held reference) to see another instance's changes.
   * @returns {Set<string>}
   */
  get dshPanes() {
    this.#sync()
    return this.#panes
  }

  /** @throws {TypeError} for a value outside POLICIES; {Error} when the file cannot be written (nothing changes then) */
  setPolicy(policy) {
    if (!POLICIES.includes(policy)) throw new TypeError(`policy must be one of: ${POLICIES.join(', ')}`)
    // Always written, even when unchanged: an explicit choice should exist on disk, not only in memory.
    this.#commit((state) => ({ ...state, policy }))
    return this.#policy
  }

  #sync() {
    if (this.#checkedAt !== null && performance.now() - this.#checkedAt < this.#maxStaleMs) return
    this.#refresh()
  }

  #refresh() {
    this.#checkedAt = performance.now()
    this.#load()
  }

  /** Adopt what is on disk. Never throws; anything that cannot be read leaves the values in force untouched. */
  #load() {
    let text
    try {
      const info = statSync(this.#file, { throwIfNoEntry: false })
      if (info === undefined) {
        // First run, or somebody deleted it: nothing to adopt, and nothing to loosen either.
        this.#raw = null
        this.#diagnostic = null
        return
      }
      if (!info.isFile() || info.size > MAX_BYTES) throw Object.assign(new Error('not a settings file'), { code: 'EINVAL' })
      text = readFileSync(this.#file, 'utf8')
    } catch (error) {
      this.#diagnostic = `cannot read ${path.basename(this.#file)} (${error?.code ?? 'error'}); keeping the values in force`
      return
    }
    if (text === this.#raw) return
    this.#raw = text
    const parsed = parseDocument(text)
    if (parsed === null) {
      this.#diagnostic = `${path.basename(this.#file)} is not a settings document; keeping the values in force`
      return
    }
    this.#apply(parsed)
    this.#diagnostic = parsed.note
  }

  #apply({ policy, ids }) {
    this.#policy = policy
    this.#panes[REPLACE](ids)
  }

  /** Read-modify-write. `change(state)` returns the next state, or null for "nothing to do". */
  #commit(change) {
    this.#load()
    const next = change({ policy: this.#policy, ids: [...this.#panes] })
    if (next === null) return
    const state = { policy: next.policy, ids: [...next.ids].sort() }
    const body = `${JSON.stringify({ version: FORMAT_VERSION, policy: state.policy, dshPanes: state.ids }, null, 2)}\n`
    this.#save(body)
    this.#raw = body
    this.#apply(state)
    this.#diagnostic = null
    this.#checkedAt = performance.now()
  }

  #save(body) {
    // Unique per write so two stores in one process (or two processes) never share a temp file.
    const temp = `${this.#file}.tmp-${process.pid}-${(tempSeq += 1)}`
    let fd = null
    try {
      mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 })
      // Owner-only: this file decides who may type into terminals.
      fd = openSync(temp, 'wx', 0o600)
      writeSync(fd, body)
      // Without the fsync a power cut can leave an empty file behind the rename, which would read as "corrupt".
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(temp, this.#file)
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* already failing */ }
      }
      try { rmSync(temp, { force: true }) } catch { /* nothing more can be done about a stray temp file */ }
      throw new Error(`could not save ${path.basename(this.#file)} (${error?.code ?? 'error'})`)
    }
  }
}
