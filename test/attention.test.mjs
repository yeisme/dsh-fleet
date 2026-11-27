import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import {
  ATTENTION_GROUPS, STALL_MS, attentionGroup, attentionOrder, formatElapsed, isSeen, isStalled, isUnread, sortByAttention,
} from '../lib/fleet/attention.js'

const SOURCE_URL = new URL('../lib/fleet/attention.js', import.meta.url)
const source = readFileSync(SOURCE_URL, 'utf8')
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/fleet.json', import.meta.url), 'utf8'))
const NOW = fixtures.now
const SEC = 1000
const MIN = 60 * SEC

/** A contract Pane (only the fields attention.js reads matter); an agent unless `agent: null` is passed. */
const pane = (overrides = {}) => ({
  id: 'w1:p1',
  agent: { kind: 'pi', name: null, display: 'pi', session: null, interactiveReady: true },
  status: 'idle',
  completionSeq: 0,
  stateSince: NOW - 10 * SEC,
  outputAt: NOW - 1 * SEC,
  ...overrides,
})
const shell = (overrides = {}) => pane({ agent: null, status: 'unknown', ...overrides })
const ctx = { now: NOW, stallMs: STALL_MS, seen: {} }
const ids = (panes) => panes.map((candidate) => candidate.id)

describe('STALL_MS', () => {
  it('is the 180 seconds the contract documents', () => {
    assert.equal(STALL_MS, 180 * SEC)
    assert.match(readFileSync(new URL('../docs/design/FLEET-API.md', import.meta.url), 'utf8'), /180\s*(?:s\b|秒)/)
  })
})

describe('isStalled', () => {
  it('is false at exactly STALL_MS of silence and true one millisecond later', () => {
    assert.equal(isStalled(pane({ status: 'working', outputAt: NOW - STALL_MS }), NOW), false)
    assert.equal(isStalled(pane({ status: 'working', outputAt: NOW - STALL_MS - 1 }), NOW), true)
    assert.equal(isStalled(pane({ status: 'working', outputAt: NOW - STALL_MS + 1 }), NOW), false)
  })

  it('needs a working agent that has produced output: never for an unknown last output, nor for any other status', () => {
    assert.equal(isStalled(pane({ status: 'working', outputAt: null }), NOW), false, 'outputAt null: nothing to measure from')
    assert.equal(isStalled(pane({ status: 'working', outputAt: undefined }), NOW), false)
    assert.equal(isStalled(pane({ status: 'working', outputAt: Number.NaN }), NOW), false)
    for (const status of ['blocked', 'done', 'idle', 'unknown']) {
      assert.equal(isStalled(pane({ status, outputAt: NOW - 10 * 60 * MIN }), NOW), false, status)
    }
  })

  it('takes the threshold as a parameter, and the clock as a default parameter', () => {
    const quiet = pane({ status: 'working', outputAt: NOW - 61 * SEC })
    assert.equal(isStalled(quiet, NOW, 60 * SEC), true)
    assert.equal(isStalled(quiet, NOW, 120 * SEC), false)
    assert.equal(isStalled(pane({ status: 'working', outputAt: Date.now() - STALL_MS - 5_000 })), true, 'default now = the real clock')
    assert.equal(isStalled(pane({ status: 'working', outputAt: Date.now() - 1_000 })), false)
  })

  it('agrees with the host-derived `stalled` flag of every fixture pane at the fixture clock', () => {
    let checked = 0
    for (const scenario of Object.values(fixtures.scenarios)) {
      for (const fixturePane of scenario.state.panes) {
        assert.equal(isStalled(fixturePane, scenario.state.now), fixturePane.stalled, fixturePane.id)
        checked += 1
      }
    }
    assert.ok(checked >= 10)
  })
})

