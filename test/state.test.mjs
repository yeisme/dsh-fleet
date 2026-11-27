import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HerdrState, SUBSCRIPTIONS } from '../lib/herdr/state.js'
import { HerdrClient, HerdrError } from '../lib/herdr/protocol.js'
import { EMPTY_SNAPSHOT, normalizeSnapshot, snapshotSignature } from '../lib/herdr/normalize.js'
import { loadContract, validateDef } from '../lib/fleet/schema.js'
import { compareSnapshots, extractSnapshot } from '../scripts/parity.mjs'
import { startFakeHerdr } from './helpers/fake-herdr.js'
import { createWorld } from './helpers/wire.js'

const PARITY = fileURLToPath(new URL('../scripts/parity.mjs', import.meta.url))
const contract = loadContract()

/** Long enough that the safety poll never fires inside a test that is not about it. */
const NO_POLL_MS = 3_600_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `condition()` is truthy; fail loudly instead of hanging the suite. */
async function until(condition, { timeoutMs = 3000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

const demoWorld = () => createWorld({
  workspaces: [{
    id: 'w1',
    label: 'demo',
    tabs: [{
      id: 'w1:t1',
      label: 'main',
      panes: [
        { id: 'w1:p1', title: 'reviewer', focused: true, agent: { kind: 'claude', name: 'dsh-reviewer', status: 'working' } },
        { id: 'w1:p2', title: 'tester', agent: { kind: 'codex', status: 'idle' } },
        { id: 'w1:p3', title: 'zsh' },
      ],
    }],
  }],
})

/** An injectable clock: the state stamps every time it reports with it. Timers stay real. */
function createClock(start = 1_700_000_000_000) {
  let current = start
  const clock = () => current
  clock.advance = (ms) => { current += ms }
  return clock
}

/**
 * A fake herdr, a real client, and a state wired to both. Records what the state announces. Tiny reconnect delays and a
 * short coalesce window keep the suite fast; the safety poll is off unless a test turns it on.
 */
async function connect(t, { world = demoWorld(), listening = true, clientOptions = {}, options = {} } = {}) {
  const fake = await startFakeHerdr({ world })
  if (!listening) await fake.stop()
  const client = new HerdrClient({ socketPath: fake.socketPath, timeoutMs: 1000, ...clientOptions })
  const clock = createClock()
  const state = new HerdrState(client, { pollIntervalMs: NO_POLL_MS, coalesceMs: 20, reconnect: { initialMs: 15, maxMs: 60 }, now: clock, ...options })
  const log = { changes: [], statuses: [], listenerErrors: [] }
  state.on('change', (snapshot, previous) => log.changes.push({ snapshot, previous }))
  state.on('status', (status) => log.statuses.push(status))
  state.on('listener-error', (error, event) => log.listenerErrors.push({ error, event }))
  state.on('error', (error) => assert.fail(`HerdrState must never emit 'error': ${error}`))
  t.after(async () => {
    state.stop()
    client.close()
    await fake.close()
  })
  return { fake, world, client, clock, state, log }
}

/** Count how often something calls `state.refresh`, including calls that go on to be refused. */
function spyOnRefresh(state) {
  const calls = []
  const original = state.refresh.bind(state)
  state.refresh = (...args) => {
    calls.push(args)
    return original(...args)
  }
  return calls
}

/**
 * Make herdr answer session.snapshot LATE: the snapshot is taken the moment the request is handled and the answer goes out
 * `ms` later, i.e. a read that is on the wire but already out of date when it lands.
 */
function answerLate(fake, ms) {
  fake.handle('session.snapshot', async () => {
    const snapshot = fake.world.snapshot()
    await sleep(ms)
    return { type: 'session_snapshot', snapshot }
  })
}

/** Wait until herdr has handled `count` snapshot requests: the snapshot for the latest one has been taken. */
const reachedHerdr = (fake, count) => until(() => fake.requestsOf('session.snapshot').length >= count, { what: `read #${count} to reach herdr` })

/** `health` must always satisfy the contract and the invariants the contract tests rely on. */
function assertHealth(state, label = 'health') {
  const { health } = state
  const result = validateDef(contract, 'Health', health)
  assert.deepEqual(result.errors, [], `${label} breaks the contract: ${JSON.stringify(health)}`)
  if (health.connected) {
    assert.equal(health.error, null, `${label}: a connected herdr has no error`)
    assert.notEqual(health.lastOkAt, null, `${label}: a connected herdr has a last-ok time`)
  } else {
    assert.equal(typeof health.error, 'string', `${label}: a disconnected herdr says why`)
  }
  if (state.stale) assert.equal(health.connected, false, `${label}: stale implies disconnected`)
  return health
}

const paneOf = (snapshot, id) => snapshot.panes.find((pane) => pane.id === id)

describe('SUBSCRIPTIONS', () => {
  // The kinds whose only required property is "type" in herdr's own Subscription schema (read from the schema embedded in
  // the installed herdr, 0.9.x). Written out in full on purpose: adding a kind to the host is then a decision, not a side effect.
  const BROADCAST_KINDS = new Set([
    'workspace.created', 'workspace.updated', 'workspace.metadata_updated', 'workspace.renamed', 'workspace.moved',
    'workspace.reordered', 'workspace.closed', 'workspace.focused',
    'worktree.created', 'worktree.opened', 'worktree.removed',
    'tab.created', 'tab.closed', 'tab.focused', 'tab.renamed', 'tab.moved',
    'pane.created', 'pane.closed', 'pane.updated', 'pane.focused', 'pane.moved', 'pane.exited', 'pane.agent_detected',
    'layout.updated',
  ])
  // These also require a pane_id: one pane that has gone away would get the whole subscription refused.
  const PANE_SCOPED_KINDS = ['pane.output_matched', 'pane.agent_status_changed', 'pane.scroll_changed']

  it('is only broadcast kinds: every entry is a bare { type } on the allow-list, none needs a pane id', () => {
    assert.ok(SUBSCRIPTIONS.length > 0)
    for (const entry of SUBSCRIPTIONS) {
      assert.deepEqual(Object.keys(entry), ['type'], `${JSON.stringify(entry)} carries more than a type`)
      assert.ok(BROADCAST_KINDS.has(entry.type), `${entry.type} is not a known broadcast kind`)
      assert.ok(!PANE_SCOPED_KINDS.includes(entry.type), `${entry.type} is pane-scoped`)
    }
    assert.equal(new Set(SUBSCRIPTIONS.map((entry) => entry.type)).size, SUBSCRIPTIONS.length, 'no duplicates')
  })

  it('covers every kind that changes what the Fleet shows', () => {
    const types = new Set(SUBSCRIPTIONS.map((entry) => entry.type))
    for (const needed of ['pane.created', 'pane.closed', 'pane.updated', 'pane.exited', 'pane.focused', 'pane.agent_detected',
      'workspace.created', 'workspace.closed', 'workspace.renamed', 'workspace.focused', 'tab.created', 'tab.closed', 'tab.renamed', 'tab.focused', 'layout.updated']) {
      assert.ok(types.has(needed), needed)
    }
  })

  it('cannot be changed by accident: a later subscription must ask for the same thing', () => {
    assert.ok(Object.isFrozen(SUBSCRIPTIONS))
    for (const entry of SUBSCRIPTIONS) assert.ok(Object.isFrozen(entry))
  })
})

describe('HerdrState: the first read', () => {
  it('before anything is read the snapshot is the empty one, and herdr counts as not contacted rather than stale', async (t) => {
    const { state } = await connect(t)
    assert.equal(state.snapshot, EMPTY_SNAPSHOT)
    assert.equal(state.revision, 0)
    assert.equal(state.stale, false)
    const health = assertHealth(state)
    assert.equal(health.connected, false)
    assert.equal(health.lastOkAt, null)
    assert.equal(health.version, null)
    assert.equal(health.protocol, null)
  })

  it('start() reads the session once and the snapshot is the normalized wire snapshot plus the time fields', async (t) => {
    const { state, fake, clock, log } = await connect(t)
    const started = clock()
    assert.equal(await state.start(), state, 'start() resolves with the state itself')
    assert.equal(fake.requestsOf('session.snapshot').length, 1)

    const expected = normalizeSnapshot(fake.world.snapshot())
    expected.panes = expected.panes.map((pane) => ({ ...pane, stateSince: started, outputAt: started }))
    expected.updatedAt = started
    expected.revision = 1
    assert.deepEqual(state.snapshot, expected)
    assert.equal(state.revision, 1)

    assert.equal(log.changes.length, 1)
    assert.equal(log.changes[0].previous, EMPTY_SNAPSHOT, 'the first change is announced against the empty snapshot')
    assert.equal(log.changes[0].snapshot, state.snapshot)
  })

  it('the first successful snapshot is a change and revision 1 even when the world is empty', async (t) => {
    const { state, log } = await connect(t, { world: createWorld() })
    await state.start()
    assert.deepEqual(state.snapshot.panes, [])
    assert.equal(state.revision, 1)
    assert.equal(log.changes.length, 1)
    assert.equal(state.health.connected, true)
  })

  it('refresh() works without start() (the state need not be running to be read)', async (t) => {
    const { state, fake } = await connect(t)
    const snapshot = await state.refresh()
    assert.equal(snapshot.panes.length, 3)
    assert.equal(fake.requestsOf('session.snapshot').length, 1)
    assert.equal(fake.subscriberCount(), 0, 'no stream until start() or ensureSubscribed()')
  })

  it('an answer that is not a snapshot is a failure, not an empty world', async (t) => {
    const { state, fake } = await connect(t)
    await state.refresh()
    fake.handle('session.snapshot', () => ({ type: 'ok' }))
    await assert.rejects(state.refresh(), (error) => error instanceof HerdrError && error.code === 'malformed')
    assert.equal(state.snapshot.panes.length, 3, 'the last known panes are kept')
    assert.equal(state.stale, true)
    assert.equal(state.revision, 1)
    assertHealth(state)
  })
})

describe('HerdrState: what it derives by watching (stateSince, outputAt)', () => {
  it('a pane seen for the first time is stamped with the moment it was first seen, not an invented earlier time', async (t) => {
    const { state, clock } = await connect(t)
    await state.start()
    const first = clock()
    for (const pane of state.snapshot.panes) {
      assert.equal(pane.stateSince, first, pane.id)
      assert.equal(pane.outputAt, first, pane.id)
    }
  })

  it('outputAt follows the pane revision, stateSince follows the agent status, and they move independently', async (t) => {
    const { state, fake, world, clock } = await connect(t)
    await state.start()
    const t0 = clock()

    clock.advance(5000)
    world.touch('w1:p1') // output moved, status did not
    await state.refresh()
    assert.equal(paneOf(state.snapshot, 'w1:p1').outputAt, t0 + 5000)
    assert.equal(paneOf(state.snapshot, 'w1:p1').stateSince, t0, 'the status did not change')
    assert.equal(paneOf(state.snapshot, 'w1:p2').outputAt, t0, 'other panes are untouched')

    clock.advance(3000)
    world.update('w1:p2', { status: 'blocked' }) // status and revision both move in a live session
    await state.refresh()
    assert.equal(paneOf(state.snapshot, 'w1:p2').stateSince, t0 + 8000)
    assert.equal(paneOf(state.snapshot, 'w1:p2').outputAt, t0 + 8000)

    clock.advance(2000)
    fake.handle('session.snapshot', () => {
      // A status change that does not touch the revision: stateSince must move, outputAt must not.
      const snapshot = world.snapshot()
      for (const pane of snapshot.panes) if (pane.pane_id === 'w1:p1') pane.agent_status = 'blocked'
      for (const agent of snapshot.agents) if (agent.pane_id === 'w1:p1') agent.agent_status = 'blocked'
      return { type: 'session_snapshot', snapshot }
    })
    await state.refresh()
    assert.equal(paneOf(state.snapshot, 'w1:p1').agentStatus, 'blocked')
    assert.equal(paneOf(state.snapshot, 'w1:p1').stateSince, t0 + 10_000)
    assert.equal(paneOf(state.snapshot, 'w1:p1').outputAt, t0 + 5000, 'the revision did not move, so neither does outputAt')
  })

  it('a read that shows nothing new leaves both time fields alone, however much time has passed', async (t) => {
    const { state, clock } = await connect(t)
    await state.start()
    const before = state.snapshot.panes.map((pane) => [pane.id, pane.stateSince, pane.outputAt])
    clock.advance(600_000)
    await state.refresh()
    assert.deepEqual(state.snapshot.panes.map((pane) => [pane.id, pane.stateSince, pane.outputAt]), before)
    assert.equal(state.snapshot.updatedAt, clock(), 'only updatedAt says when the cache was last confirmed')
  })

  it('a pane that vanishes and later returns is first observed again', async (t) => {
    const { state, world, clock } = await connect(t)
    await state.start()
    const t0 = clock()
    assert.equal(paneOf(state.snapshot, 'w1:p3').stateSince, t0)

    clock.advance(1000)
    world.closePane('w1:p3')
    await state.refresh()
    assert.equal(paneOf(state.snapshot, 'w1:p3'), undefined)

    clock.advance(1000)
    world.addPane('w1:t1', { id: 'w1:p3', title: 'zsh' }) // same status and revision as before it vanished
    await state.refresh()
    const returned = paneOf(state.snapshot, 'w1:p3')
    assert.equal(returned.stateSince, t0 + 2000, 'not remembered from before it vanished')
    assert.equal(returned.outputAt, t0 + 2000)
  })

  it('the time fields survive an outage: nothing is observed while herdr is away, so nothing moves', async (t) => {
    const { state, fake, clock } = await connect(t, { options: { reconnect: { initialMs: 200, maxMs: 200 } } })
    await state.start()
    const t0 = clock()
    await fake.stop()
    clock.advance(30_000)
    await assert.rejects(state.refresh())
    for (const pane of state.snapshot.panes) {
      assert.equal(pane.stateSince, t0)
      assert.equal(pane.outputAt, t0)
    }
  })
})

describe('HerdrState: revision', () => {
  it('moves once per visible change, however many things changed, and never for time alone', async (t) => {
    const { state, world, clock, log } = await connect(t)
    await state.start()
    assert.equal(state.revision, 1)

    clock.advance(3_600_000)
    await state.refresh()
    assert.equal(state.revision, 1, 'time moved, nothing visible did')
    assert.equal(log.changes.length, 1)

    world.update('w1:p1', { status: 'done', title: 'finished' })
    world.update('w1:p2', { status: 'working' })
    await state.refresh()
    assert.equal(state.revision, 2, 'several changes in one read are one revision')
    assert.equal(log.changes.length, 2)
    assert.equal(log.changes[1].snapshot.revision, 2)
    assert.equal(log.changes[1].previous.revision, 1)

    world.touch('w1:p3') // output moved on a shell: a viewer of its screen can see that
    await state.refresh()
    assert.equal(state.revision, 3)
  })

  it('a snapshot handed out earlier is never rewritten by a later read', async (t) => {
    const { state, world, log } = await connect(t)
    await state.start()
    world.update('w1:p1', { status: 'done' })
    await state.refresh()
    assert.equal(paneOf(log.changes[0].snapshot, 'w1:p1').agentStatus, 'working')
    assert.equal(paneOf(log.changes[1].previous, 'w1:p1').agentStatus, 'working')
    assert.equal(paneOf(log.changes[1].snapshot, 'w1:p1').agentStatus, 'done')
    assert.notEqual(log.changes[0].snapshot, log.changes[1].snapshot)
  })

  it('fields the signature ignores still refresh the cache without costing a revision', async (t) => {
    const { state, fake, world, log } = await connect(t, { world: createWorld({
      workspaces: [{ id: 'w1', label: 'demo', tabs: [{ id: 'w1:t1', label: 'main', panes: [
        { id: 'w1:p1', title: 'a', agent: { kind: 'pi', status: 'idle', session: { kind: 'path', source: 'herdr:pi', value: '/Users/demo/one.jsonl' } } },
      ] }] }],
    }) })
    await state.start()
    fake.handle('session.snapshot', () => {
      const snapshot = world.snapshot()
      snapshot.panes[0].agent_session.value = '/Users/demo/two.jsonl'
      snapshot.agents[0].agent_session.value = '/Users/demo/two.jsonl'
      return { type: 'session_snapshot', snapshot }
    })
    await state.refresh()
    assert.equal(state.snapshot.panes[0].agentSession.value, '/Users/demo/two.jsonl', 'the transcript reader needs the current session')
    assert.equal(state.revision, 1)
    assert.equal(log.changes.length, 1)
  })

  it('a failure moves nothing, and recovering to an identical world fires no change', async (t) => {
    const { state, fake, log } = await connect(t)
    await state.start()
    fake.failNext('session.snapshot', { code: 'internal_error', message: 'boom' })
    await assert.rejects(state.refresh())
    assert.equal(state.revision, 1)
    await state.refresh()
    assert.equal(state.revision, 1)
    assert.equal(log.changes.length, 1)
    assert.deepEqual(log.statuses.map((status) => status.status), ['live', 'down', 'live'], 'the recovery is still announced as a status')
  })

  it('agrees with snapshotSignature: the revision moves exactly when the signature does', async (t) => {
    const { state, world } = await connect(t)
    await state.start()
    const steps = [
      () => world.update('w1:p1', { title: 'renamed' }),
      () => {},
      () => world.focus('w1:p2'),
      () => {},
      () => world.closePane('w1:p3'),
    ]
    for (const step of steps) {
      const before = { signature: snapshotSignature(state.snapshot), revision: state.revision }
      step()
      await state.refresh()
      const moved = snapshotSignature(state.snapshot) !== before.signature
      assert.equal(state.revision, before.revision + (moved ? 1 : 0))
    }
  })
})

describe('HerdrState.refresh', () => {
  it('concurrent callers share one read', async (t) => {
    const { state, fake } = await connect(t)
    fake.delayNext('session.snapshot', 60)
    const results = await Promise.all([state.refresh(), state.refresh(), state.refresh({})])
    assert.equal(fake.requestsOf('session.snapshot').length, 1)
    assert.equal(results[0], results[1])
    assert.equal(results[1], results[2])
    await state.refresh()
    assert.equal(fake.requestsOf('session.snapshot').length, 2, 'the answer is not cached: a later call reads again')
  })

  it('a failed read rejects every caller that shared it, and the next call tries again', async (t) => {
    const { state, fake } = await connect(t)
    await state.refresh()
    fake.handle('session.snapshot', async () => {
      await sleep(40)
      throw Object.assign(new Error('boom'), { code: 'internal_error' })
    })
    fake.clearRequests()
    const outcomes = await Promise.allSettled([state.refresh(), state.refresh()])
    assert.equal(fake.requestsOf('session.snapshot').length, 1)
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'rejected')
      assert.ok(outcome.reason instanceof HerdrError)
      assert.equal(outcome.reason.code, 'internal_error')
    }
    fake.handle('session.snapshot', () => ({ type: 'session_snapshot', snapshot: fake.world.snapshot() }))
    await state.refresh()
    assert.equal(fake.requestsOf('session.snapshot').length, 2)
    assert.equal(state.health.connected, true)
  })

  it('force means "a read that starts after this call": a plain caller joins the read on the wire, a forced one reads again', async (t) => {
    const { state, fake, world } = await connect(t)
    answerLate(fake, 60) // what someone who just wrote to herdr must not settle for
    const first = state.refresh()
    await reachedHerdr(fake, 1)
    world.update('w1:p2', { status: 'blocked' }) // the change the forced caller is waiting to see
    const joined = state.refresh()
    const forced = state.refresh({ force: true })
    const forcedAgain = state.refresh({ force: true })
    const [a, b, c, d] = await Promise.all([first, joined, forced, forcedAgain])
    assert.equal(a, b, 'a plain caller shares the read on the wire')
    assert.equal(c, d, 'forced callers share a single follow-up')
    assert.equal(paneOf(a, 'w1:p2').agentStatus, 'idle', 'that read predates the change')
    assert.equal(paneOf(c, 'w1:p2').agentStatus, 'blocked', 'the follow-up read happened after it')
    assert.equal(fake.requestsOf('session.snapshot').length, 2)
    assert.equal(paneOf(state.snapshot, 'w1:p2').agentStatus, 'blocked')
  })

  it('a forced refresh with nothing on the wire is a single read', async (t) => {
    const { state, fake } = await connect(t)
    await state.refresh({ force: true })
    assert.equal(fake.requestsOf('session.snapshot').length, 1)
  })

  it('a forced caller whose follow-up read fails gets the failure', async (t) => {
    const { state, fake } = await connect(t)
    answerLate(fake, 40)
    const first = state.refresh()
    await reachedHerdr(fake, 1)
    fake.handle('session.snapshot', () => { throw Object.assign(new Error('second read refused'), { code: 'internal_error' }) })
    const forced = state.refresh({ force: true })
    await first
    await assert.rejects(forced, (error) => error.code === 'internal_error')
    assert.equal(state.stale, true)
  })
})

