import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { EMPTY_SNAPSHOT } from '../lib/herdr/normalize.js'
import { loadContract, validateDef } from '../lib/fleet/schema.js'
import { POLICIES } from '../lib/fleet/writability.js'
import {
  AGENT_NAME, CONTRACT_PROTOCOL, STATUSES, SUMMARY_MAX, buildState, clipText, deriveSummary, stripAnsi,
} from '../lib/fleet/model.js'
import { createWorld } from './helpers/wire.js'
import { RAW_SESSION_VALUE, inputsFromState, snapshotFromWorld } from './helpers/fixture-world.js'

const contract = loadContract()
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/fleet.json', import.meta.url), 'utf8'))
const NOW = fixtures.now
const SEC = 1000
const MIN = 60 * SEC
const ESC = '\u001b'

const errorsOf = (state) => validateDef(contract, 'State', state).errors
const points = (value) => [...value].length

/* ------------------------------------------------------------------------------------------ small world */

const RAW = '/Users/demo/.sessions/secret-transcript.jsonl'
// herdr's own counters are WRONG on purpose (99 panes, 42 tabs): State must count the panes it actually carries.
const WORKSPACE = { id: 'w1', number: 1, label: 'alpha', focused: false, paneCount: 99, tabCount: 42, activeTabId: 'w1:t1', agentStatus: 'working' }
const TAB = { id: 'w1:t1', workspaceId: 'w1', number: 1, label: 'main', focused: false, paneCount: 99, agentStatus: 'working' }
const HEALTH = { connected: true, socket: '/Users/demo/.config/herdr/herdr.sock', version: '0.9.5', protocol: 22, lastOkAt: NOW - 800, error: null, session: null }

/** A normalized snapshot pane (lib/herdr/normalize.js), fully specified; override what a test is about. */
const pane = (overrides = {}) => ({
  id: 'w1:p1', workspaceId: 'w1', tabId: 'w1:t1', terminalId: 'term_00000001', focused: false,
  cwd: '/Users/demo/work', foregroundCwd: '/Users/demo/work/app', title: 'fix the build', label: null,
  agent: 'claude', displayAgent: 'claude · fix the build', agentName: 'dsh-fixer', agentStatus: 'working',
  agentSession: { agent: 'claude', kind: 'path', source: 'herdr:claude', value: RAW },
  interactiveReady: true, launchPending: false,
  revision: 41, completionSeq: 3, stateChangeSeq: 9, stateSince: NOW - 90 * SEC, outputAt: NOW - 5 * SEC,
  ...overrides,
})
const shell = (overrides = {}) => pane({
  id: 'w1:p9', agent: null, displayAgent: null, agentName: null, agentStatus: 'unknown', agentSession: null,
  interactiveReady: null, completionSeq: 0, stateChangeSeq: 0, title: 'zsh', ...overrides,
})
const snapshot = (panes, overrides = {}) => ({
  version: '0.9.5', protocol: 22, focused: { workspaceId: null, tabId: null, paneId: null },
  workspaces: [WORKSPACE], tabs: [TAB], panes, updatedAt: 0, revision: 0, ...overrides,
})
const inputs = (overrides = {}) => ({ snapshot: snapshot([pane()]), health: HEALTH, stale: false, policy: { write: 'all' }, now: NOW, summaries: {}, revision: 7, ...overrides })

/** buildState, with the one assertion that must hold for every output: it validates against the contract. */
function build(overrides = {}) {
  const state = buildState(inputs(overrides))
  assert.deepEqual(errorsOf(state), [], 'buildState must only emit what the contract allows')
  return state
}
const only = (paneOverrides, overrides = {}) => build({ snapshot: snapshot([pane(paneOverrides)]), ...overrides }).panes[0]

/* ------------------------------------------------------------------------------------------ conformance */

describe('conformance: buildState over the herdr wire world reproduces fixtures/fleet.json', () => {
  it('covers every scenario the contract documents (a new scenario is covered automatically by the loop below)', () => {
    for (const name of ['busy', 'blocked', 'calm', 'empty', 'offline', 'stale']) assert.ok(Object.hasOwn(fixtures.scenarios, name), name)
  })

  for (const [name, scenario] of Object.entries(fixtures.scenarios)) {
    const { state } = scenario

    it(`${name}: deep-equal to the fixture, and serialized byte for byte the same`, () => {
      const actual = buildState(inputsFromState(state))
      assert.deepStrictEqual(actual, state)
      assert.equal(JSON.stringify(actual), JSON.stringify(state), 'same keys in the same order: the SSE payload must be canonical')
    })

    it(`${name}: validates against the contract`, () => {
      assert.deepEqual(errorsOf(buildState(inputsFromState(state))), [])
    })
  }

  it('a world that never connected (EMPTY_SNAPSHOT) reproduces the offline fixture exactly', () => {
    const offline = fixtures.scenarios.offline.state
    const actual = buildState({ snapshot: EMPTY_SNAPSHOT, health: offline.health, stale: false, policy: { write: 'all' }, now: fixtures.now, summaries: {}, revision: 0 })
    assert.deepStrictEqual(actual, offline)
    assert.equal(JSON.stringify(actual), JSON.stringify(offline))
    assert.deepEqual(actual.panes, [])
    assert.deepEqual(actual.workspaces, [])
  })

  it('the wire session value is really in the world and never in the State (not a vacuous check)', () => {
    const busy = fixtures.scenarios.busy.state
    const given = inputsFromState(busy)
    const withSession = given.snapshot.panes.filter((candidate) => candidate.agentSession !== null)
    assert.ok(withSession.length >= 2)
    for (const candidate of withSession) assert.equal(candidate.agentSession.value, RAW_SESSION_VALUE(candidate.id))
    const text = JSON.stringify(buildState(given))
    assert.ok(!text.includes('/Users/demo/.sessions/'), 'the raw session value leaked')
    assert.ok(!text.includes('.jsonl'))
    assert.deepEqual(buildState(given).panes.find((candidate) => candidate.id === 'w2:p1').agent.session, { kind: 'path', source: 'herdr:pi' })
  })

  it('follows the live world: a status change and a completion in herdr show up in the next State', () => {
    const world = createWorld({ workspaces: [{ id: 'w1', label: 'alpha', tabs: [{ id: 'w1:t1', label: 'main', panes: [
      { id: 'w1:p1', title: 'worker', agent: { kind: 'claude', name: 'dsh-worker', status: 'working', display: 'claude · worker' } },
      { id: 'w1:p2', title: 'zsh' },
    ] }] }] })
    const tracking = { 'w1:p1': { stateSince: NOW - 30 * SEC, outputAt: NOW - 2 * SEC }, 'w1:p2': { stateSince: NOW - 60 * SEC, outputAt: NOW - 60 * SEC } }
    const before = build({ snapshot: snapshotFromWorld(world, tracking) })
    assert.deepEqual([before.counts.working, before.counts.done], [1, 0])
    world.update('w1:p1', { status: 'done' })
    const after = build({ snapshot: snapshotFromWorld(world, tracking) })
    assert.deepEqual([after.counts.working, after.counts.done, after.counts.agents, after.counts.shells, after.counts.panes], [0, 1, 1, 1, 2])
    assert.equal(after.panes[0].status, 'done')
    assert.equal(after.panes[0].completionSeq, before.panes[0].completionSeq + 1)
    assert.equal(after.panes[0].revision, before.panes[0].revision + 1)
  })
})

/* ------------------------------------------------------------------------------------------ fields */