describe('isSeen / isUnread (the read cursor lives in the browser: { [paneId]: last read completionSeq })', () => {
  it('unread = done and completionSeq above the cursor; a missing cursor is 0', () => {
    const done = pane({ id: 'w1:p9', status: 'done', completionSeq: 7 })
    assert.equal(isUnread(done, {}), true)
    assert.equal(isUnread(done, { 'w1:p9': 6 }), true)
    assert.equal(isUnread(done, { 'w1:p9': 7 }), false, 'cursor equal to completionSeq: read')
    assert.equal(isUnread(done, { 'w1:p9': 99 }), false)
    assert.equal(isSeen(done, { 'w1:p9': 7 }), true)
    assert.equal(isSeen(done, {}), false)
  })

  it('a pane that never completed anything (completionSeq 0) has nothing unread', () => {
    assert.equal(isUnread(pane({ status: 'done', completionSeq: 0 }), {}), false)
    assert.equal(isSeen(pane({ completionSeq: 0 }), {}), true)
  })

  it('only a done pane can be unread, whatever its sequence', () => {
    for (const status of ['working', 'blocked', 'idle', 'unknown']) assert.equal(isUnread(pane({ status, completionSeq: 5 }), {}), false, status)
  })

  it('a cursor that is not a number counts as "never read" and cannot be abused through object keys', () => {
    const done = pane({ id: 'constructor', status: 'done', completionSeq: 1 })
    for (const mark of ['9', null, undefined, Number.NaN, {}, [], true]) {
      assert.equal(isUnread(done, { constructor: mark }), true, String(mark))
    }
    assert.equal(isUnread(done, {}), true, 'inherited Object.prototype.constructor is not a cursor')
    assert.equal(isUnread(pane({ id: '__proto__', status: 'done', completionSeq: 1 }), {}), true)
    for (const seen of [undefined, null]) assert.equal(isUnread(pane({ status: 'done', completionSeq: 1 }), seen), true)
  })
})

describe('attentionGroup', () => {
  it('ranks: blocked 0, unread done 1, stalled 2, working 3, unknown 4, read done 5, idle 6, shell 7', () => {
    assert.deepEqual({ ...ATTENTION_GROUPS }, { blocked: 0, unread: 1, stalled: 2, working: 3, unknown: 4, read: 5, idle: 6, shell: 7 })
    assert.equal(attentionGroup(pane({ status: 'blocked' }), ctx), 0)
    assert.equal(attentionGroup(pane({ status: 'done', completionSeq: 5 }), ctx), 1)
    assert.equal(attentionGroup(pane({ status: 'working', outputAt: NOW - 5 * MIN }), ctx), 2)
    assert.equal(attentionGroup(pane({ status: 'working', outputAt: NOW - 1 * SEC }), ctx), 3)
    assert.equal(attentionGroup(pane({ status: 'unknown' }), ctx), 4)
    assert.equal(attentionGroup(pane({ status: 'done', completionSeq: 5 }), { ...ctx, seen: { 'w1:p1': 5 } }), 5)
    assert.equal(attentionGroup(pane({ status: 'idle' }), ctx), 6)
    assert.equal(attentionGroup(shell(), ctx), 7)
  })

  it('a stalled working agent is group 2 only past the threshold, and `stallMs` moves it', () => {
    assert.equal(attentionGroup(pane({ status: 'working', outputAt: NOW - STALL_MS }), ctx), 3)
    assert.equal(attentionGroup(pane({ status: 'working', outputAt: NOW - STALL_MS - 1 }), ctx), 2)
    assert.equal(attentionGroup(pane({ status: 'working', outputAt: NOW - 90 * SEC }), { ...ctx, stallMs: 60 * SEC }), 2)
    assert.equal(attentionGroup(pane({ status: 'working', outputAt: null }), ctx), 3, 'unknown last output is not stalled')
  })

  it('judges stalled-ness by the `now` it is given, not by the host\'s `stalled` flag', () => {
    const quiet = pane({ status: 'working', outputAt: NOW - 100 * SEC, stalled: false })
    assert.equal(attentionGroup(quiet, { ...ctx, now: NOW }), 3)
    assert.equal(attentionGroup(quiet, { ...ctx, now: NOW + 100 * SEC }), 2, 'the clock moved on, the pane did not speak')
  })

  it('a plain shell (agent null) is its own last rank, whatever its status, so it never outranks or mixes with agents', () => {
    for (const status of ['unknown', 'idle', 'working', 'blocked', 'done']) assert.equal(attentionGroup(shell({ status, completionSeq: 3 }), ctx), ATTENTION_GROUPS.shell, status)
    assert.ok(ATTENTION_GROUPS.shell > ATTENTION_GROUPS.idle)
  })

  it('only `agent === null` makes a shell: a partial pane without an agent key is ranked as the agent it describes', () => {
    const partial = { id: 'w1:p1', status: 'blocked' }
    assert.equal('agent' in partial, false)
    assert.equal(attentionGroup(partial, ctx), 0)
    assert.equal(attentionGroup({ ...partial, agent: null }, ctx), 7, 'the same pane with agent: null is a shell')
  })

  it('a status it does not recognise is "unknown" (rank 4), not "idle"', () => {
    assert.equal(attentionGroup(pane({ status: 'thinking' }), ctx), 4)
    assert.equal(attentionGroup(pane({ status: undefined }), ctx), 4)
  })

  it('reads the clock only as a default: the same call with the same inputs always gives the same answer', () => {
    const p = pane({ status: 'working', outputAt: NOW - 200 * SEC })
    assert.deepEqual([1, 2, 3].map(() => attentionGroup(p, ctx)), [2, 2, 2])
  })
})