describe('HerdrState: polling and events', () => {
  it('the safety poll keeps reading on its own, without moving the revision when nothing changed', async (t) => {
    const { state, fake } = await connect(t, { options: { pollIntervalMs: 30 } })
    await state.start()
    await until(() => fake.requestsOf('session.snapshot').length >= 4, { what: 'a few poll reads' })
    assert.equal(state.revision, 1)
  })

  it('the poll picks up a change that no event announced', async (t) => {
    const { state, world } = await connect(t, { options: { pollIntervalMs: 30 } })
    await state.start()
    world.update('w1:p1', { status: 'done' })
    await until(() => paneOf(state.snapshot, 'w1:p1').agentStatus === 'done', { what: 'the poll to see it' })
    assert.equal(state.revision, 2)
  })

  it('a pushed event triggers a refresh', async (t) => {
    const { state, fake, world, log } = await connect(t)
    await state.start()
    world.update('w1:p1', { status: 'done' })
    fake.push('pane_updated', { pane_id: 'w1:p1' })
    await until(() => log.changes.length === 2, { what: 'the event-driven change' })
    assert.equal(paneOf(state.snapshot, 'w1:p1').agentStatus, 'done')
    assert.equal(paneOf(log.changes[1].previous, 'w1:p1').agentStatus, 'working')
  })

  it('a burst of events costs exactly one extra read, and not before the coalesce window has passed', async (t) => {
    const { state, fake } = await connect(t, { options: { coalesceMs: 200 } })
    await state.start()
    const before = fake.requestsOf('session.snapshot').length
    const firstPush = Date.now()
    for (let index = 0; index < 5; index += 1) {
      fake.push('pane_updated', { pane_id: 'w1:p1' })
      await sleep(8) // spread out, so the reads below cannot be one shared read by luck
    }
    await sleep(450)
    const reads = fake.requestsOf('session.snapshot').slice(before)
    assert.equal(reads.length, 1, 'five events inside the window, one read')
    assert.ok(reads[0].at - firstPush >= 190, `the read waited for the window (${reads[0].at - firstPush} ms)`)
  })

  it('events spread over several windows cost one read per window', async (t) => {
    const { state, fake } = await connect(t, { options: { coalesceMs: 30 } })
    await state.start()
    const before = fake.requestsOf('session.snapshot').length
    for (let index = 0; index < 3; index += 1) {
      fake.push('pane_updated', { pane_id: 'w1:p1' })
      await sleep(120)
    }
    assert.equal(fake.requestsOf('session.snapshot').length - before, 3)
  })

  it('an event that arrives while a read is on the wire gets a read of its own afterwards', async (t) => {
    const { state, fake, world } = await connect(t)
    await state.start()
    answerLate(fake, 80)
    const before = fake.requestsOf('session.snapshot').length
    const slow = state.refresh() // taken as soon as herdr handles it, answered 80 ms later
    await reachedHerdr(fake, before + 1)
    world.update('w1:p1', { status: 'done' }) // after that read was taken
    fake.push('pane_updated', { pane_id: 'w1:p1' }) // its coalesce window ends while the slow read is still out
    await slow
    assert.equal(paneOf(state.snapshot, 'w1:p1').agentStatus, 'working', 'the read on the wire predates the change')
    await until(() => paneOf(state.snapshot, 'w1:p1').agentStatus === 'done', { what: 'the read the event asked for' })
    assert.equal(fake.requestsOf('session.snapshot').length - before, 2)
  })

  it('scheduleRefresh() can be called directly and coalesces the same way', async (t) => {
    const { state, fake } = await connect(t, { options: { coalesceMs: 100 } })
    await state.start()
    const before = fake.requestsOf('session.snapshot').length
    state.scheduleRefresh()
    state.scheduleRefresh()
    state.scheduleRefresh()
    assert.equal(fake.requestsOf('session.snapshot').length, before, 'nothing happens before the window ends')
    await until(() => fake.requestsOf('session.snapshot').length === before + 1, { what: 'the coalesced read' })
    await sleep(150)
    assert.equal(fake.requestsOf('session.snapshot').length, before + 1)
  })
})