describe('buildState: the envelope', () => {
  it('is the contract State: ok, protocol 1, the local machine, now as given, no extra keys', () => {
    const state = build()
    assert.deepEqual(Object.keys(state), ['ok', 'protocol', 'revision', 'now', 'stale', 'machine', 'health', 'policy', 'workspaces', 'panes', 'counts'])
    assert.equal(state.ok, true)
    assert.equal(state.protocol, 1)
    assert.equal(state.protocol, CONTRACT_PROTOCOL)
    assert.deepEqual(state.machine, { id: 'local', label: '本机' })
    assert.equal(state.now, NOW)
    assert.equal(state.revision, 7)
    assert.equal(state.stale, false)
  })

  it('protocol is the CONTRACT version, not herdr\'s own protocol number', () => {
    const state = build({ snapshot: snapshot([pane()], { protocol: 22 }), health: { ...HEALTH, protocol: 22 } })
    assert.equal(state.protocol, 1)
    assert.equal(state.health.protocol, 22)
  })

  it('the model\'s constants are the contract\'s', () => {
    assert.equal(CONTRACT_PROTOCOL, contract.$defs.State.properties.protocol.const)
    assert.equal(SUMMARY_MAX, contract.$defs.Pane.properties.summary.maxLength)
    assert.equal(AGENT_NAME.source, contract.$defs.AgentName.pattern)
    assert.deepEqual([...STATUSES], contract.$defs.Status.enum)
    assert.deepEqual([...POLICIES].sort(), [...contract.$defs.Policy.properties.write.enum].sort())
    assert.equal(validateDef(contract, 'Machine', build().machine).ok, true)
  })

  it('revision is the caller\'s counter; without one it falls back to the snapshot\'s own, then to 0', () => {
    assert.equal(build({ revision: 5821 }).revision, 5821)
    assert.equal(build({ revision: 0 }).revision, 0)
    assert.equal(build({ revision: undefined, snapshot: snapshot([pane()], { revision: 12 }) }).revision, 12)
    for (const junk of [-1, 1.5, Number.NaN, '7', null]) assert.equal(build({ revision: junk }).revision, 0, String(junk))
  })

  it('now: whole milliseconds are kept, fractions floored, and a value that is not a time is a TypeError (a caller bug, not data)', () => {
    assert.equal(build({ now: NOW + 0.9 }).now, NOW)
    for (const junk of [Number.NaN, -1, Infinity, '123', null]) assert.throws(() => buildState(inputs({ now: junk })), TypeError, String(junk))
    const before = Date.now()
    const defaulted = buildState({ snapshot: snapshot([pane()]), health: HEALTH, stale: false, policy: { write: 'all' } })
    assert.ok(defaulted.now >= before && defaulted.now <= Date.now(), 'omitted now defaults to the clock')
    assert.deepEqual(errorsOf(defaulted), [])
  })

  it('with nothing at all it still returns a valid, empty, disconnected, read-only State', () => {
    const state = buildState()
    assert.deepEqual(errorsOf(state), [])
    assert.deepEqual([state.panes, state.workspaces, state.stale, state.health.connected, state.policy], [[], [], false, false, { write: 'read-only' }])
    assert.deepEqual(state.counts, { blocked: 0, done: 0, working: 0, idle: 0, unknown: 0, agents: 0, shells: 0, panes: 0 })
  })
})

describe('buildState: one pane, field by field', () => {
  it('maps a fully specified herdr pane onto the contract Pane', () => {
    assert.deepEqual(build().panes[0], {
      id: 'w1:p1',
      workspaceId: 'w1',
      tabId: 'w1:t1',
      workspaceLabel: 'alpha',
      tabLabel: 'main',
      title: 'fix the build',
      cwd: '/Users/demo/work/app',
      focused: false,
      agent: { kind: 'claude', name: 'dsh-fixer', display: 'claude · fix the build', session: { kind: 'path', source: 'herdr:claude' }, interactiveReady: true },
      status: 'working',
      stalled: false,
      completionSeq: 3,
      stateChangeSeq: 9,
      stateSince: NOW - 90 * SEC,
      outputAt: NOW - 5 * SEC,
      revision: 41,
      summary: '',
      summarySource: 'none',
      writable: true,
      writableReason: null,
    })
  })

  it('title falls back to an empty string; cwd prefers the foreground cwd, then cwd, then an empty string', () => {
    assert.equal(only({ title: null }).title, '')
    assert.equal(only({ title: '' }).title, '')
    assert.equal(only({ title: 42 }).title, '')
    assert.equal(only({ title: '✳ 带符号' }).title, '✳ 带符号', 'herdr\'s stripped title is taken as is; stripping is herdr\'s job')
    assert.equal(only({ foregroundCwd: '/a', cwd: '/b' }).cwd, '/a')
    assert.equal(only({ foregroundCwd: null, cwd: '/b' }).cwd, '/b')
    assert.equal(only({ foregroundCwd: '', cwd: '/b' }).cwd, '/b')
    assert.equal(only({ foregroundCwd: null, cwd: null }).cwd, '')
    assert.equal(only({ foregroundCwd: undefined, cwd: 7 }).cwd, '')
  })

  it('an agent name that does not match the contract pattern becomes null, never a value outside the contract', () => {
    const valid = ['dsh-reviewer', 'a', 'a'.repeat(32), 'ok_name-1', 'x9']
    const invalid = ['a'.repeat(33), 'Reviewer', '1abc', '-abc', 'has space', '', 'ünï', 'trailing\n', 'a.b', '审查员', null, undefined, 7]
    for (const name of valid) assert.equal(only({ agentName: name }).agent.name, name, name)
    for (const name of invalid) assert.equal(only({ agentName: name }).agent.name, null, String(name))
  })

  it('display falls back to the kind when herdr gave none', () => {
    assert.equal(only({ displayAgent: null }).agent.display, 'claude')
    assert.equal(only({ displayAgent: '' }).agent.display, 'claude')
    assert.equal(only({ displayAgent: 'claude · x' }).agent.display, 'claude · x')
  })

  it('the agent session is reduced to { kind, source }: the raw value (a path or id) never reaches the browser', () => {
    const state = build({ snapshot: snapshot([pane()]) })
    assert.deepEqual(state.panes[0].agent.session, { kind: 'path', source: 'herdr:claude' })
    assert.ok(!JSON.stringify(state).includes(RAW), 'the raw session value leaked into the State')
    assert.ok(!JSON.stringify(state).includes('secret-transcript'))
    assert.equal(only({ agentSession: null }).agent.session, null)
    for (const partial of [{ kind: null, source: 's', value: RAW }, { kind: 'path', source: null, value: RAW }, 'a string', 7, []]) {
      assert.equal(only({ agentSession: partial }).agent.session, null, JSON.stringify(partial))
    }
  })

  it('interactiveReady is a boolean or null', () => {
    assert.equal(only({ interactiveReady: true }).agent.interactiveReady, true)
    assert.equal(only({ interactiveReady: false }).agent.interactiveReady, false)
    for (const junk of [null, undefined, 'yes', 1]) assert.equal(only({ interactiveReady: junk }).agent.interactiveReady, null, String(junk))
  })

  it('a status outside the five becomes "unknown"; the five pass through', () => {
    for (const status of STATUSES) assert.equal(only({ agentStatus: status }).status, status)
    for (const junk of ['thinking', 'WORKING', '', null, undefined, 3, {}]) assert.equal(only({ agentStatus: junk }).status, 'unknown', String(junk))
  })

  it('sequences and revision are whole numbers >= 0, repaired to 0 otherwise', () => {
    const repaired = only({ completionSeq: -1, stateChangeSeq: 2.5, revision: Number.NaN })
    assert.deepEqual([repaired.completionSeq, repaired.stateChangeSeq, repaired.revision], [0, 0, 0])
    const kept = only({ completionSeq: 0, stateChangeSeq: 12, revision: 99 })
    assert.deepEqual([kept.completionSeq, kept.stateChangeSeq, kept.revision], [0, 12, 99])
  })

  it('stateSince and outputAt are instants: kept, floored, or (stateSince) "since now" / (outputAt) null when unknown', () => {
    const kept = only({ stateSince: NOW - 5 * MIN, outputAt: NOW - 4 * MIN })
    assert.deepEqual([kept.stateSince, kept.outputAt], [NOW - 5 * MIN, NOW - 4 * MIN])
    const unobserved = only({ stateSince: null, outputAt: null })
    assert.deepEqual([unobserved.stateSince, unobserved.outputAt], [NOW, null], 'never observed: first seen now, not 1970')
    const fractional = only({ stateSince: NOW - 0.5, outputAt: NOW - 1000.7 })
    assert.deepEqual([fractional.stateSince, fractional.outputAt], [NOW - 1, NOW - 1001])
    for (const junk of [-5, Number.NaN, Infinity, '1800000000000']) {
      const repaired = only({ stateSince: junk, outputAt: junk })
      assert.deepEqual([repaired.stateSince, repaired.outputAt], [NOW, null], String(junk))
    }
  })
})