describe('the busy fixture fleet', () => {
  const panes = fixtures.scenarios.busy.state.panes

  it('is ranked by need at the fixture clock: blocked, unread completion, stalled, working, unknown, idle, shells', () => {
    const order = sortByAttention(panes, { now: NOW, seen: {} })
    assert.deepEqual(ids(order), ['w1:p1', 'w1:p2', 'w2:p1', 'w1:p3', 'w2:p2', 'w3:p3', 'w3:p2', 'w3:p1', 'w2:p3', 'w1:p4'])
    assert.deepEqual(order.map((p) => attentionGroup(p, { now: NOW, seen: {} })), [0, 1, 2, 3, 3, 4, 6, 6, 7, 7])
  })

  it('a completion the user has read drops from rank 1 to rank 5, behind working and unknown agents', () => {
    const order = sortByAttention(panes, { now: NOW, seen: { 'w1:p2': 15 } })
    assert.deepEqual(ids(order), ['w1:p1', 'w2:p1', 'w1:p3', 'w2:p2', 'w3:p3', 'w1:p2', 'w3:p2', 'w3:p1', 'w2:p3', 'w1:p4'])
    assert.equal(attentionGroup(panes.find((p) => p.id === 'w1:p2'), { now: NOW, seen: { 'w1:p2': 15 } }), 5)
  })

  it('a newer completion is unread again even after an older one was read', () => {
    const codex = panes.find((p) => p.id === 'w1:p2')
    assert.equal(attentionGroup(codex, { now: NOW, seen: { 'w1:p2': 14 } }), 1)
    assert.equal(attentionGroup({ ...codex, completionSeq: 16 }, { now: NOW, seen: { 'w1:p2': 15 } }), 1)
  })

  it('shells sort after every agent even when they have been in their state longer than any agent', () => {
    const order = sortByAttention([shell({ id: 'a', stateSince: 1 }), pane({ id: 'b', status: 'idle', stateSince: NOW })], ctx)
    assert.deepEqual(ids(order), ['b', 'a'])
  })
})

describe('sortByAttention / attentionOrder', () => {
  it('puts blocked first and, inside a group, the pane that has been there longest (port of the orchestrator case)', () => {
    const older = pane({ id: 'w1:p2', status: 'blocked', stateSince: NOW - 60 * SEC })
    const newer = pane({ id: 'w1:p3', status: 'blocked', stateSince: NOW - 5 * SEC })
    const working = pane({ id: 'w1:p4', status: 'working' })
    assert.deepEqual(ids(sortByAttention([working, newer, older], ctx)), ['w1:p2', 'w1:p3', 'w1:p4'])
  })

  it('a pane whose start is unknown sorts after the ones that are known; ties fall back to the id in natural order', () => {
    const known = pane({ id: 'w9:p9', status: 'blocked', stateSince: NOW })
    const unknownSince = [null, undefined, Number.NaN].map((stateSince, index) => pane({ id: `w1:p${index + 1}`, status: 'blocked', stateSince }))
    assert.deepEqual(ids(sortByAttention([...unknownSince, known], ctx)), ['w9:p9', 'w1:p1', 'w1:p2', 'w1:p3'])
    const tied = ['w1:p10', 'w1:p2', 'w10:p1', 'w2:p1', 'w1:p1'].map((id) => pane({ id, status: 'blocked', stateSince: NOW }))
    assert.deepEqual(ids(sortByAttention(tied, ctx)), ['w1:p1', 'w1:p2', 'w1:p10', 'w2:p1', 'w10:p1'], "'p2' before 'p10', 'w2' before 'w10'")
  })

  it('is independent of the input order (every pane has a total order, so a host restart cannot make rows jump)', () => {
    const panes = fixtures.scenarios.busy.state.panes.map((p) => ({ ...p, stateSince: NOW - 5 * MIN })) // all tied, as right after a restart
    const expected = ids(sortByAttention(panes, ctx))
    const rotations = panes.map((_, index) => [...panes.slice(index), ...panes.slice(0, index)])
    for (const permutation of [...rotations, [...panes].reverse()]) assert.deepEqual(ids(sortByAttention(permutation, ctx)), expected)
  })

  it('is a consistent comparator: antisymmetric, and 0 only for the same pane', () => {
    const panes = fixtures.scenarios.busy.state.panes
    for (const a of panes) {
      for (const b of panes) {
        const forward = Math.sign(attentionOrder(a, b, ctx))
        assert.ok(forward === -Math.sign(attentionOrder(b, a, ctx)), `${a.id} vs ${b.id}`) // (=== so that 0 equals -0)
        if (a.id !== b.id) assert.notEqual(forward, 0, `${a.id} vs ${b.id}`)
      }
    }
  })

  it('returns a new array and leaves the input and its panes alone', () => {
    const input = [pane({ id: 'b', status: 'idle' }), pane({ id: 'a', status: 'blocked' })]
    const frozen = structuredClone(input)
    input.forEach(Object.freeze)
    Object.freeze(input)
    const output = sortByAttention(input, ctx)
    assert.notEqual(output, input)
    assert.deepEqual(input, frozen)
    assert.deepEqual(ids(output), ['a', 'b'])
    assert.equal(output[0], input[1], 'the same pane objects, re-ordered, not copies')
  })

  it('reads the clock once per sort, so a pane cannot turn stalled halfway through it', () => {
    const real = Date.now
    let calls = 0
    Date.now = () => { calls += 1; return NOW }
    try {
      sortByAttention(fixtures.scenarios.busy.state.panes)
    } finally {
      Date.now = real
    }
    assert.equal(calls, 1)
  })
})