describe('HerdrState: the event stream', () => {
  it('start() reads first, then opens one stream with SUBSCRIPTIONS, and announces it as live', async (t) => {
    const { state, fake, client, log } = await connect(t)
    await state.start()
    assert.deepEqual(fake.requests.map((request) => request.method), ['session.snapshot', 'events.subscribe'])
    assert.deepEqual(fake.requestsOf('events.subscribe')[0].params, { subscriptions: SUBSCRIPTIONS })
    assert.equal(fake.subscriberCount(), 1)
    assert.equal(client.subscribed, true, 'the client tracks the stream so client.close() ends it too')
    assert.deepEqual(log.statuses, [{ status: 'live' }], 'the very first status is never "reconnecting"')
  })

  it('start() twice is one start', async (t) => {
    const { state, fake } = await connect(t)
    const [a, b] = await Promise.all([state.start(), state.start()])
    assert.equal(a, b)
    await state.start()
    assert.equal(fake.requestsOf('session.snapshot').length, 1)
    assert.equal(fake.requestsOf('events.subscribe').length, 1)
  })

  it('ensureSubscribed() is idempotent and concurrent callers share one attempt', async (t) => {
    const { state, fake } = await connect(t)
    const results = await Promise.all([state.ensureSubscribed(), state.ensureSubscribed(), state.ensureSubscribed()])
    assert.deepEqual(results, [true, true, true])
    assert.equal(await state.ensureSubscribed(), true)
    assert.equal(fake.requestsOf('events.subscribe').length, 1)
    assert.equal(fake.subscriberCount(), 1)
  })

  it('ensureSubscribed() says false when herdr is not there, and the state keeps working', async (t) => {
    const { state } = await connect(t, { listening: false })
    assert.equal(await state.ensureSubscribed(), false)
    assert.equal(state.health.connected, false)
  })

  it('a lost stream: reconnecting, a wait, an authoritative read, a new stream, live', async (t) => {
    const { state, fake, log } = await connect(t, { options: { reconnect: { initialMs: 60, maxMs: 240 } } })
    await state.start()
    fake.clearRequests()
    const lostAt = Date.now()
    fake.dropSubscribers()
    await until(() => log.statuses.length === 3, { what: 'live again' })
    assert.deepEqual(log.statuses, [{ status: 'live' }, { status: 'reconnecting' }, { status: 'live' }])
    assert.deepEqual(fake.requests.map((request) => request.method), ['session.snapshot', 'events.subscribe'], 'read first, then subscribe')
    assert.ok(fake.requests[0].at - lostAt >= 55, `it backed off before reading (${fake.requests[0].at - lostAt} ms)`)
    assert.equal(fake.subscriberCount(), 1)
  })

  it('a change that happened while the stream was down shows up through the authoritative read', async (t) => {
    const { state, fake, world, log } = await connect(t)
    await state.start()
    fake.dropSubscribers()
    world.update('w1:p1', { status: 'done' }) // no event can reach the state for this
    await until(() => paneOf(state.snapshot, 'w1:p1').agentStatus === 'done', { what: 'the reconciling read' })
    await until(() => log.statuses.at(-1)?.status === 'live', { what: 'the stream back' })
  })

  it('events flow again over the new stream', async (t) => {
    const { state, fake, world, log } = await connect(t)
    await state.start()
    fake.dropSubscribers()
    await until(() => log.statuses.length === 3)
    world.update('w1:p1', { status: 'done' })
    fake.push('pane_updated', { pane_id: 'w1:p1' })
    await until(() => paneOf(state.snapshot, 'w1:p1').agentStatus === 'done', { what: 'an event over the new stream' })
  })

  it('backoff doubles while herdr keeps failing, stops at the cap, and the failures are announced once', async (t) => {
    const { state, fake, log } = await connect(t, { options: { reconnect: { initialMs: 20, maxMs: 80 } } })
    await state.start()
    fake.clearRequests()
    for (let index = 0; index < 5; index += 1) fake.failNext('session.snapshot', { code: 'internal_error', message: 'planned' })
    fake.dropSubscribers()
    await until(() => log.statuses.at(-1)?.status === 'live' && log.statuses.length > 1, { what: 'recovery', timeoutMs: 5000 })

    const reads = fake.requestsOf('session.snapshot').map((request) => request.at)
    assert.equal(reads.length, 6, 'five failed rounds, then the sixth succeeded')
    const gaps = reads.slice(1).map((at, index) => at - reads[index]) // waits of 40, 80, 80, 80, 80 (uncapped: 40 80 160 320 640)
    assert.ok(gaps[0] >= 35, `second wait doubled the first (${gaps[0]} ms)`)
    for (const gap of gaps.slice(1)) assert.ok(gap >= 75, `later waits reached the cap (${gap} ms)`)
    assert.ok(gaps[4] < 400, `and stayed there instead of doubling on (${gaps[4]} ms)`)
    assert.deepEqual(log.statuses, [
      { status: 'live' }, { status: 'reconnecting' }, { status: 'down', error: 'planned' }, { status: 'reconnecting' }, { status: 'live' },
    ])
  })

  it('the backoff starts over after a success', async (t) => {
    const { state, fake, log } = await connect(t, { options: { reconnect: { initialMs: 20, maxMs: 320 } } })
    await state.start()
    for (let index = 0; index < 3; index += 1) fake.failNext('session.snapshot', { code: 'internal_error', message: 'planned' })
    fake.dropSubscribers() // waits of 20, 40, 80 fail; after 160 the read succeeds, and the next wait would have been 320
    await until(() => log.statuses.at(-1)?.status === 'live' && log.statuses.length > 1, { what: 'first recovery', timeoutMs: 5000 })

    fake.clearRequests()
    const lostAt = Date.now()
    fake.dropSubscribers()
    await until(() => fake.requestsOf('session.snapshot').length >= 1, { what: 'the first read of the second outage' })
    const waited = fake.requestsOf('session.snapshot')[0].at - lostAt
    assert.ok(waited < 200, `waited ${waited} ms: that is the initial delay, not the 320 ms the first outage ended on`)
  })

  it('a refused subscription is retried with backoff while the poll keeps the cache fresh', async (t) => {
    const { state, fake, world, log } = await connect(t, { options: { pollIntervalMs: 40, reconnect: { initialMs: 20, maxMs: 40 } } })
    fake.failNext('events.subscribe', { code: 'invalid_subscription', message: 'refused' })
    await state.start()
    assert.equal(fake.subscriberCount(), 0)
    assert.equal(state.health.connected, true, 'the snapshot read itself worked')
    world.update('w1:p1', { status: 'done' })
    await until(() => paneOf(state.snapshot, 'w1:p1').agentStatus === 'done', { what: 'the poll to see the change without a stream' })
    await until(() => fake.subscriberCount() === 1, { what: 'the retried subscription' })
    assert.deepEqual(log.statuses, [{ status: 'live' }])
  })
})

