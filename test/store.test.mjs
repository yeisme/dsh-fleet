import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { DEFAULT_POLICY, FleetStore } from '../lib/fleet/store.js'
import { POLICIES, writability } from '../lib/fleet/writability.js'

const STORE_URL = pathToFileURL(new URL('../lib/fleet/store.js', import.meta.url).pathname).href
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const isWindows = process.platform === 'win32'

let dir
let file
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-store-'))
  file = path.join(dir, 'fleet.json')
})
afterEach(() => {
  // A test may have taken the permissions away from the file it is poking at.
  try { fs.chmodSync(file, 0o600) } catch { /* the file may not exist */ }
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Always look at the disk: no staleness window, so assertions about "the other writer's change" are deterministic. */
const open = (options = {}) => new FleetStore({ file, maxStaleMs: 0, ...options })
const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'))
const leftovers = () => fs.readdirSync(dir).filter((name) => name !== 'fleet.json')

describe('defaults', () => {
  it('a store on a missing file is policy "all" with no DSH panes, and reading creates nothing', () => {
    const store = open()
    assert.equal(DEFAULT_POLICY, 'all')
    assert.equal(store.policy, 'all')
    assert.equal(store.dshPanes.size, 0)
    assert.equal(store.diagnostic, null, 'a missing file is normal on first run, not a problem')
    assert.deepEqual(fs.readdirSync(dir), [])
  })

  it('needs a path: a store that silently kept nothing would revert the policy to the permissive default on restart', () => {
    for (const options of [undefined, {}, { file: '' }, { file: null }, { file: 7 }]) assert.throws(() => new FleetStore(options), TypeError, JSON.stringify(options))
  })

  it('exposes the path it was given and nothing derived', () => {
    assert.equal(open().file, file)
  })
})

describe('policy', () => {
  it('setPolicy persists, and a new store on the same file starts from it', () => {
    const store = open()
    assert.equal(store.setPolicy('read-only'), 'read-only')
    assert.equal(store.policy, 'read-only')
    assert.equal(open().policy, 'read-only')
    assert.equal(onDisk().policy, 'read-only')
  })

  it('accepts exactly the policies the contract lists, and every one of them round-trips', () => {
    const store = open()
    for (const policy of POLICIES) {
      store.setPolicy(policy)
      assert.equal(open().policy, policy)
    }
  })

  it('rejects anything outside POLICIES, leaves the value in force, and writes nothing', () => {
    const store = open()
    store.setPolicy('dsh-only')
    const before = fs.readFileSync(file, 'utf8')
    for (const bad of ['ALL', 'write', '', ' all', 'read_only', null, undefined, 3, true, {}, ['all']]) {
      assert.throws(() => store.setPolicy(bad), TypeError, String(bad))
    }
    assert.equal(store.policy, 'dsh-only')
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  })

  it('a rejected value never creates the file either', () => {
    assert.throws(() => open().setPolicy('nope'), TypeError)
    assert.deepEqual(fs.readdirSync(dir), [])
  })

  it('writes a small versioned document, readable by the owner only', () => {
    const store = open()
    store.setPolicy('dsh-only')
    store.dshPanes.add('w1:p2')
    assert.deepEqual(onDisk(), { version: 1, policy: 'dsh-only', dshPanes: ['w1:p2'] })
    if (!isWindows) assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'this file decides who may type into terminals')
  })

  it('creates the missing directories on the way', () => {
    file = path.join(dir, 'a', 'b', 'fleet.json')
    open().setPolicy('read-only')
    assert.equal(onDisk().policy, 'read-only')
  })
})

describe('dshPanes', () => {
  it('is a real Set that writability() can use as is', () => {
    const store = open()
    assert.ok(store.dshPanes instanceof Set)
    store.dshPanes.add('w1:p1')
    const context = { policy: 'dsh-only', dshPanes: store.dshPanes, connected: true, stale: false }
    assert.deepEqual(writability({ id: 'w1:p1', isAgent: true }, context), { writable: true, reason: null })
    assert.deepEqual(writability({ id: 'w1:p2', isAgent: true }, context), { writable: false, reason: 'policy-dsh-only' })
  })

  it('add / has / delete / clear work and every change is on disk before the call returns', () => {
    const store = open()
    const { dshPanes } = store
    assert.equal(dshPanes.add('w1:p2'), dshPanes, 'add returns the set, like Set.add')
    dshPanes.add('w1:p1')
    assert.equal(dshPanes.has('w1:p1'), true)
    assert.deepEqual(onDisk().dshPanes, ['w1:p1', 'w1:p2'], 'persisted, and sorted so the file diffs cleanly')
    assert.equal(dshPanes.delete('w1:p1'), true)
    assert.equal(dshPanes.delete('w1:p1'), false, 'delete reports whether it removed anything')
    assert.deepEqual(open().dshPanes.size, 1)
    assert.equal(open().dshPanes.has('w1:p2'), true)
    dshPanes.clear()
    assert.deepEqual(onDisk().dshPanes, [])
    assert.equal(dshPanes.size, 0)
  })

  it('is the same live object on every access, so a held reference stays correct', () => {
    const store = open()
    const first = store.dshPanes
    first.add('w1:p3')
    assert.equal(store.dshPanes, first)
    assert.equal(store.dshPanes.has('w1:p3'), true)
  })

  it('does not rewrite the file for a change that is not one', () => {
    const store = open()
    store.dshPanes.add('w1:p1')
    const before = fs.statSync(file).ino // every real write is a rename of a new file: a new inode
    store.dshPanes.add('w1:p1')
    store.dshPanes.delete('w1:p9')
    assert.equal(fs.statSync(file).ino, before)
    const fresh = open({ file: path.join(dir, 'untouched.json') })
    fresh.dshPanes.delete('w1:p1')
    fresh.dshPanes.clear()
    assert.equal(fs.existsSync(path.join(dir, 'untouched.json')), false, 'a no-op never creates the file')
  })

  it('only takes pane ids: a non-string, an empty string or an id over the contract\'s 64 characters is refused and not stored', () => {
    const store = open()
    for (const bad of [undefined, null, 7, {}, ['w1:p1'], '', 'x'.repeat(65)]) assert.throws(() => store.dshPanes.add(bad), TypeError, String(bad))
    assert.equal(store.dshPanes.size, 0)
    assert.equal(fs.existsSync(file), false)
    store.dshPanes.add('x'.repeat(64))
    assert.equal(store.dshPanes.size, 1, 'exactly 64 is fine')
  })
})

describe('a missing or corrupt file', () => {
  const longId = 'x'.repeat(65)
  const cases = [
    ['text that is not JSON', 'garbage{', 'all', [], true],
    ['an empty file', '', 'all', [], true],
    ['JSON cut off in the middle (a torn write)', '{"version":1,"policy":"read-on', 'all', [], true],
    ['JSON null', 'null', 'all', [], true],
    ['a JSON array', '[]', 'all', [], true],
    ['a JSON string', '"read-only"', 'all', [], true],
    ['an object with none of our keys', '{}', 'all', [], false],
    ['dshPanes that is not an array', '{"dshPanes":"w1:p1"}', 'all', [], false],
    ['dshPanes with junk entries: only valid, distinct ids survive', JSON.stringify({ dshPanes: ['w1:p1', 3, null, '', { a: 1 }, 'w1:p1', longId] }), 'all', ['w1:p1'], false],
    ['a policy of the wrong type: not widened, read as read-only', '{"policy":7}', 'read-only', [], true],
    ['a null policy', '{"policy":null}', 'read-only', [], true],
    ['a policy this code does not know', '{"policy":"ask"}', 'read-only', [], true],
    ['a policy with the wrong case', '{"policy":"ALL"}', 'read-only', [], true],
    ['a valid document, for contrast', '{"version":1,"policy":"dsh-only","dshPanes":["w1:p2"]}', 'dsh-only', ['w1:p2'], false],
  ]

  for (const [label, content, policy, panes, diagnosed] of cases) {
    it(`${label}: policy ${policy}, never throws${diagnosed ? ', says why in diagnostic' : ''}`, () => {
      fs.writeFileSync(file, content)
      const store = open()
      assert.equal(store.policy, policy)
      assert.deepEqual([...store.dshPanes], panes)
      assert.equal(typeof store.diagnostic, diagnosed ? 'string' : 'object')
      if (!diagnosed) assert.equal(store.diagnostic, null)
    })
  }

  it('a file over 1 MiB is not ours: defaults, and it is not parsed', () => {
    fs.writeFileSync(file, `{"policy":"read-only","pad":"${'x'.repeat(1024 * 1024)}"}`)
    const store = open()
    assert.equal(store.policy, 'all')
    assert.match(store.diagnostic, /cannot read fleet\.json/)
  })

  it('a directory where the file should be reads as defaults; writing then fails loudly and leaves no debris', () => {
    fs.mkdirSync(file)
    const store = open()
    assert.equal(store.policy, 'all')
    assert.match(store.diagnostic, /cannot read fleet\.json/)
    assert.throws(() => store.setPolicy('read-only'), /could not save fleet\.json/)
    assert.equal(store.policy, 'all', 'a failed write changes nothing in force')
    assert.deepEqual(fs.readdirSync(dir), ['fleet.json'], 'no temp file left behind')
  })

  it('writing over a corrupt file heals it, keeping the values that were in force', () => {
    fs.writeFileSync(file, 'garbage{')
    const store = open()
    store.setPolicy('dsh-only')
    assert.deepEqual(onDisk(), { version: 1, policy: 'dsh-only', dshPanes: [] })
    assert.equal(store.diagnostic, null)
  })

  it('a file that goes bad WHILE running never loosens what is in force', () => {
    const store = open()
    store.setPolicy('read-only')
    store.dshPanes.add('w1:p1')
    fs.writeFileSync(file, 'garbage{')
    assert.equal(store.policy, 'read-only', 'corruption must not read as "all"')
    assert.equal(store.dshPanes.has('w1:p1'), true)
    assert.match(store.diagnostic, /not a settings document/)
    fs.rmSync(file)
    assert.equal(store.policy, 'read-only', 'a deleted file is not a reset either')
    assert.equal(store.diagnostic, null, 'a missing file is not a fault')
    store.dshPanes.add('w1:p2') // the next change writes a good document again, from what was in force
    assert.deepEqual(onDisk(), { version: 1, policy: 'read-only', dshPanes: ['w1:p1', 'w1:p2'] })
  })

  it('an unreadable file (permissions) while running keeps the values in force', { skip: isRoot || isWindows }, () => {
    const store = open()
    store.setPolicy('dsh-only')
    fs.chmodSync(file, 0o000)
    assert.equal(store.policy, 'dsh-only')
    assert.match(store.diagnostic, /cannot read fleet\.json \(EACCES\)/)
  })

  it('an edit by hand that stays valid is picked up (the way to loosen the policy on purpose)', () => {
    const store = open()
    store.setPolicy('read-only')
    fs.writeFileSync(file, '{"version":1,"policy":"all","dshPanes":[]}')
    assert.equal(store.policy, 'all')
  })
})

describe('a write that cannot happen', () => {
  it('throws, and the policy and the pane set stay as they were', () => {
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'a file where a directory is needed')
    const store = new FleetStore({ file: path.join(blocker, 'fleet.json'), maxStaleMs: 0 })
    // (the errno differs by platform: ENOTDIR on Linux, EEXIST from mkdir -p on macOS; only "it throws" is the contract)
    assert.throws(() => store.setPolicy('read-only'), /could not save fleet\.json \(\w+\)/)
    assert.throws(() => store.dshPanes.add('w1:p1'), /could not save/)
    assert.equal(store.policy, 'all')
    assert.equal(store.dshPanes.has('w1:p1'), false)
    assert.deepEqual(fs.readdirSync(dir), ['blocker'])
  })

  it('the error does not leak the directory layout', () => {
    const blocker = path.join(dir, 'secret-dir-name')
    fs.writeFileSync(blocker, '')
    const store = new FleetStore({ file: path.join(blocker, 'fleet.json') })
    assert.throws(() => store.setPolicy('read-only'), (error) => !error.message.includes('secret-dir-name') && !error.message.includes(os.tmpdir()))
  })
})