describe('formatElapsed (port)', () => {
  it('covers each unit boundary and refuses what is not a duration', () => {
    assert.equal(formatElapsed(0), '0s')
    assert.equal(formatElapsed(999), '0s')
    assert.equal(formatElapsed(59_000), '59s')
    assert.equal(formatElapsed(60_000), '1m')
    assert.equal(formatElapsed(3_599_000), '59m')
    assert.equal(formatElapsed(3_600_000), '1h')
    assert.equal(formatElapsed(3_660_000), '1h 1m')
    assert.equal(formatElapsed(86_400_000), '1d')
    assert.equal(formatElapsed(3 * 86_400_000 + 5 * 3_600_000), '3d')
    for (const bad of [-1, Number.NaN, Infinity, null, undefined, '5000']) assert.equal(formatElapsed(bad), '—', String(bad))
  })
})

describe('attention.js stays browser-safe', () => {
  // The same source text without comments: what the code does, not what the comments mention.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '')

  it('imports nothing: no import, no require, no node: module, no Node globals', () => {
    assert.doesNotMatch(code, /^\s*import\s/m, 'static import')
    assert.doesNotMatch(code, /\bimport\s*\(/, 'dynamic import')
    assert.doesNotMatch(code, /\brequire\s*\(/)
    assert.doesNotMatch(code, /node:/)
    assert.doesNotMatch(code, /\b(?:process|Buffer|__dirname|__filename|globalThis\.process)\b/)
  })

  it('reads the clock only as a default parameter value', () => {
    const lines = code.split('\n').filter((line) => line.includes('Date.now'))
    assert.ok(lines.length >= 3, 'the defaults exist')
    for (const line of lines) assert.match(line, /^export function \w+\(.*\bnow = Date\.now\(\)/, `not a parameter default: ${line.trim()}`)
    assert.equal(lines.join('\n').match(/Date\.now/g).length, lines.length, 'one use per line, every one of them a default')
  })

  it('runs in a bare JavaScript realm that has no Node API at all', () => {
    const realm = vm.createContext({}) // language built-ins only (V8 adds a bare console, nothing from Node or a browser)
    assert.equal(vm.runInContext('[typeof require, typeof process, typeof Buffer, typeof setTimeout, typeof URL, typeof fetch].join()', realm), 'undefined,undefined,undefined,undefined,undefined,undefined')
    const api = vm.runInContext(`${source.replace(/^export /gm, '')}\n;({ STALL_MS, isStalled, attentionGroup, sortByAttention, formatElapsed })`, realm)
    assert.equal(api.STALL_MS, 180_000)
    assert.equal(api.isStalled({ status: 'working', outputAt: NOW - STALL_MS - 1 }, NOW), true)
    assert.equal(api.attentionGroup({ status: 'blocked', agent: {} }, { now: NOW }), 0)
    assert.equal(api.formatElapsed(3_660_000), '1h 1m')
    const sorted = [...api.sortByAttention(fixtures.scenarios.busy.state.panes, { now: NOW, seen: {} })]
    assert.deepEqual(ids(sorted), ['w1:p1', 'w1:p2', 'w2:p1', 'w1:p3', 'w2:p2', 'w3:p3', 'w3:p2', 'w3:p1', 'w2:p3', 'w1:p4'])
  })
})