describe('HerdrState: herdr down, and back', () => {
  it('down at start: start() does not throw, health says why, nothing is stale, and it recovers by itself', async (t) => {
    const { state, fake, clock, log } = await connect(t, { listening: false, options: { pollIntervalMs: 40 } })
    await state.start() // must not throw
    const down = assertHealth(state, 'down at start')
    assert.deepEqual(down, {
      connected: false, socket: fake.socketPath, version: null, protocol: null, lastOkAt: null,
      error: `herdr is not reachable at ${fake.socketPath}`, session: null,
    })
    assert.equal(state.stale, false, 'it never connected: no old data to be stale about')
    assert.equal(state.snapshot, EMPTY_SNAPSHOT)
    assert.equal(state.revision, 0)
    assert.deepEqual(log.statuses, [{ status: 'down', error: `herdr is not reachable at ${fake.socketPath}` }])
    assert.equal(log.changes.length, 0)

    clock.advance(5000)
    const comingUp = clock()
    await fake.start()
    await until(() => log.statuses.at(-1)?.status === 'live', { what: 'recovery' })
    const up = assertHealth(state, 'recovered')
    assert.deepEqual(up, { connected: true, socket: fake.socketPath, version: '0.9.5', protocol: 22, lastOkAt: comingUp, error: null, session: null })
    assert.equal(state.stale, false)
    assert.equal(state.revision, 1)
    assert.equal(log.changes.length, 1)
    assert.equal(log.changes[0].previous, EMPTY_SNAPSHOT)
    assert.equal(fake.subscriberCount(), 1, 'the event stream came up too')
    assert.deepEqual(log.statuses.map((status) => status.status), ['down', 'reconnecting', 'live'])
  })

  it('down later: the last known snapshot stays, stale is true, lastOkAt says when it was last good', async (t) => {
    const { state, fake, clock, log } = await connect(t)
    await state.start()
    const lastGood = clock()
    const panes = state.snapshot.panes.map((pane) => pane.id)
    clock.advance(10_000)
    await fake.stop()
    await until(() => state.stale, { what: 'the outage to be noticed' })

    const health = assertHealth(state, 'stale')
    assert.equal(health.connected, false)
    assert.equal(health.lastOkAt, lastGood, 'failed reads do not move it')
    assert.equal(health.version, '0.9.5', 'version and protocol are the last seen')
    assert.equal(health.protocol, 22)
    assert.equal(health.error, `herdr is not reachable at ${fake.socketPath}`)
    assert.deepEqual(state.snapshot.panes.map((pane) => pane.id), panes)
    assert.equal(state.revision, 1)
    assert.equal(log.statuses.at(-1).status, 'down')

    clock.advance(10_000)
    const back = clock()
    await fake.start()
    await until(() => state.health.connected && fake.subscriberCount() === 1, { what: 'recovery' })
    const recovered = assertHealth(state, 'recovered')
    assert.equal(recovered.lastOkAt >= back, true)
    assert.equal(recovered.error, null)
    assert.equal(state.stale, false)
    assert.equal(log.statuses.at(-1).status, 'live')
    assert.equal(state.revision, 1, 'the world did not change while herdr was away')
  })

  it('a world that changed while herdr was away is one change after it returns', async (t) => {
    const { state, fake, world, log } = await connect(t)
    await state.start()
    await fake.stop()
    await until(() => state.stale)
    world.update('w1:p1', { status: 'done' })
    await fake.start()
    await until(() => state.revision === 2, { what: 'the change after recovery' })
    assert.equal(log.changes.length, 2)
    assert.equal(paneOf(log.changes[1].previous, 'w1:p1').agentStatus, 'working')
    assert.equal(paneOf(state.snapshot, 'w1:p1').agentStatus, 'done')
  })

  it('a refresh against a dead herdr rejects with the HerdrError and records it', async (t) => {
    const { state, fake } = await connect(t)
    await state.refresh()
    await fake.stop()
    await assert.rejects(state.refresh(), (error) => error instanceof HerdrError && ['ENOENT', 'ECONNREFUSED'].includes(error.code))
    assert.equal(state.stale, true)
    assert.match(state.health.error, /^herdr is not reachable at /)
  })

  it('herdr answering with an error frame is a failure too, but not "not reachable": its own words, one line', async (t) => {
    const { state, fake } = await connect(t)
    await state.refresh()
    fake.failNext('session.snapshot', { code: 'internal_error', message: 'the layout is being rebuilt\nstack: not for the banner' })
    await assert.rejects(state.refresh(), (error) => error.code === 'internal_error')
    assert.equal(state.health.error, 'the layout is being rebuilt')
    assert.equal(state.stale, true)
    assertHealth(state)
    await state.refresh()
    assert.equal(state.stale, false)
    assert.equal(state.health.error, null)
  })

  it('a read that times out says so, and a very long message is cut', async (t) => {
    const { state, fake } = await connect(t, { clientOptions: { timeoutMs: 80 } })
    await state.refresh()
    fake.hangNext('session.snapshot')
    await assert.rejects(state.refresh(), (error) => error.code === 'timeout')
    assert.match(state.health.error, /timed out/)
    assert.doesNotMatch(state.health.error, /not reachable/, 'a slow herdr is reachable')
    fake.failNext('session.snapshot', { code: 'internal_error', message: 'x'.repeat(5000) })
    await assert.rejects(state.refresh())
    assert.ok(Array.from(state.health.error).length <= 200)
    assertHealth(state)
  })

  it('health.session is the option, and health.socket is the client\'s socket', async (t) => {
    const { state, client } = await connect(t, { options: { session: 'fleet-test' } })
    await state.refresh()
    assert.equal(state.health.session, 'fleet-test')
    assert.equal(state.health.socket, client.socketPath)
    assertHealth(state)
  })

  it('every state it can be in satisfies the contract\'s Health', async (t) => {
    const { state, fake } = await connect(t, { options: { session: 'fleet-test' } })
    assertHealth(state, 'never contacted')
    await state.refresh()
    assertHealth(state, 'connected')
    fake.failNext('session.snapshot', { code: 'internal_error', message: 'boom' })
    await assert.rejects(state.refresh())
    assertHealth(state, 'herdr error')
    await fake.stop()
    await assert.rejects(state.refresh())
    assertHealth(state, 'unreachable')
    assert.equal(state.stale, true)
  })

  it('a clock with fractions still gives health the integer time the contract asks for', async (t) => {
    const { state } = await connect(t, { options: { now: () => 1234.9 } })
    await state.refresh()
    assert.equal(state.health.lastOkAt, 1234)
    assertHealth(state)
  })
})