describe('two writers on one file', () => {
  it('a change to one field does not erase the other writer\'s change to the other field', () => {
    const a = open()
    const b = open()
    a.setPolicy('read-only')
    b.dshPanes.add('w1:p1') // b last looked before a wrote; it must merge into what is on disk, not overwrite it
    assert.deepEqual(onDisk(), { version: 1, policy: 'read-only', dshPanes: ['w1:p1'] }, 'the stricter policy survived the other writer')
    assert.equal(b.policy, 'read-only', 'and b enforces it from now on')
    assert.equal(a.dshPanes.has('w1:p1'), true)
  })

  it('does not lose entries when both add to the same set, one after the other', () => {
    const a = open()
    const b = open()
    a.dshPanes.add('w1:p1')
    b.dshPanes.add('w1:p2')
    a.dshPanes.add('w1:p3')
    assert.deepEqual(onDisk().dshPanes, ['w1:p1', 'w1:p2', 'w1:p3'])
    b.dshPanes.delete('w1:p1')
    assert.deepEqual([...a.dshPanes].sort(), ['w1:p2', 'w1:p3'])
  })

  it('a conflict on the same field is last-writer-wins, and everyone then agrees on the winner', () => {
    const a = open()
    const b = open()
    a.setPolicy('dsh-only')
    b.setPolicy('all')
    assert.equal(a.policy, 'all')
    assert.equal(b.policy, 'all')
    assert.equal(open().policy, 'all')
  })

  it('another instance\'s change is visible to a reader with the default staleness window, within a moment', async () => {
    const reader = new FleetStore({ file })
    open().setPolicy('read-only')
    const deadline = Date.now() + 2000
    while (reader.policy !== 'read-only') {
      assert.ok(Date.now() < deadline, 'the reader never saw the other writer\'s policy')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })

  it('leaves no temp files behind after many writes', () => {
    const a = open()
    const b = open()
    for (let i = 0; i < 25; i += 1) {
      a.setPolicy(POLICIES[i % POLICIES.length])
      b.dshPanes.add(`w1:p${i % 5}`)
    }
    assert.deepEqual(leftovers(), [])
  })

  it('two real processes hammering one file never leave a torn or invalid document behind', { timeout: 60_000 }, async () => {
    const rounds = 80
    const script = `
      import { FleetStore } from ${JSON.stringify(STORE_URL)}
      const [file, role] = process.argv.slice(1)
      const store = new FleetStore({ file, maxStaleMs: 0 })
      const policies = ['all', 'dsh-only', 'read-only']
      for (let i = 0; i < ${rounds}; i += 1) {
        if (role === 'policy') store.setPolicy(policies[i % 3])
        else {
          store.dshPanes.add('w1:p' + (i % 7))
          if (i % 3 === 0) store.dshPanes.delete('w1:p' + ((i + 3) % 7))
        }
      }
    `
    const run = (role) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, role], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${role} writer exited ${code}: ${stderr}`))))
    })

    let finished = false
    const writers = Promise.all([run('policy'), run('panes')]).finally(() => { finished = true })
    let reads = 0
    const torn = []
    while (!finished) {
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch (error) {
        if (error.code === 'ENOENT') { await new Promise((resolve) => setImmediate(resolve)); continue }
        throw error
      }
      reads += 1
      try { JSON.parse(text) } catch { torn.push(text.slice(0, 40)) }
      await new Promise((resolve) => setImmediate(resolve))
    }
    await writers

    assert.deepEqual(torn, [], `${torn.length} of ${reads} reads saw a document that did not parse`)
    assert.ok(reads > 0, 'the reader overlapped the writers')
    const final = onDisk()
    assert.ok(POLICIES.includes(final.policy), final.policy)
    assert.ok(Array.isArray(final.dshPanes) && final.dshPanes.every((id) => /^w1:p[0-6]$/.test(id)), JSON.stringify(final.dshPanes))
    assert.deepEqual(leftovers(), [], 'every temp file was renamed away')
    const reopened = open()
    assert.equal(reopened.policy, final.policy)
    assert.equal(reopened.diagnostic, null)
  })
})