describe('buildState: stalled', () => {
  const working = (outputAt, extra = {}) => only({ agentStatus: 'working', outputAt, ...extra })

  it('is false at exactly 180000 ms of silence and true at 180001', () => {
    assert.equal(working(NOW - 180_000).stalled, false)
    assert.equal(working(NOW - 180_001).stalled, true)
    assert.equal(working(NOW - 179_999).stalled, false)
    assert.equal(working(NOW - 10 * MIN).stalled, true)
  })

  it('an agent whose output has never been observed (outputAt null) is never stalled', () => {
    assert.equal(working(null).stalled, false)
    assert.equal(working(undefined).stalled, false)
    assert.equal(working(null, { stateSince: NOW - 60 * MIN }).stalled, false, 'however long it has been working')
  })

  it('only a working agent can be stalled', () => {
    for (const status of ['blocked', 'done', 'idle', 'unknown']) assert.equal(only({ agentStatus: status, outputAt: NOW - 60 * MIN }).stalled, false, status)
    assert.equal(build({ snapshot: snapshot([shell({ agentStatus: 'working', outputAt: NOW - 60 * MIN })]) }).panes[0].stalled, false, 'a shell has no status to stall in')
  })

  it('is measured against the `now` it is given', () => {
    const quiet = snapshot([pane({ agentStatus: 'working', outputAt: NOW - 100 * SEC })])
    assert.equal(build({ snapshot: quiet, now: NOW }).panes[0].stalled, false)
    assert.equal(build({ snapshot: quiet, now: NOW + 81 * SEC }).panes[0].stalled, true)
  })
})

describe('buildState: shells', () => {
  const mixed = () => build({ snapshot: snapshot([pane({ id: 'w1:p1', agentStatus: 'working' }), shell({ id: 'w1:p2', agentStatus: 'working' }), shell({ id: 'w1:p3' }), pane({ id: 'w1:p4', agentStatus: 'idle' })]) })

  it('has agent null, status unknown whatever herdr says, and is read-only for being a shell', () => {
    const [, working, plain] = mixed().panes
    for (const candidate of [working, plain]) {
      assert.equal(candidate.agent, null)
      assert.equal(candidate.status, 'unknown')
      assert.equal(candidate.stalled, false)
      assert.deepEqual([candidate.writable, candidate.writableReason], [false, 'not-an-agent'])
    }
  })

  it('is left out of the per-status counts and the agent count, and counted in shells and panes', () => {
    assert.deepEqual(mixed().counts, { blocked: 0, done: 0, working: 1, idle: 1, unknown: 0, agents: 2, shells: 2, panes: 4 })
  })

  it('an agent whose status is unknown IS counted under unknown (it is an agent that herdr could not read)', () => {
    const counts = build({ snapshot: snapshot([pane({ agentStatus: 'unknown' }), shell()]) }).counts
    assert.deepEqual([counts.unknown, counts.agents, counts.shells, counts.panes], [1, 1, 1, 2])
  })

  it('an empty-string agent kind is a shell, not an agent of no kind', () => {
    const candidate = only({ agent: '' })
    assert.equal(candidate.agent, null)
    assert.equal(candidate.writableReason, 'not-an-agent')
  })
})

describe('buildState: workspaces and counts come from the panes', () => {
  it('counts panes and distinct tabs per workspace itself, ignoring herdr\'s counters', () => {
    const state = build({ snapshot: snapshot([pane({ id: 'w1:p1' }), pane({ id: 'w1:p2' }), pane({ id: 'w1:p3', tabId: 'w1:t2' })], { tabs: [TAB, { ...TAB, id: 'w1:t2', label: 'second' }] }) })
    assert.deepEqual(state.workspaces, [{ id: 'w1', label: 'alpha', focused: false, paneCount: 3, tabCount: 2 }])
    assert.deepEqual(state.panes.map((candidate) => candidate.tabLabel), ['main', 'main', 'second'])
  })

  it('lists workspaces in herdr\'s order, drops those without a pane, and appends one herdr did not list', () => {
    const state = build({
      snapshot: snapshot(
        [pane({ id: 'w1:p1', workspaceId: 'w1' }), pane({ id: 'w2:p1', workspaceId: 'w2', tabId: 'w2:t1' }), pane({ id: 'w9:p1', workspaceId: 'w9', tabId: 'w9:t1' })],
        { workspaces: [{ ...WORKSPACE, id: 'w2', label: 'beta' }, { ...WORKSPACE, id: 'w3', label: 'empty one' }, WORKSPACE] },
      ),
    })
    assert.deepEqual(state.workspaces.map((workspace) => [workspace.id, workspace.label]), [['w2', 'beta'], ['w1', 'alpha'], ['w9', 'w9']])
  })

  it('labels come from herdr; an unlisted or empty one falls back to the id, which is real text', () => {
    const state = build({ snapshot: snapshot([pane({ id: 'w1:p1' }), pane({ id: 'w5:p1', workspaceId: 'w5', tabId: 'w5:t1' })], { workspaces: [{ ...WORKSPACE, label: '' }], tabs: [{ ...TAB, label: '' }] }) })
    assert.deepEqual(state.panes.map((candidate) => [candidate.workspaceLabel, candidate.tabLabel]), [['w1', 'w1:t1'], ['w5', 'w5:t1']])
  })

  it('counts the five statuses over agents only, and the total over everything', () => {
    const statuses = ['blocked', 'done', 'done', 'working', 'idle', 'idle', 'idle', 'unknown']
    const panes = [...statuses.map((agentStatus, index) => pane({ id: `w1:p${index + 1}`, agentStatus })), shell({ id: 'w1:p20' })]
    assert.deepEqual(build({ snapshot: snapshot(panes) }).counts, { blocked: 1, done: 2, working: 1, idle: 3, unknown: 1, agents: 8, shells: 1, panes: 9 })
  })

  it('keeps the snapshot\'s pane order: it does not sort, group or reverse', () => {
    const order = ['w2:p1', 'w1:p2', 'w1:p1', 'w1:p10']
    const panes = order.map((id) => pane({ id, workspaceId: id.startsWith('w2') ? 'w2' : 'w1', tabId: id.startsWith('w2') ? 'w2:t1' : 'w1:t1' }))
    assert.deepEqual(build({ snapshot: snapshot(panes) }).panes.map((candidate) => candidate.id), order)
  })

  it('a pane that cannot carry the contract\'s identity fields is left out instead of breaking the State', () => {
    const state = build({ snapshot: snapshot([
      pane({ id: 'w1:p1' }), pane({ id: '' }), pane({ id: null }), pane({ id: 'x'.repeat(65) }), pane({ id: 'w1:p5', workspaceId: undefined }), pane({ id: 'w1:p6', tabId: '' }), null, 'junk',
      pane({ id: '😀'.repeat(64) }), pane({ id: 'w1:p7' }),
    ]) })
    assert.deepEqual(state.panes.map((candidate) => candidate.id), ['w1:p1', '😀'.repeat(64), 'w1:p7'], '64 code points is the limit, not 64 UTF-16 units')
    assert.equal(state.counts.panes, 3)
    assert.equal(state.workspaces[0].paneCount, 3)
  })
})