describe('HerdrState: listener safety', () => {
  it('a throwing change listener does not reject refresh() and does not silence the listeners after it', async (t) => {
    const { state, log } = await connect(t)
    const seen = []
    state.on('change', () => { throw new Error('listener bug') })
    state.on('change', (snapshot) => seen.push(snapshot.revision))
    const snapshot = await state.refresh() // must not reject
    assert.equal(snapshot.revision, 1)
    assert.deepEqual(seen, [1])
    assert.equal(log.changes.length, 1, 'the listener registered before the thrower ran too')
    assert.equal(log.listenerErrors.length, 1)
    assert.equal(log.listenerErrors[0].error.message, 'listener bug')
    assert.equal(log.listenerErrors[0].event, 'change')
    assert.equal(state.revision, 1)
    assert.equal(state.health.connected, true, 'the cache was already updated when the listener threw')
  })

  it('the same holds for status listeners, and a listener that rejects asynchronously is reported too', async (t) => {
    const { state, log } = await connect(t)
    const seen = []
    state.on('status', () => { throw new Error('status bug') })
    state.on('status', async () => { throw new Error('async status bug') })
    state.on('status', (status) => seen.push(status.status))
    await state.start()
    await until(() => log.listenerErrors.length === 2, { what: 'both reports' })
    assert.deepEqual(seen, ['live'])
    assert.deepEqual(log.listenerErrors.map((entry) => [entry.event, entry.error.message]).sort(), [['status', 'async status bug'], ['status', 'status bug']])
  })

  it('nobody listening for listener-error is fine, and a reporter that itself throws breaks nothing', async (t) => {
    const { state, world } = await connect(t)
    state.removeAllListeners('listener-error')
    state.on('change', () => { throw new Error('first') })
    await state.refresh() // no 'listener-error' listener at all: must not throw

    let reached = false
    state.on('listener-error', () => { throw new Error('the reporter itself') })
    state.on('change', () => { reached = true })
    world.update('w1:p1', { status: 'done' })
    await state.refresh()
    assert.equal(reached, true, 'the listener after the thrower still ran')
    assert.equal(state.revision, 2)
  })

  it('once() listeners fire once', async (t) => {
    const { state, world } = await connect(t)
    let calls = 0
    state.once('change', () => { calls += 1 })
    await state.refresh()
    world.update('w1:p1', { status: 'done' })
    await state.refresh()
    assert.equal(calls, 1)
  })

  it('never emits "error", which would throw when nobody listens', async (t) => {
    const { state, fake } = await connect(t)
    state.removeAllListeners('error')
    state.on('change', () => { throw new Error('bug') })
    await state.start()
    await fake.stop()
    await until(() => state.stale)
    state.stop()
  })
})

describe('HerdrState.stop', () => {
  it('closes the event stream and halts the poll: no timer fires a refresh and nothing more reaches herdr', async (t) => {
    const { state, fake } = await connect(t, { options: { pollIntervalMs: 20 } })
    const calls = spyOnRefresh(state)
    await state.start()
    await until(() => calls.length >= 3, { what: 'a few poll ticks' })
    state.stop()
    await until(() => fake.subscriberCount() === 0, { what: 'the stream to close' })
    const seen = { calls: calls.length, requests: fake.requests.length }
    await sleep(150)
    assert.equal(calls.length, seen.calls, 'a timer still fired after stop()')
    assert.equal(fake.requests.length, seen.requests, 'a request still reached herdr after stop()')
  })

  it('cancels a pending coalesced refresh', async (t) => {
    const { state, fake } = await connect(t, { options: { coalesceMs: 100 } })
    await state.start()
    const calls = spyOnRefresh(state)
    fake.push('pane_updated', { pane_id: 'w1:p1' })
    await sleep(30) // the event has arrived and armed the window
    state.stop()
    await sleep(200)
    assert.equal(calls.length, 0, 'the coalesce timer still fired after stop()')
    assert.equal(fake.requestsOf('session.snapshot').length, 1)
  })

  it('ends a reconnect that is waiting out its backoff', async (t) => {
    const { state, fake, log } = await connect(t, { options: { reconnect: { initialMs: 80, maxMs: 80 } } })
    await state.start()
    fake.dropSubscribers()
    await until(() => log.statuses.at(-1)?.status === 'reconnecting', { what: 'the loss to be noticed' })
    fake.clearRequests()
    state.stop()
    await sleep(250)
    assert.deepEqual(fake.requests, [], 'neither a read nor a new stream after stop()')
    assert.equal(fake.subscriberCount(), 0)
    assert.equal(log.statuses.at(-1).status, 'reconnecting', 'and no further status')
  })

  it('cancels a read on the wire: it rejects, and its late answer never lands', async (t) => {
    const { state, fake, world, log } = await connect(t)
    fake.handle('session.snapshot', async () => {
      const snapshot = world.snapshot()
      await sleep(80)
      return { type: 'session_snapshot', snapshot }
    })
    const pending = state.refresh()
    await sleep(20) // it is on the wire now
    state.stop()
    await assert.rejects(pending, (error) => error instanceof HerdrError)
    await sleep(150) // past the moment herdr would have answered
    assert.equal(state.snapshot, EMPTY_SNAPSHOT)
    assert.equal(state.revision, 0)
    assert.equal(state.health.connected, false)
    assert.equal(state.health.lastOkAt, null)
    assert.equal(log.changes.length, 0)
    assert.equal(log.statuses.length, 0)
  })

  it('cancelling the read on the wire releases its caller at once instead of leaving it to wait for herdr', async (t) => {
    const { state, fake } = await connect(t, { clientOptions: { timeoutMs: 5000 } })
    answerLate(fake, 1500)
    const pending = state.refresh()
    await reachedHerdr(fake, 1)
    const stoppedAt = Date.now()
    state.stop()
    await assert.rejects(pending, (error) => error instanceof HerdrError)
    assert.ok(Date.now() - stoppedAt < 400, `the caller waited ${Date.now() - stoppedAt} ms after stop()`)
  })

  it('a failure that arrives after stop() is not recorded either', async (t) => {
    const { state, fake, log } = await connect(t)
    await state.refresh()
    fake.handle('session.snapshot', async () => {
      await sleep(60)
      throw Object.assign(new Error('late failure'), { code: 'internal_error' })
    })
    const pending = state.refresh()
    await sleep(20)
    state.stop()
    await assert.rejects(pending)
    await sleep(100)
    assert.equal(state.health.connected, true, 'a stopped state does not learn from answers it asked for before')
    assert.equal(state.stale, false)
    assert.equal(log.statuses.length, 0)
  })

  it('makes refresh() reject without a request, and the other entry points inert', async (t) => {
    const { state, fake } = await connect(t, { options: { coalesceMs: 10 } })
    await state.start()
    state.stop()
    fake.clearRequests()
    await assert.rejects(state.refresh(), (error) => error instanceof HerdrError && error.code === 'state_stopped')
    await assert.rejects(state.refresh({ force: true }), (error) => error.code === 'state_stopped')
    state.scheduleRefresh()
    assert.equal(await state.ensureSubscribed(), false)
    await sleep(60)
    assert.deepEqual(fake.requests, [])
  })

  it('rejects a forced refresh that was queued behind the read on the wire, and never sends its follow-up', async (t) => {
    const { state, fake } = await connect(t)
    answerLate(fake, 80)
    const first = state.refresh()
    await reachedHerdr(fake, 1)
    const forced = state.refresh({ force: true })
    const settled = Promise.allSettled([first, forced])
    state.stop()
    const [a, b] = await settled
    assert.equal(a.status, 'rejected')
    assert.equal(b.status, 'rejected')
    assert.equal(b.reason.code, 'state_stopped')
    await sleep(150)
    assert.equal(fake.requestsOf('session.snapshot').length, 1)
  })

  it('a listener that stops the state ends the announcements: nothing fires after stop(), not even the rest of that read', async (t) => {
    const { state, world, log } = await connect(t)
    await state.start()
    assert.deepEqual(log.statuses, [{ status: 'live' }])
    state.once('change', () => state.stop())
    world.update('w1:p1', { status: 'done' })
    await state.refresh()
    assert.equal(log.changes.length, 2, 'the change itself was announced')
    assert.deepEqual(log.statuses, [{ status: 'live' }], 'but the stop that came out of it silenced everything after')
  })

  it('is idempotent, and harmless on a state that never started', async (t) => {
    const { state } = await connect(t)
    state.stop()
    state.stop()
    await state.start()
    state.stop()
    state.stop()
  })

  it('stop() right after start() leaves nothing behind and start() still resolves', async (t) => {
    const { state, fake, log } = await connect(t)
    const starting = state.start()
    state.stop()
    assert.equal(await starting, state)
    await sleep(100)
    assert.equal(fake.subscriberCount(), 0)
    assert.equal(log.changes.length, 0)
    assert.equal(state.revision, 0)
  })

  it('stop() while the stream is still being opened gives up on it: the attempt ends false, promptly, and no event is acted on', async (t) => {
    const { state, fake, client } = await connect(t, { clientOptions: { timeoutMs: 2000 } })
    fake.delayNext('events.subscribe', 80)
    const subscribing = state.ensureSubscribed()
    await sleep(20)
    const stoppedAt = Date.now()
    state.stop()
    assert.equal(await subscribing, false)
    assert.ok(Date.now() - stoppedAt < 500, `it waited ${Date.now() - stoppedAt} ms: for herdr's answer or the client's timeout instead of giving up`)
    assert.equal(client.subscribed, false, 'a stream opened for a stopped state is never adopted')
    await sleep(120) // herdr's delayed answer arrives on a connection that is already gone
    fake.push('pane_updated', { pane_id: 'w1:p1' })
    await sleep(60)
    assert.equal(fake.requestsOf('session.snapshot').length, 0)
  })

  it('a stopped state can be started again', async (t) => {
    const { state, fake, world, log } = await connect(t, { options: { pollIntervalMs: 30 } })
    await state.start()
    state.stop()
    await until(() => fake.subscriberCount() === 0)
    world.update('w1:p1', { status: 'done' })
    await state.start()
    assert.equal(fake.subscriberCount(), 1)
    assert.equal(paneOf(state.snapshot, 'w1:p1').agentStatus, 'done')
    const reads = fake.requestsOf('session.snapshot').length
    await until(() => fake.requestsOf('session.snapshot').length > reads, { what: 'the poll to run again' })
    assert.equal(log.statuses.at(-1).status, 'live')
  })
})