describe('buildState: focus', () => {
  it('a workspace is focused when one of its panes is, and at most one pane is', () => {
    const panes = [pane({ id: 'w1:p1' }), pane({ id: 'w2:p1', workspaceId: 'w2', tabId: 'w2:t1' }), pane({ id: 'w2:p2', workspaceId: 'w2', tabId: 'w2:t1' })]
    const state = build({ snapshot: snapshot(panes, { focused: { workspaceId: 'w2', tabId: 'w2:t1', paneId: 'w2:p2' }, workspaces: [WORKSPACE, { ...WORKSPACE, id: 'w2' }] }) })
    assert.deepEqual(state.panes.map((candidate) => candidate.focused), [false, false, true])
    assert.deepEqual(state.workspaces.map((workspace) => [workspace.id, workspace.focused]), [['w1', false], ['w2', true]])
  })

  it('herdr\'s session-level focus decides even when several panes carry a focused flag (a per-tab flag would otherwise show two)', () => {
    const panes = [pane({ id: 'w1:p1', focused: true }), pane({ id: 'w1:p2', focused: true }), pane({ id: 'w1:p3', focused: true })]
    const state = build({ snapshot: snapshot(panes, { focused: { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p2' } }) })
    assert.deepEqual(state.panes.map((candidate) => candidate.focused), [false, true, false])
  })

  it('without a session-level focus the first flagged pane is the focused one; with none flagged, nothing is', () => {
    const flagged = build({ snapshot: snapshot([pane({ id: 'w1:p1' }), pane({ id: 'w1:p2', focused: true }), pane({ id: 'w1:p3', focused: true })]) })
    assert.deepEqual(flagged.panes.map((candidate) => candidate.focused), [false, true, false])
    const none = build({ snapshot: snapshot([pane({ id: 'w1:p1' })]) })
    assert.deepEqual([none.panes[0].focused, none.workspaces[0].focused], [false, false])
  })

  it('a session-level focus on a pane that is not in the State focuses nothing', () => {
    const state = build({ snapshot: snapshot([pane({ id: 'w1:p1', focused: true })], { focused: { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p404' } }) })
    assert.equal(state.panes[0].focused, false)
    assert.equal(state.workspaces[0].focused, false)
  })
})

describe('buildState: summaries', () => {
  const summaries = (entry) => ({ 'w1:p1': entry })

  it('come from the summaries map by pane id; a pane without an entry has an empty summary from no source', () => {
    const state = build({ snapshot: snapshot([pane({ id: 'w1:p1' }), pane({ id: 'w1:p2' })]), summaries: summaries({ text: 'running the tests', source: 'transcript' }) })
    assert.deepEqual([state.panes[0].summary, state.panes[0].summarySource], ['running the tests', 'transcript'])
    assert.deepEqual([state.panes[1].summary, state.panes[1].summarySource], ['', 'none'])
    assert.equal(build({ summaries: { 'w1:p1': { text: 'from the screen', source: 'screen' } } }).panes[0].summarySource, 'screen')
  })

  it('is cut to 240 code points with an ellipsis: 240 stay whole, 241 become 239 + "…"', () => {
    const at = (text) => build({ summaries: summaries({ text, source: 'transcript' }) }).panes[0].summary
    assert.equal(at('x'.repeat(240)), 'x'.repeat(240))
    assert.equal(at('x'.repeat(241)), `${'x'.repeat(239)}…`)
    assert.equal(at('x'.repeat(5000)), `${'x'.repeat(239)}…`)
    assert.equal(points(at('x'.repeat(241))), 240)
  })

  it('is cut by code point: CJK stays whole, and an emoji is never split into a lone surrogate', () => {
    const at = (text) => build({ summaries: summaries({ text, source: 'screen' }) }).panes[0].summary
    assert.equal(at('长'.repeat(300)), `${'长'.repeat(239)}…`)
    assert.equal(at('𠮷'.repeat(300)), `${'𠮷'.repeat(239)}…`, 'an astral CJK character is one code point of two UTF-16 units')
    assert.equal(at('😀'.repeat(300)), `${'😀'.repeat(239)}…`)
    assert.equal(at('😀'.repeat(240)), '😀'.repeat(240), 'exactly 240 emoji fit although they take 480 UTF-16 units')
    // 238 letters then emoji: a cut at UTF-16 unit 239 would land inside the first emoji.
    const edge = at(`${'x'.repeat(238)}😀😀😀`)
    assert.equal(edge, `${'x'.repeat(238)}😀…`)
    assert.ok(edge.isWellFormed(), 'no lone surrogate')
    for (const text of ['长'.repeat(300), '😀'.repeat(300), `${'x'.repeat(238)}😀😀😀`, `a${'😀'.repeat(300)}`]) {
      const cut = at(text)
      assert.ok(cut.isWellFormed(), 'well-formed UTF-16')
      assert.equal(points(cut), 240)
      assert.equal(validateDef(contract, 'Pane', build({ summaries: summaries({ text, source: 'screen' }) }).panes[0]).ok, true)
    }
  })

  it('an entry that is not a usable summary says nothing instead of guessing a source or keeping orphan text', () => {
    const empty = { summary: '', summarySource: 'none' }
    const read = (entry) => { const [p] = build({ summaries: summaries(entry) }).panes; return { summary: p.summary, summarySource: p.summarySource } }
    for (const entry of [
      { text: 'text without a source', source: 'none' }, { text: 'text', source: 'guess' }, { text: 'text' }, { source: 'screen' },
      { text: '', source: 'screen' }, { text: '   \n ', source: 'transcript' }, { text: 7, source: 'screen' }, null, 'text', 5,
    ]) assert.deepEqual(read(entry), empty, JSON.stringify(entry))
    for (const junk of [null, undefined, 'x', 3, []]) assert.deepEqual(build({ summaries: junk }).panes[0].summary, '', String(junk))
  })

  it('looks up own keys only: a pane called "constructor" or "__proto__" gets no summary from Object.prototype', () => {
    const state = build({ snapshot: snapshot([pane({ id: 'constructor' }), pane({ id: '__proto__' }), pane({ id: 'toString' })]), summaries: {} })
    assert.deepEqual(state.panes.map((candidate) => [candidate.summary, candidate.summarySource]), [['', 'none'], ['', 'none'], ['', 'none']])
  })

  it('an INHERITED entry is not a summary either (the lookup cannot be steered through a prototype)', () => {
    const inherited = Object.create({ 'w1:p1': { text: 'from the prototype', source: 'screen' } })
    assert.equal(inherited['w1:p1'].text, 'from the prototype', 'control: the entry is reachable the naive way')
    const [candidate] = build({ summaries: inherited }).panes
    assert.deepEqual([candidate.summary, candidate.summarySource], ['', 'none'])
    const own = build({ summaries: Object.assign(Object.create({ 'w1:p1': { text: 'inherited', source: 'screen' } }), { 'w1:p1': { text: 'own', source: 'transcript' } }) }).panes[0]
    assert.deepEqual([own.summary, own.summarySource], ['own', 'transcript'], 'an own entry still wins')
  })
})

describe('buildState: who may write (writability.js, shared with the act pipeline)', () => {
  const agents = () => snapshot([pane({ id: 'w1:p1' }), pane({ id: 'w1:p2', agentStatus: 'idle' }), shell({ id: 'w1:p3' })])
  const flags = (state) => state.panes.map((candidate) => [candidate.writable, candidate.writableReason])

  it('under "all" every agent is writable while connected, and a shell never is', () => {
    assert.deepEqual(flags(build({ snapshot: agents() })), [[true, null], [true, null], [false, 'not-an-agent']])
  })

  it('read-only locks every agent with policy-read-only', () => {
    const state = build({ snapshot: agents(), policy: { write: 'read-only' } })
    assert.deepEqual(flags(state), [[false, 'policy-read-only'], [false, 'policy-read-only'], [false, 'not-an-agent']])
    assert.deepEqual(state.policy, { write: 'read-only' })
  })

  it('dsh-only allows exactly the panes DSH created (a Set or an array), and does not publish the list', () => {
    for (const dshPanes of [new Set(['w1:p2']), ['w1:p2']]) {
      const state = build({ snapshot: agents(), policy: { write: 'dsh-only', dshPanes } })
      assert.deepEqual(flags(state), [[false, 'policy-dsh-only'], [true, null], [false, 'not-an-agent']])
      assert.deepEqual(state.policy, { write: 'dsh-only' }, 'State.policy is { write } and nothing else')
    }
    assert.deepEqual(flags(build({ snapshot: agents(), policy: { write: 'dsh-only' } })).map(([, reason]) => reason), ['policy-dsh-only', 'policy-dsh-only', 'not-an-agent'], 'no registry: nothing is DSH-created')
    assert.deepEqual(flags(build({ snapshot: agents(), policy: { write: 'dsh-only', dshPanes: 'w1:p2' } })).map(([, reason]) => reason), ['policy-dsh-only', 'policy-dsh-only', 'not-an-agent'], 'junk registry: nothing is DSH-created')
  })

  it('a disconnected herdr makes agents read-only with the transient reason "offline"', () => {
    const down = { ...HEALTH, connected: false, error: 'connect ENOENT' }
    assert.deepEqual(flags(build({ snapshot: agents(), health: down })), [[false, 'offline'], [false, 'offline'], [false, 'not-an-agent']])
  })

  it('a stale State is offline even if the flag says connected, and either flag alone is enough', () => {
    assert.deepEqual(flags(build({ snapshot: agents(), stale: true })).map(([, reason]) => reason), ['offline', 'offline', 'not-an-agent'])
    assert.equal(build({ snapshot: agents(), stale: true }).stale, true)
  })

  it('an intrinsic reason outranks an outage: policy and not-an-agent are not hidden by "offline"', () => {
    const down = { ...HEALTH, connected: false, error: 'gone' }
    assert.deepEqual(flags(build({ snapshot: agents(), health: down, stale: true, policy: { write: 'read-only' } })).map(([, reason]) => reason), ['policy-read-only', 'policy-read-only', 'not-an-agent'])
    assert.deepEqual(flags(build({ snapshot: agents(), health: down, stale: true, policy: { write: 'dsh-only', dshPanes: new Set(['w1:p1']) } })).map(([, reason]) => reason), ['offline', 'policy-dsh-only', 'not-an-agent'])
  })

  it('fails closed: a missing or unknown policy is published AND enforced as read-only', () => {
    for (const policy of [undefined, null, {}, { write: undefined }, { write: 'ALL' }, { write: 'write' }, { write: '' }, { write: null }, { write: 3 }, 'all']) {
      const state = build({ snapshot: agents(), policy })
      assert.deepEqual(state.policy, { write: 'read-only' }, JSON.stringify(policy))
      assert.deepEqual(flags(state).map(([, reason]) => reason), ['policy-read-only', 'policy-read-only', 'not-an-agent'], JSON.stringify(policy))
    }
  })

  it('writable and writableReason always agree', () => {
    for (const policy of POLICIES) {
      for (const connected of [true, false]) {
        for (const stale of [true, false]) {
          const state = build({ snapshot: agents(), policy: { write: policy, dshPanes: ['w1:p1'] }, health: { ...HEALTH, connected, error: connected ? null : 'x' }, stale })
          for (const candidate of state.panes) assert.equal(candidate.writable, candidate.writableReason === null, `${policy} ${connected} ${stale} ${candidate.id}`)
        }
      }
    }
  })
})

describe('buildState: health', () => {
  it('is published as the contract\'s seven fields, copied', () => {
    const state = build()
    assert.deepEqual(state.health, HEALTH)
    assert.notEqual(state.health, HEALTH)
    assert.deepEqual(Object.keys(state.health), ['connected', 'socket', 'version', 'protocol', 'lastOkAt', 'error', 'session'])
  })

  it('drops fields the contract does not have, and repairs values of the wrong type to the contract\'s "unknown"', () => {
    assert.deepEqual(build({ health: { ...HEALTH, extra: 1, debug: { a: 1 } } }).health, HEALTH)
    assert.deepEqual(
      build({ health: { connected: 'yes', socket: 5, version: undefined, protocol: -1, lastOkAt: -5, error: {}, session: 7 } }).health,
      { connected: false, socket: null, version: null, protocol: null, lastOkAt: null, error: null, session: null },
    )
    assert.equal(build({ health: { ...HEALTH, lastOkAt: NOW - 0.5 } }).health.lastOkAt, NOW - 1)
  })

  it('a missing health is "not connected", so every agent is read-only', () => {
    const state = build({ health: undefined })
    assert.equal(state.health.connected, false)
    assert.equal(state.panes[0].writableReason, 'offline')
  })
})

describe('buildState: purity', () => {
  const deepFreeze = (value) => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze) }
    return value
  }
  const world = () => inputsFromState(fixtures.scenarios.busy.state, { policy: { write: 'dsh-only', dshPanes: new Set(['w1:p1']) } })

  it('does not mutate anything it is given (frozen inputs are enough to prove it)', () => {
    const given = deepFreeze(world())
    const dshBefore = [...given.policy.dshPanes]
    const copy = structuredClone({ ...given, policy: { write: given.policy.write } })
    const state = buildState(given)
    assert.deepEqual(errorsOf(state), [])
    assert.deepEqual({ ...given, policy: { write: given.policy.write } }, copy)
    assert.deepEqual([...given.policy.dshPanes], dshBefore)
    assert.doesNotThrow(() => buildState({ snapshot: EMPTY_SNAPSHOT, health: HEALTH, stale: false, policy: { write: 'all' }, now: NOW, summaries: Object.freeze({}), revision: 0 }))
  })

  it('is deterministic: the same inputs give the same State and the same bytes, call after call', () => {
    const first = buildState(world())
    for (let run = 0; run < 3; run += 1) {
      const again = buildState(world())
      assert.deepStrictEqual(again, first)
      assert.equal(JSON.stringify(again), JSON.stringify(first))
    }
  })

  it('shares no object with its inputs or with its other results: mutating a result changes nothing else', () => {
    const given = world()
    const first = buildState(given)
    const second = buildState(given)
    const pristine = structuredClone(first)
    first.panes[0].agent.name = 'mutated'
    first.panes[0].agent.session = { kind: 'x', source: 'y' }
    first.workspaces[0].label = 'mutated'
    first.health.error = 'mutated'
    first.machine.label = 'mutated'
    first.counts.panes = -1
    first.policy.write = 'mutated'
    assert.deepEqual(second, pristine, 'an earlier result must not be reachable through a later one')
    assert.deepEqual(buildState(world()), pristine, 'nor through module-level state')
    assert.notEqual(given.snapshot.panes[0].agentName, 'mutated')
    assert.equal(given.health.error, null)
    assert.equal(given.policy.write, 'dsh-only')
  })
})

/* ------------------------------------------------------------------------------------------ never outside the contract */

describe('buildState never emits anything the contract does not allow', () => {
  // Deterministic junk (mulberry32): the same 400 hostile snapshots every run.
  const random = (seed) => () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const strings = ['', 'x', 'w1', 'w1:t1', 'Bad Name', 'dsh-worker', 'a'.repeat(70), '😀'.repeat(40), '\n', '长'.repeat(300), 'working', 'path']
  const numbers = [0, 1, 41, -1, 1.5, Number.NaN, Infinity, 1e15, NOW, NOW + 1, NOW - 200_000]
  const others = [null, undefined, true, false, {}, [], () => 1]

  it('survives 400 snapshots of hostile data: no throw, a valid State, and the State agrees with itself', () => {
    const next = random(20261127)
    const pick = (list) => list[Math.floor(next() * list.length)]
    const any = () => pick([pick(strings), pick(numbers), pick(others)])
    const maybe = (good, chance = 0.6) => (next() < chance ? good : any())
    for (let round = 0; round < 400; round += 1) {
      const panes = Array.from({ length: Math.floor(next() * 9) }, (_, index) => ({
        id: maybe(`w${1 + (index % 3)}:p${index}`, 0.8),
        workspaceId: maybe(`w${1 + (index % 3)}`, 0.85),
        tabId: maybe(`w${1 + (index % 3)}:t${index % 2}`, 0.85),
        focused: any(),
        cwd: any(), foregroundCwd: any(), title: any(), label: any(),
        agent: maybe(pick(['claude', 'pi', 'codex', null]), 0.5),
        displayAgent: any(), agentName: maybe(pick(['dsh-a', 'ok_1', null]), 0.5),
        agentStatus: maybe(pick(STATUSES), 0.6),
        agentSession: maybe(pick([null, { agent: 'claude', kind: 'path', source: 'herdr:claude', value: RAW }, { kind: 1 }]), 0.5),
        interactiveReady: any(), launchPending: any(),
        revision: maybe(index, 0.6), completionSeq: maybe(index, 0.6), stateChangeSeq: maybe(index, 0.6),
        stateSince: maybe(NOW - 1000, 0.6), outputAt: maybe(NOW - 200_000, 0.6),
      }))
      panes.push(pick([null, undefined, 'junk', 7, []]))
      const given = {
        snapshot: next() < 0.1 ? any() : {
          focused: maybe({ workspaceId: 'w1', tabId: 'w1:t1', paneId: pick(['w1:p0', 'w2:p1', null]) }, 0.5),
          workspaces: maybe([{ id: 'w1', label: any() }, null, { id: 'w2', label: 'two' }, { label: 'no id' }], 0.5),
          tabs: maybe([{ id: 'w1:t0', label: any() }, null, { id: 'w2:t1', label: 'tab' }], 0.5),
          panes: next() < 0.05 ? any() : panes,
          revision: any(),
        },
        health: maybe({ ...HEALTH, connected: pick([true, false, 'yes']), extra: 1 }, 0.5),
        stale: any(),
        policy: maybe({ write: pick([...POLICIES, 'bogus', null]), dshPanes: pick([new Set(['w1:p0']), ['w1:p1'], null, 'w1:p2']) }, 0.5),
        now: pick([NOW, NOW + 0.7, 0, 1e12]),
        summaries: maybe({ 'w1:p0': { text: pick(strings), source: pick(['transcript', 'screen', 'none', 'x']) }, 'w1:p1': pick([null, 'text', { text: 5 }]) }, 0.5),
        revision: any(),
      }
      const state = buildState(given)
      const label = `round ${round}`
      assert.deepEqual(errorsOf(state), [], label)

      // ... and it agrees with itself the way test/contract.test.mjs demands of the fixtures.
      const expected = { blocked: 0, done: 0, working: 0, idle: 0, unknown: 0, agents: 0, shells: 0, panes: state.panes.length }
      for (const candidate of state.panes) {
        if (candidate.agent === null) expected.shells += 1
        else { expected.agents += 1; expected[candidate.status] += 1 }
        assert.equal(candidate.writable, candidate.writableReason === null, label)
        if (candidate.agent === null) assert.equal(candidate.writableReason, 'not-an-agent', label)
        assert.equal(candidate.stalled, candidate.status === 'working' && candidate.outputAt !== null && state.now - candidate.outputAt > 180_000, label)
      }
      assert.deepEqual(state.counts, expected, label)
      assert.ok(state.panes.filter((candidate) => candidate.focused).length <= 1, label)
      assert.equal(new Set(state.workspaces.map((workspace) => workspace.id)).size, state.workspaces.length, label)
      assert.deepEqual(
        state.workspaces.map((workspace) => [workspace.id, workspace.tabCount, workspace.paneCount, workspace.focused]).sort(),
        [...Map.groupBy(state.panes, (candidate) => candidate.workspaceId)].map(([id, group]) => [id, new Set(group.map((candidate) => candidate.tabId)).size, group.length, group.some((candidate) => candidate.focused)]).sort(),
        label,
      )
      assert.ok(!JSON.stringify(state).includes(RAW), `${label}: the raw session value leaked`)
    }
  })
})

/* ------------------------------------------------------------------------------------------ deriveSummary */

describe('clipText and stripAnsi', () => {
  it('clipText counts code points and ends a cut in one ellipsis (which counts too)', () => {
    assert.equal(clipText('abc', 5), 'abc')
    assert.equal(clipText('abcde', 5), 'abcde')
    assert.equal(clipText('abcdef', 5), 'abcd…')
    assert.equal(clipText('😀😀😀😀😀😀', 5), '😀😀😀😀…')
    assert.equal(clipText(''), '')
    assert.equal(clipText('a', 1), 'a')
    assert.equal(clipText('abc', 1), '…', 'a limit of one leaves room for the ellipsis only')
    assert.equal(clipText('abc', 0), '…', 'a limit below one is still one')
    assert.equal(SUMMARY_MAX, 240)
  })

  it('stripAnsi removes SGR (incl. 256-colour and truecolor), cursor moves, OSC titles and links, charset selects and stray controls', () => {
    assert.equal(stripAnsi(`${ESC}[31mred${ESC}[0m`), 'red')
    assert.equal(stripAnsi(`${ESC}[38;5;208mo${ESC}[38;2;1;2;3mt${ESC}[48:2::9:9:9mx${ESC}[m`), 'otx')
    assert.equal(stripAnsi(`${ESC}[2J${ESC}[H${ESC}[3;5Hhi${ESC}[?25l${ESC}[2K`), 'hi')
    assert.equal(stripAnsi(`${ESC}]0;window title\u0007text`), 'text')
    assert.equal(stripAnsi(`${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\`), 'link')
    assert.equal(stripAnsi(`${ESC}(B${ESC}[m after ${ESC}7${ESC}8`), ' after ')
    assert.equal(stripAnsi('a\r\nb\u0000c\u0007d\te'), 'a\nbcd\te', 'keeps newline and tab, drops carriage return and other controls')
    assert.equal(stripAnsi('plain 文本 😀'), 'plain 文本 😀')
  })
})

describe('deriveSummary', () => {
  const assistant = (text) => ({ kind: 'text', id: 'f', role: 'assistant', text, at: null })
  const user = (text) => ({ kind: 'text', id: 'f', role: 'user', text, at: null })
  const work = (...rows) => ({ kind: 'work', id: 'f', summary: '', tokens: null, rows: rows.map(([verb, object, outcome = 'ok', ms = null]) => ({ verb, object, outcome, ms })) })
  const final = (text) => ({ kind: 'final', id: 'f', text, reason: 'turn_duration', ms: null })
  const NONE = { text: '', source: 'none' }
  const done = (...frames) => deriveSummary({ status: 'done', frames })
  const working = (...frames) => deriveSummary({ status: 'working', frames })
  const blocked = (screenText) => deriveSummary({ status: 'blocked', screenText })

  describe('done: the first meaningful line of the agent\'s last words', () => {
    it('is the first line of the last assistant text, from the transcript', () => {
      assert.deepEqual(done(assistant('older words'), assistant('All 12 tests pass.\nNo failures, nothing skipped.')), { text: 'All 12 tests pass.', source: 'transcript' })
    })

    it('skips blank lines, headings, code fences and what is inside them, rules and table rows', () => {
      const message = ['', '## Summary', '', '```bash', 'rm -rf dist/', '```', '', '---', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'All 12 tests pass.', 'more'].join('\n')
      assert.equal(done(assistant(message)).text, 'All 12 tests pass.')
      assert.equal(done(assistant('~~~\ncode\n~~~\nafter tilde fence')).text, 'after tilde fence')
    })

    it('uses a heading only when nothing else says anything, and says nothing for code alone', () => {
      assert.equal(done(assistant('## 初步结论\n\n```\ncode\n```')).text, '初步结论')
      assert.deepEqual(done(assistant('```js\nconsole.log(1)\n```')), NONE)
      assert.deepEqual(done(assistant('---\n\n***\n')), NONE)
      assert.deepEqual(done(assistant('   \n\n')), NONE)
      assert.deepEqual(done(assistant('✅')), NONE, 'a line without a single letter or digit says nothing')
    })

    it('removes markdown syntax that reads as noise in a roster row, and nothing else', () => {
      assert.equal(done(assistant('- **Done**: tests pass, see [the log](http://x.test/y) and `npm test`')).text, 'Done: tests pass, see the log and npm test')
      assert.equal(done(assistant('> a quoted line')).text, 'a quoted line')
      assert.equal(done(assistant('1. first step\n2. second')).text, 'first step')
      assert.equal(done(assistant('* star bullet')).text, 'star bullet')
      assert.equal(done(assistant('   spaced \t out   words  ')).text, 'spaced out words')
      assert.equal(done(assistant('假宿主一共记录了 **77 条**调用，覆盖：')).text, '假宿主一共记录了 77 条调用，覆盖：')
      assert.equal(done(assistant('snake_case and __dunder__ stay, 2 * 3 stays')).text, 'snake_case and __dunder__ stay, 2 * 3 stays')
    })

    it('a final frame\'s text counts as the agent\'s last words; an empty one falls back to the text before it', () => {
      assert.equal(done(assistant('earlier'), final('Build is byte-identical.')).text, 'Build is byte-identical.')
      assert.equal(done(assistant('earlier words'), final('')).text, 'earlier words')
    })

    it('looks no further back than the user\'s last message: an older turn\'s answer is not this turn\'s outcome', () => {
      assert.deepEqual(done(assistant('answer to the old question'), user('a new question')), NONE)
      assert.equal(done(user('q'), assistant('first part'), work(['Read', 'a']), assistant('last part')).text, 'last part')
      assert.equal(done(assistant('old'), user('q'), assistant('new answer')).text, 'new answer')
    })

    it('ignores everything that is not the agent\'s own words: user text, system text, reasoning, work, session', () => {
      assert.deepEqual(done({ kind: 'session', id: 'f', sessionId: 's', cwd: '/x' }, { kind: 'reasoning', id: 'f', text: 'thinking aloud' }, work(['Read', 'a']), { kind: 'text', id: 'f', role: 'system', text: 'system note', at: null }), NONE)
    })

    it('is empty, not invented, without frames or with malformed ones', () => {
      for (const frames of [undefined, null, [], 'text', 7, {}, [null, 'x', 3, {}, { kind: 'text' }, { kind: 'text', role: 'assistant' }, { kind: 'text', role: 'assistant', text: 5 }]]) {
        assert.deepEqual(deriveSummary({ status: 'done', frames }), NONE, JSON.stringify(frames))
      }
    })
  })

  describe('working: the most recent tool action as "<verb> <object>"', () => {
    it('is the last row of the last work frame, from the transcript', () => {
      assert.deepEqual(working(work(['Read', 'a.js'], ['Edit', 'b.js']), work(['Bash', 'npm test', null])), { text: 'Bash npm test', source: 'transcript' })
      assert.equal(working(work(['Read', 'a.js'], ['Edit', 'b.js'])).text, 'Edit b.js')
    })

    it('is just the verb when there is no object, and one line when the object spans several', () => {
      assert.equal(working(work(['Think', ''])).text, 'Think')
      assert.equal(working(work(['Bash', 'set -e\nnpm   test\n'])).text, 'Bash set -e npm test')
    })

    it('skips a row that has neither verb nor object, and reads past text frames that came after the last tool call', () => {
      assert.equal(working(work(['Read', 'a.js'], ['', '']), assistant('I will edit it next')).text, 'Read a.js')
    })

    it('ignores work from before the user\'s last message, and says nothing when the turn has no tool action yet', () => {
      assert.deepEqual(working(work(['Read', 'a.js']), user('now do the other thing')), NONE)
      assert.equal(working(user('q'), work(['Read', 'a.js'])).text, 'Read a.js')
    })

    it('is empty when there are no work rows or no frames at all (it does not fall back to prose or to the screen)', () => {
      assert.deepEqual(deriveSummary({ status: 'working', frames: [assistant('some prose')], screenText: 'a screen' }), NONE)
      assert.deepEqual(deriveSummary({ status: 'working', frames: [] }), NONE)
      assert.deepEqual(deriveSummary({ status: 'working', frames: [work()] }), NONE)
      assert.deepEqual(deriveSummary({ status: 'working' }), NONE)
    })
  })

  describe('blocked: the question on the visible screen, ANSI stripped', () => {
    it('is the last line that reads like a question, from the screen', () => {
      const screen = [`${ESC}[1;36m●${ESC}[0m ${ESC}[1mBash${ESC}[0m(rm -rf dist/)`, '', `${ESC}[2m╭────╮${ESC}[0m`, ` ${ESC}[1mDo you want to proceed?${ESC}[0m`, ` ${ESC}[36m❯ 1. Yes${ESC}[0m`, '   2. No', `${ESC}[2m──────${ESC}[0m`].join('\n')
      assert.deepEqual(blocked(screen), { text: 'Do you want to proceed?', source: 'screen' })
    })

    it('handles the fixtures\' own screens: an approval dialog and a plain question', () => {
      assert.equal(blocked(fixtures.scenarios.busy.screens['w1:p1'].text).text, 'Do you want to proceed?')
      assert.equal(blocked(fixtures.scenarios.blocked.screens['w2:p1'].text).text, '文件已存在。要覆盖 docs/design/FLEET.md 吗？')
      assert.equal(blocked(fixtures.scenarios.blocked.screens['w2:p1'].text).source, 'screen')
    })

    it('recognises ASCII and full-width question marks, a trailing [y/N] hint, and a dialog drawn inside box borders', () => {
      assert.equal(blocked('log line\nContinue? [y/N]').text, 'Continue? [y/N]')
      assert.equal(blocked('Overwrite it? (y/n)\n').text, 'Overwrite it? (y/n)')
      assert.equal(blocked('要继续吗？\n  1. 是\n  2. 否').text, '要继续吗？')
      assert.equal(blocked(`│ Allow this tool call?          │\n│ ${ESC}[36m❯ 1. Yes${ESC}[0m                       │`).text, 'Allow this tool call?')
    })

    it('does not take a footer hint such as "? for shortcuts" or an option line for the question', () => {
      assert.equal(blocked('Do you trust this folder?\n  1. Yes\n  2. No\n ? for shortcuts').text, 'Do you trust this folder?')
      assert.equal(blocked('Pick one\n  1. alpha\n  2. beta (esc)').text, '2. beta (esc)', 'no question anywhere: the last real line')
    })

    it('without a question it is the last line that has words in it (decoration and blank lines do not count)', () => {
      assert.equal(blocked('Enter your password:\n\n─────────\n').text, 'Enter your password:')
      assert.equal(blocked(`${ESC}[2K${ESC}[1Gwaiting for input\r\n\r\n`).text, 'waiting for input')
    })

    it('looks only at the bottom of the screen: a question far above the last 20 lines is history, not the ask', () => {
      const screen = ['An old question?', ...Array.from({ length: 25 }, (_, index) => `output line ${index}`)].join('\n')
      assert.equal(blocked(screen).text, 'output line 24')
    })

    it('is empty when there is no screen or nothing on it but blanks, decoration and escapes', () => {
      for (const screenText of [undefined, null, 7, '', '   \n\n', '╭────╮\n│    │\n╰────╯', `${ESC}[2J${ESC}[H`]) assert.deepEqual(deriveSummary({ status: 'blocked', screenText }), NONE, JSON.stringify(screenText))
    })

    it('does not read the transcript: a blocked pane\'s answer is on the screen', () => {
      assert.deepEqual(deriveSummary({ status: 'blocked', frames: [assistant('all done')] }), NONE)
    })
  })

  describe('everything else says nothing, whatever it is given', () => {
    it('idle, unknown and unrecognised statuses are empty even with frames and a screen to read', () => {
      const given = { frames: [assistant('words'), work(['Read', 'a'])], screenText: 'Question?' }
      for (const status of ['idle', 'unknown', 'thinking', '', null, undefined, 3]) assert.deepEqual(deriveSummary({ ...given, status }), NONE, String(status))
      assert.deepEqual(deriveSummary(), NONE)
      assert.deepEqual(deriveSummary({}), NONE)
    })
  })

  describe('adversarial text (this runs on the host\'s event loop: one nasty line must not freeze the server)', () => {
    // The units that once made a regex backtrack quadratically get a size at which that costs seconds; the rest are cheap.
    const HEAVY = new Map([['[', 150_000], [' ', 150_000], ['\t', 150_000], ['│', 150_000]])
    const units = [' ', '\t', '[', ']', '(', '*', '`', '#', '>', '-', '|', '│', '?', '？', ESC, `${ESC}[`, `${ESC}]`, '**a', '[a](', '😀', '- ', '| ', '\r']
    const lengthOf = (unit) => HEAVY.get(unit) ?? 20_000
    const shapes = (unit) => {
      const run = unit.repeat(Math.ceil(lengthOf(unit) / unit.length))
      return [run, `a${run}b`, `?${run}x`, `${ESC}[${run}`]
    }

    it('is linear on long runs of every character that has special meaning to it, in every position', () => {
      let calls = 0
      for (const unit of units) {
        for (const text of shapes(unit)) {
          const attempts = [
            ['done', () => deriveSummary({ status: 'done', frames: [{ kind: 'text', role: 'assistant', text }] })],
            ['final', () => deriveSummary({ status: 'done', frames: [{ kind: 'final', text }] })],
            ['working', () => deriveSummary({ status: 'working', frames: [{ kind: 'work', rows: [{ verb: text, object: text }] }] })],
            ['blocked', () => deriveSummary({ status: 'blocked', screenText: text })],
          ]
          for (const [kind, attempt] of attempts) {
            const started = performance.now()
            const result = attempt()
            const took = performance.now() - started
            const label = `${kind} ${JSON.stringify(unit)} x ${lengthOf(unit)}`
            assert.ok(took < 1000, `${label} took ${Math.round(took)} ms: quadratic backtracking`)
            assert.ok(points(result.text) <= SUMMARY_MAX && result.text.isWellFormed(), label)
            assert.equal(result.text === '', result.source === 'none', label)
            calls += 1
          }
          const started = performance.now()
          stripAnsi(text)
          assert.ok(performance.now() - started < 1000, `stripAnsi ${JSON.stringify(unit)}`)
        }
      }
      assert.ok(calls >= 300)
    })

    it('looks at a single enormous line only up to a cap: twenty million characters cost milliseconds, not seconds', () => {
      // A child process under a hard timeout: if this ever regresses, the test must fail rather than hang the suite.
      const script = [
        `import { deriveSummary } from ${JSON.stringify(new URL('../lib/fleet/model.js', import.meta.url).href)}`,
        'const text = "[".repeat(20_000_000)',
        'const started = performance.now()',
        'const done = deriveSummary({ status: "done", frames: [{ kind: "text", role: "assistant", text }] })',
        'const blocked = deriveSummary({ status: "blocked", screenText: `x${text}` })',
        'process.stdout.write(JSON.stringify({ ms: performance.now() - started, done, blocked }))',
      ].join('\n')
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL' })
      assert.equal(run.error, undefined, `no answer within 4 s (${run.error?.code}): the per-line cap is gone, or a pattern backtracks (bounded regexes alone need ~9 s for this line)`)
      assert.equal(run.status, 0, run.stderr)
      const { ms, done, blocked } = JSON.parse(run.stdout)
      assert.ok(ms < 1000, `took ${Math.round(ms)} ms`)
      for (const result of [done, blocked]) assert.ok(points(result.text) <= SUMMARY_MAX)
    })

    it('still finds the real words in a long line (the per-line cap only bounds the work)', () => {
      const long = 'word '.repeat(5000).trim()
      assert.equal(deriveSummary({ status: 'done', frames: [{ kind: 'text', role: 'assistant', text: long }] }).text, clipText(long))
      const dialog = `${' '.repeat(5000)}Do you want to proceed?${' '.repeat(5000)}`
      assert.equal(deriveSummary({ status: 'blocked', screenText: `output\n${dialog}\n1. Yes` }).text, 'Do you want to proceed?')
    })
  })

  describe('shape', () => {
    it('is cut to 240 code points like a summary in State, and returns a fresh object every time', () => {
      const long = deriveSummary({ status: 'done', frames: [assistant(`${'长'.repeat(300)}\nnext`)] })
      assert.equal(long.text, `${'长'.repeat(239)}…`)
      assert.equal(deriveSummary({ status: 'working', frames: [work(['Bash', '😀'.repeat(300)])] }).text.isWellFormed(), true)
      const first = deriveSummary({ status: 'idle' })
      first.text = 'mutated'
      assert.deepEqual(deriveSummary({ status: 'idle' }), NONE)
    })

    it('feeds buildState: what it derives is a valid summary there, text and source together', () => {
      const derived = deriveSummary({ status: 'working', frames: [work(['Bash', 'npm test'])] })
      const state = build({ summaries: { 'w1:p1': derived } })
      assert.deepEqual([state.panes[0].summary, state.panes[0].summarySource], ['Bash npm test', 'transcript'])
    })
  })

  describe('over the fixtures\' real transcripts and screens', () => {
    const { busy, blocked: blockedScenario } = fixtures.scenarios
    const frames = (id) => busy.frames[id].frames
    const wordsOf = (id) => frames(id).filter((frame) => frame.text !== undefined).map((frame) => frame.text).join('\n').replace(/[*`]/g, '')

    it('done: the codex tester\'s closing words (its last turn ends in a final frame)', () => {
      assert.deepEqual(deriveSummary({ status: 'done', frames: frames('w1:p2') }), { text: '两次构建逐字节一致（sha 52564d4d）。', source: 'transcript' })
    })

    it('working: the last tool call of the frontend agent and of the pi researcher', () => {
      assert.equal(deriveSummary({ status: 'working', frames: frames('w1:p3') }).text, 'Bash bun run build:client')
      assert.equal(deriveSummary({ status: 'working', frames: frames('w2:p1') }).text, 'WebFetch herdr.dev/docs/socket-api')
    })

    it('done (hypothetically) for the reviewer skips its "## 初步结论" heading and strips the bold marks', () => {
      assert.equal(deriveSummary({ status: 'done', frames: frames('w1:p1') }).text, '假宿主一共记录了 77 条调用，覆盖：')
    })

    it('blocked: both blocked fixture agents', () => {
      assert.equal(deriveSummary({ status: 'blocked', screenText: busy.screens['w1:p1'].text }).text, 'Do you want to proceed?')
      assert.equal(deriveSummary({ status: 'blocked', screenText: blockedScenario.screens['w2:p1'].text }).text, '文件已存在。要覆盖 docs/design/FLEET.md 吗？')
    })

    it('for every agent pane and every status the result is real: bounded, consistent, and found in the data it came from', () => {
      let derived = 0
      for (const [id, response] of Object.entries(busy.frames)) {
        for (const status of ['working', 'blocked', 'done', 'idle', 'unknown']) {
          const result = deriveSummary({ status, frames: response.frames, screenText: busy.screens[id]?.text })
          assert.ok(points(result.text) <= SUMMARY_MAX, `${id} ${status}`)
          assert.equal(result.text === '', result.source === 'none', `${id} ${status}: text and source agree`)
          assert.ok(['transcript', 'screen', 'none'].includes(result.source))
          if (result.text === '') continue
          derived += 1
          if (status === 'working') {
            assert.equal(result.source, 'transcript')
            assert.ok(response.frames.some((frame) => frame.kind === 'work' && frame.rows.some((row) => `${row.verb} ${row.object}`.trim() === result.text)), `${id}: a real work row`)
          } else if (status === 'done') {
            assert.equal(result.source, 'transcript')
            assert.ok(wordsOf(id).includes(result.text), `${id}: "${result.text}" must be words the agent wrote`)
          } else {
            assert.equal(status, 'blocked')
            assert.equal(result.source, 'screen')
            assert.ok(stripAnsi(busy.screens[id].text).includes(result.text), `${id}: a real line of the screen`)
          }
        }
      }
      assert.ok(derived >= 6, `expected a good number of real summaries, got ${derived}`)
    })
  })
})