describe('HerdrState: options', () => {
  it('nonsense for pollIntervalMs falls back to the default instead of becoming a busy loop', async (t) => {
    for (const pollIntervalMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '10', null]) {
      const { state, fake } = await connect(t, { options: { pollIntervalMs } })
      await state.start()
      await sleep(80)
      assert.equal(fake.requestsOf('session.snapshot').length, 1, `pollIntervalMs ${String(pollIntervalMs)}`)
      state.stop()
    }
  })

  it('a reconnect cap below the first delay does not shrink the first wait', async (t) => {
    const { state, fake, log } = await connect(t, { options: { reconnect: { initialMs: 40, maxMs: 5 } } })
    await state.start()
    fake.clearRequests()
    const lostAt = Date.now()
    fake.dropSubscribers()
    await until(() => log.statuses.at(-1)?.status === 'live' && log.statuses.length === 3, { what: 'reconnect' })
    assert.ok(fake.requests[0].at - lostAt >= 35, 'the first wait is initialMs even though maxMs is smaller')
  })

  it('a zero initial delay would be a tight retry loop, so it falls back to the default instead', async (t) => {
    const { state, fake, log } = await connect(t, { options: { reconnect: { initialMs: 0, maxMs: 0 } } })
    await state.start()
    fake.clearRequests()
    const lostAt = Date.now()
    fake.dropSubscribers()
    await until(() => log.statuses.length === 3, { what: 'reconnect', timeoutMs: 5000 })
    assert.ok(fake.requests[0].at - lostAt >= 400, `waited ${fake.requests[0].at - lostAt} ms: the 500 ms default`)
  })

  it('can be constructed with nothing but a client: the documented defaults apply', async (t) => {
    const { client } = await connect(t)
    const state = new HerdrState(client)
    assert.equal(state.snapshot, EMPTY_SNAPSHOT)
    assert.equal(state.health.session, null)
    assert.equal(state.health.socket, client.socketPath)
    state.stop()
  })
})

/* -- scripts/parity.mjs ------------------------------------------------------------------------------------------ */

function runParity(args, { socketPath, home }) {
  // An explicit environment, never the caller's: HOME and XDG_CONFIG_HOME point at an empty directory so that even if the
  // socket path given is dead, discovery has no other candidate and cannot find a real herdr's socket.
  const env = { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: home, HERDR_SOCKET_PATH: socketPath }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PARITY, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

const SECRET = 'secret-title-0451'

function parityWorld() {
  return createWorld({
    workspaces: [{
      id: 'w1',
      label: 'demo',
      tabs: [{
        id: 'w1:t1',
        label: 'main',
        panes: [
          { id: 'w1:p1', title: SECRET, cwd: '/Users/demo/secret-cwd-0451', agent: { kind: 'claude', name: 'secret-name-0451', status: 'working' } },
          { id: 'w1:p2', title: 'tester', agent: { kind: 'codex', status: 'idle' } },
          { id: 'w1:p3', title: 'zsh' },
        ],
      }],
    }],
  })
}

describe('scripts/parity.mjs', () => {
  async function arrange(t, { listening = true } = {}) {
    const fake = await startFakeHerdr({ world: parityWorld() })
    if (!listening) await fake.stop()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-home-'))
    t.after(async () => {
      await fake.close()
      fs.rmSync(home, { recursive: true, force: true })
    })
    const cliFile = (value) => {
      const file = path.join(home, 'cli.json')
      fs.writeFileSync(file, JSON.stringify(value))
      return file
    }
    return { fake, home, cliFile }
  }

  it('agrees with a CLI snapshot of the same world: exit 0, and only ping and session.snapshot reached herdr', async (t) => {
    const { fake, home, cliFile } = await arrange(t)
    const file = cliFile({ result: { type: 'session_snapshot', snapshot: fake.world.snapshot() } })
    const { code, stdout, stderr } = await runParity(['--cli-json', file], { socketPath: fake.socketPath, home })
    assert.equal(code, 0, stderr)
    assert.match(stdout, /herdr 0\.9\.5 · protocol 22 · panes: api 3, cli 3/)
    assert.match(stdout, /no mismatches/)
    assert.deepEqual(fake.requests.map((request) => request.method), ['ping', 'session.snapshot'])
    assert.deepEqual(fake.writeRequests(), [])
  })

  it('--json prints one document with the verdict', async (t) => {
    const { fake, home, cliFile } = await arrange(t)
    const file = cliFile({ snapshot: fake.world.snapshot() })
    const { code, stdout } = await runParity(['--json', `--cli-json=${file}`], { socketPath: fake.socketPath, home })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), { ok: true, herdr: { version: '0.9.5', protocol: 22 }, panes: { api: 3, cli: 3 }, mismatches: [] })
  })

  it('reports mismatches by pane id, field and (for status and revision) values, exits 1, and never prints text', async (t) => {
    const { fake, home, cliFile } = await arrange(t)
    const other = parityWorld()
    other.update('w1:p1', { status: 'blocked', title: 'another-title-0451', name: 'another-name-0451' }) // status, title, name and revision differ
    other.closePane('w1:p3')
    other.addPane('w1:t1', { id: 'w1:p9', title: 'late', agent: { kind: 'pi', status: 'idle' } })
    const file = cliFile({ snapshot: other.snapshot() })

    const text = await runParity(['--cli-json', file], { socketPath: fake.socketPath, home })
    assert.equal(text.code, 1)
    for (const expected of [/w1:p1\s+agentStatus\s+working\s+blocked/, /w1:p1\s+revision\s+1\s+2/, /w1:p1\s+title/, /w1:p1\s+agentName/, /w1:p3\s+pane\s+present\s+missing/, /w1:p9\s+pane\s+missing\s+present/]) {
      assert.match(text.stdout, expected)
    }
    const json = await runParity(['--json', '--cli-json', file], { socketPath: fake.socketPath, home })
    assert.equal(json.code, 1)
    const report = JSON.parse(json.stdout)
    assert.equal(report.ok, false)
    assert.deepEqual(report.mismatches.map((mismatch) => `${mismatch.pane} ${mismatch.field}`), [
      'w1:p1 agentStatus', 'w1:p1 revision', 'w1:p1 title', 'w1:p1 agentName', 'w1:p3 pane', 'w1:p9 pane',
    ])
    for (const output of [text.stdout, text.stderr, json.stdout, json.stderr]) {
      for (const secret of [SECRET, 'another-title-0451', 'secret-name-0451', 'another-name-0451', 'secret-cwd-0451', 'tester']) {
        assert.ok(!output.includes(secret), `the output leaked ${secret}`)
      }
    }
    assert.deepEqual(fake.requests.map((request) => request.method).filter((method) => method !== 'ping' && method !== 'session.snapshot'), [])
  })

  it('exits 2 when herdr cannot be reached, and says where it looked', async (t) => {
    const { fake, home, cliFile } = await arrange(t, { listening: false })
    const file = cliFile({ snapshot: parityWorld().snapshot() })
    const { code, stdout, stderr } = await runParity(['--cli-json', file], { socketPath: fake.socketPath, home })
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.ok(stderr.includes(`herdr is not reachable at ${fake.socketPath}`), stderr)
  })

  it('exits 2 when the CLI side cannot be read, or the arguments make no sense', async (t) => {
    const { fake, home } = await arrange(t)
    const missing = await runParity(['--cli-json', path.join(home, 'absent.json')], { socketPath: fake.socketPath, home })
    assert.equal(missing.code, 2)
    assert.match(missing.stderr, /cannot read/)

    fs.writeFileSync(path.join(home, 'junk.json'), 'not json')
    const junk = await runParity(['--cli-json', path.join(home, 'junk.json')], { socketPath: fake.socketPath, home })
    assert.equal(junk.code, 2)
    assert.match(junk.stderr, /not JSON/)

    fs.writeFileSync(path.join(home, 'empty.json'), '{"ok":true}')
    const empty = await runParity(['--cli-json', path.join(home, 'empty.json')], { socketPath: fake.socketPath, home })
    assert.equal(empty.code, 2)
    assert.match(empty.stderr, /no panes list/)

    const before = fake.requests.length
    const unknown = await runParity(['--nonsense'], { socketPath: fake.socketPath, home })
    assert.equal(unknown.code, 2)
    assert.match(unknown.stderr, /usage:/)
    const noFile = await runParity(['--cli-json'], { socketPath: fake.socketPath, home })
    assert.equal(noFile.code, 2)
    assert.equal(fake.requests.length, before, 'bad usage is refused before anything is sent to herdr')
  })

  it('--help prints the usage and exits 0 without touching herdr', async (t) => {
    const { fake, home } = await arrange(t)
    const { code, stdout } = await runParity(['--help'], { socketPath: fake.socketPath, home })
    assert.equal(code, 0)
    assert.match(stdout, /usage:/)
    assert.equal(fake.requests.length, 0)
  })

  describe('compareSnapshots / extractSnapshot', () => {
    const normalized = (world) => normalizeSnapshot(world.snapshot())

    it('finds the snapshot in every shape the CLI might print it in', () => {
      const snapshot = parityWorld().snapshot()
      for (const shape of [{ result: { type: 'session_snapshot', snapshot } }, { snapshot }, { result: snapshot }, snapshot]) {
        assert.equal(extractSnapshot(shape).panes.length, 3)
      }
      for (const junk of [null, undefined, 3, 'x', {}, { result: {} }, { snapshot: { panes: 'nope' } }]) assert.equal(extractSnapshot(junk), null)
    })

    it('no differences for the same world; ids are sorted naturally; text fields are flagged, never carried', () => {
      const a = normalized(parityWorld())
      assert.deepEqual(compareSnapshots(a, normalized(parityWorld())), [])

      const b = parityWorld()
      b.addPane('w1:t1', { id: 'w1:p10', title: 'ten' })
      b.addPane('w1:t1', { id: 'w1:p2x', title: 'x' })
      b.update('w1:p1', { title: 'other' })
      const found = compareSnapshots(a, normalized(b))
      assert.deepEqual(found.map((mismatch) => `${mismatch.pane}:${mismatch.field}`), ['w1:p1:revision', 'w1:p1:title', 'w1:p2x:pane', 'w1:p10:pane'])
      const title = found.find((mismatch) => mismatch.field === 'title')
      assert.deepEqual(title, { pane: 'w1:p1', field: 'title', api: null, cli: null, redacted: true })
    })

    it('an unnamed agent against a named one differs on agentName', () => {
      const a = parityWorld()
      const b = parityWorld()
      b.update('w1:p2', { name: 'now-named' })
      const fields = compareSnapshots(normalized(a), normalized(b)).filter((mismatch) => mismatch.pane === 'w1:p2').map((mismatch) => mismatch.field)
      assert.deepEqual(fields, ['revision', 'agentName'])
    })
  })
})
