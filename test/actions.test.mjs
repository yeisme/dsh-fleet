import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HerdrClient, HerdrError } from '../lib/herdr/protocol.js'
import { EMPTY_SNAPSHOT, normalizeSnapshot } from '../lib/herdr/normalize.js'
import { createActions, mapHerdrError, validateRequest } from '../lib/fleet/actions.js'
import { FleetError, STATUS_BY_REASON } from '../lib/fleet/errors.js'
import { loadContract, validateDef } from '../lib/fleet/schema.js'
import { startFakeHerdr } from './helpers/fake-herdr.js'
import { createWorld } from './helpers/wire.js'

/** A bug in the lock or in a flow can deadlock instead of failing; every suite therefore fails fast instead of hanging CI. */
const SUITE = { timeout: 30_000 }

const contract = loadContract()
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/fleet.json', import.meta.url), 'utf8'))
const hostDoc = readFileSync(new URL('../docs/design/FLEET-HOST.md', import.meta.url), 'utf8')

const VERBS = contract.$defs.ActResponse.properties.verb.enum
const WRITE_VERBS = VERBS // every verb of the contract writes something
const requestDef = (verb) => `${verb[0].toUpperCase()}${verb.slice(1)}Request`
/** The hyphen form of the interrupt chord; built, never written out, so the hard-rule scanner stays meaningful. */
const HYPHEN_CHORD = ['ctrl', 'c'].join('-')

// ---------------------------------------------------------------------------------------------------------------
// A small fleet on the fake herdr. Revisions are distinct so a mix-up between panes cannot pass by accident.
// ---------------------------------------------------------------------------------------------------------------

const BLOCKED = 'w1:p1' // waiting on a question; the user was looking at revision 412
const WORKING = 'w1:p2'
const IDLE = 'w1:p3'
const SHELL = 'w1:p4'
const DONE = 'w1:p5'
const UNKNOWN = 'w1:p6'
const OTHER = 'w2:p1' // a second blocked agent in another workspace
const BLOCKED_REVISION = 412

const buildWorld = () => createWorld({
  workspaces: [
    {
      id: 'w1',
      label: 'dsh-threads-dev',
      tabs: [{
        id: 'w1:t1',
        label: 'main',
        panes: [
          { id: BLOCKED, title: 'reviewer', revision: BLOCKED_REVISION, screen: 'Do you want to proceed?', agent: { kind: 'claude', name: 'dsh-reviewer', status: 'blocked' } },
          { id: WORKING, title: 'builder', revision: 20, agent: { kind: 'codex', status: 'working' } },
          { id: IDLE, title: 'idle one', revision: 30, agent: { kind: 'pi', status: 'idle' } },
          { id: SHELL, title: 'zsh', revision: 5 },
          { id: DONE, title: 'finished', revision: 40, agent: { kind: 'grok', status: 'done' } },
          { id: UNKNOWN, title: 'mystery', revision: 50, agent: { kind: 'gemini', status: 'unknown' } },
        ],
      }],
    },
    { id: 'w2', label: 'docs', tabs: [{ id: 'w2:t1', label: 'notes', panes: [{ id: OTHER, title: 'writer', revision: 60, agent: { kind: 'opencode', status: 'blocked' } }] }] },
  ],
})

/** One valid request per verb for a pane (revision matters only to answer/keys). */
const REQUESTS = {
  prompt: (pane) => ({ verb: 'prompt', pane, text: 'continue with the plan' }),
  answer: (pane, revision = 1) => ({ verb: 'answer', pane, text: 'use dist only', enter: true, expectRevision: revision }),
  keys: (pane, revision = 1) => ({ verb: 'keys', pane, keys: ['1', 'enter'], expectRevision: revision }),
  interrupt: (pane) => ({ verb: 'interrupt', pane }),
  rename: (pane) => ({ verb: 'rename', pane, name: 'dsh-notes' }),
  restart: (pane) => ({ verb: 'restart', pane, confirm: true }),
  close: (pane) => ({ verb: 'close', pane, confirm: true }),
}
const everyVerb = (pane, revision) => WRITE_VERBS.map((verb) => REQUESTS[verb](pane, revision))

/** HerdrState-shaped, built from the fake's own snapshot. `refresh()` re-reads it through the real client. */
function createStateStub(client) {
  const state = {
    snapshot: EMPTY_SNAPSHOT,
    stale: false,
    health: { connected: true, socket: null, version: null, protocol: null, lastOkAt: null, error: null, session: null },
    refreshCalls: [],
    refreshError: null,
    async refresh(options) {
      state.refreshCalls.push(options)
      if (state.refreshError) throw state.refreshError
      state.snapshot = normalizeSnapshot(await client.request('session.snapshot', {}))
      return state.snapshot
    },
  }
  return state
}

/** Every herdr method any test below made the host call: the last describe checks them against FLEET-HOST.md §4. */
const usedMethods = new Set()
/** Every harness ever booted, for the file-level cleanup. */
const booted = []

async function boot({ policy = 'all', dshPanes = [], timeoutMs = 1000, world = buildWorld(), wrapClient = (client) => client, now } = {}) {
  const fake = await startFakeHerdr({ world })
  const client = new HerdrClient({ socketPath: fake.socketPath, timeoutMs })
  const state = createStateStub(client)
  await state.refresh()
  state.refreshCalls.length = 0
  const harvest = () => { for (const request of fake.requests) usedMethods.add(request.method) }
  const clear = fake.clearRequests
  fake.clearRequests = () => { harvest(); clear() }
  fake.clearRequests()
  const store = { policy, dshPanes: new Set(dshPanes) }
  const logs = []
  const sleeps = []
  const options = { client: wrapClient(client, fake), state, store, log: (entry) => logs.push(entry), sleep: async (ms) => { sleeps.push(ms) } }
  if (now) options.now = now
  const { act } = createActions(options)
  const harness = {
    fake, client, state, store, logs, sleeps, act,
    async close() {
      harvest()
      client.close()
      await fake.close() // idempotent: a harness may be closed by its test and again by the file-level cleanup
    },
  }
  booted.push(harness)
  return harness
}

// A test that is cut off by its timeout never reaches its own `finally`; without this the fake's listening socket would
// keep the whole test process alive and a deadlock would look like a hang instead of a failure.
after(async () => {
  for (const harness of booted) await harness.close()
})

const methods = (fake) => fake.requests.map((request) => request.method)
const calls = (fake) => fake.requests.map(({ method, params }) => [method, params])
const revisionOf = (h, pane) => h.fake.world.paneInfo(pane).revision

async function refusal(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  return assert.fail('expected the request to be refused')
}

/** `status` is passed as a literal by each describe, so the HTTP numbers are pinned independently of the table. */
function assertRefusal(error, { reason, status, detail, message }) {
  assert.ok(error instanceof FleetError, `a FleetError, got: ${error?.stack ?? error}`)
  assert.equal(error.reason, reason)
  assert.equal(error.status, status)
  assert.equal(error.status, STATUS_BY_REASON[reason])
  assert.deepEqual(error.detail, detail)
  assert.ok(typeof error.message === 'string' && error.message.length > 0, 'a one-line message for a person')
  if (message) assert.match(error.message, message)
  assert.deepEqual(validateDef(contract, 'ErrorResponse', error.toResponse()).errors, [], 'the error is a valid ErrorResponse')
}

async function until(condition, { timeoutMs = 3000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A client that lets one call through and then takes herdr away: the socket dies between "checked" and "written". */
const dyingAfter = (method) => (client, fake) => {
  let armed = true
  return {
    async request(name, params, options) {
      const result = await client.request(name, params, options)
      if (armed && name === method) {
        armed = false
        await fake.stop()
      }
      return result
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The seven state-dependent rejections FLEET-API.md §8 says the host tests must name, one describe per reason.
// Each asserts status, reason, detail, and that herdr was never written to.
// ---------------------------------------------------------------------------------------------------------------

describe('unknown-pane', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot() })
  afterEach(() => h.close())

  it('a pane id that does not exist: 404 for every verb, and herdr hears nothing at all', async () => {
    for (const request of everyVerb('w9:p9')) assertRefusal(await refusal(h.act(request)), { reason: 'unknown-pane', status: 404 })
    assert.deepEqual(h.fake.writeRequests(), [])
    assert.deepEqual(h.fake.requests, [], 'decided from the cache alone: not even a read')
  })

  it('a pane that was closed, as far as the cache knows: unknown too, for every verb', async () => {
    h.fake.world.closePane(WORKING)
    await h.state.refresh()
    h.fake.clearRequests()
    for (const request of everyVerb(WORKING)) assertRefusal(await refusal(h.act(request)), { reason: 'unknown-pane', status: 404 })
    assert.deepEqual(h.fake.writeRequests(), [])
    assert.deepEqual(h.fake.requests, [])
  })

  it('a pane closed behind the cache (answer and keys): the fresh read says so, and still nothing is written', async () => {
    h.fake.world.closePane(BLOCKED)
    for (const request of [REQUESTS.answer(BLOCKED, BLOCKED_REVISION), REQUESTS.keys(BLOCKED, BLOCKED_REVISION)]) {
      h.fake.clearRequests()
      assertRefusal(await refusal(h.act(request)), { reason: 'unknown-pane', status: 404 })
      assert.deepEqual(h.fake.writeRequests(), [])
      assert.deepEqual(methods(h.fake), ['pane.get'])
    }
  })

  it('a pane closed behind the cache (interrupt): herdr refuses it, nothing is typed anywhere, and it is still a 404', async () => {
    h.fake.world.closePane(WORKING)
    assertRefusal(await refusal(h.act(REQUESTS.interrupt(WORKING))), { reason: 'unknown-pane', status: 404 })
    assert.equal(h.fake.world.pane(WORKING), null)
  })
})

describe('not-an-agent', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot() })
  afterEach(() => h.close())

  it('every verb on a plain shell: 409, and herdr hears nothing at all', async () => {
    for (const request of everyVerb(SHELL)) assertRefusal(await refusal(h.act(request)), { reason: 'not-an-agent', status: 409 })
    assert.deepEqual(h.fake.writeRequests(), [])
    assert.deepEqual(h.fake.requests, [])
    assert.ok(h.fake.world.pane(SHELL), 'the shell was not closed by a close that should have been refused')
  })

  it('is what a shell gets under every policy: it outranks policy-denied, even for a pane on the DSH list', async () => {
    for (const [policy, dshPanes] of [['read-only', []], ['dsh-only', []], ['dsh-only', [SHELL]], ['all', [SHELL]]]) {
      h.store.policy = policy
      h.store.dshPanes = new Set(dshPanes)
      for (const request of everyVerb(SHELL)) assertRefusal(await refusal(h.act(request)), { reason: 'not-an-agent', status: 409 })
    }
    assert.deepEqual(h.fake.requests, [])
  })

  it('and while herdr is down: the intrinsic reason outranks the outage', async () => {
    h.state.stale = true
    h.state.health.connected = false
    for (const request of everyVerb(SHELL)) assertRefusal(await refusal(h.act(request)), { reason: 'not-an-agent', status: 409 })
    assert.deepEqual(h.fake.requests, [])
  })
})

describe('policy-denied', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot() })
  afterEach(() => h.close())

  it('read-only refuses EVERY verb: 403 with detail.policy, and herdr hears nothing at all', async () => {
    h.store.policy = 'read-only'
    assert.deepEqual(WRITE_VERBS.length, 7)
    for (const request of everyVerb(BLOCKED, BLOCKED_REVISION)) {
      assertRefusal(await refusal(h.act(request)), { reason: 'policy-denied', status: 403, detail: { policy: 'read-only' } })
    }
    assert.deepEqual(h.fake.writeRequests(), [])
    assert.deepEqual(h.fake.requests, [])
  })

  it('dsh-only refuses every verb on a pane DSH did not create: 403 with detail.policy', async () => {
    h.store.policy = 'dsh-only'
    h.store.dshPanes = new Set([WORKING]) // some other pane is DSH-created; this one is not
    for (const request of everyVerb(BLOCKED, BLOCKED_REVISION)) {
      assertRefusal(await refusal(h.act(request)), { reason: 'policy-denied', status: 403, detail: { policy: 'dsh-only' } })
    }
    assert.deepEqual(h.fake.writeRequests(), [])
    assert.deepEqual(h.fake.requests, [])
  })

  it('dsh-only lets a DSH-created pane through (the control: the policy, and nothing else, was what refused)', async () => {
    h.store.policy = 'dsh-only'
    h.store.dshPanes = new Set([WORKING])
    assert.equal((await h.act(REQUESTS.interrupt(WORKING))).ok, true)
    assert.deepEqual(h.fake.writeRequests().map((request) => request.method), ['pane.send_keys'])
  })

  it('a policy value it does not know is read as read-only, and reported as one of the contract\'s', async () => {
    for (const policy of ['write', '', null, undefined, 3, 'ALL']) {
      h.store.policy = policy
      assertRefusal(await refusal(h.act(REQUESTS.interrupt(WORKING))), { reason: 'policy-denied', status: 403, detail: { policy: 'read-only' } })
    }
    assert.deepEqual(h.fake.requests, [])
  })

  it('the policy is read on every request, not captured when the actions were built', async () => {
    assert.equal((await h.act(REQUESTS.interrupt(WORKING))).ok, true)
    h.store.policy = 'read-only'
    assertRefusal(await refusal(h.act(REQUESTS.interrupt(WORKING))), { reason: 'policy-denied', status: 403, detail: { policy: 'read-only' } })
    assert.equal(h.fake.requestsOf('pane.send_keys').length, 1, 'only the first interrupt was sent')
  })

  it('is decided again once the lock is ours: a policy changed while a request queued applies to that request', async () => {
    h.fake.delayNext('pane.get', 150) // holds the first action inside the lock
    const first = h.act(REQUESTS.answer(BLOCKED, BLOCKED_REVISION))
    await until(() => h.fake.requestsOf('pane.get').length === 1, { what: 'the first action to be inside the lock' })
    const second = h.act({ verb: 'keys', pane: BLOCKED, keys: ['esc'], expectRevision: BLOCKED_REVISION })
    h.store.policy = 'read-only' // the operator tightens the policy while the second request waits
    const [a, b] = await Promise.allSettled([first, second])
    assert.equal(a.status, 'fulfilled', 'the first was admitted under the old policy')
    assertRefusal(b.reason, { reason: 'policy-denied', status: 403, detail: { policy: 'read-only' } })
    assert.deepEqual(h.fake.writeRequests().filter((request) => JSON.stringify(request.params.keys) === '["esc"]'), [], 'nothing of the queued request was sent')
  })

  it('outranks an outage: the policy is not hidden behind "herdr is down"', async () => {
    h.store.policy = 'read-only'
    h.state.stale = true
    h.state.health.connected = false
    assertRefusal(await refusal(h.act(REQUESTS.interrupt(WORKING))), { reason: 'policy-denied', status: 403, detail: { policy: 'read-only' } })
  })
})

describe('herdr-offline', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot() })
  afterEach(() => h.close())

  it('a stale snapshot: 503 for every verb, and nothing is sent', async () => {
    h.state.stale = true
    h.state.health.connected = false
    for (const request of everyVerb(BLOCKED, BLOCKED_REVISION)) assertRefusal(await refusal(h.act(request)), { reason: 'herdr-offline', status: 503 })
    assert.deepEqual(h.fake.writeRequests(), [])
    assert.deepEqual(h.fake.requests, [])
  })

  it('either signal is enough: a connection that is down with no stale flag, and a stale flag with a connection that claims to be up', async () => {
    h.state.health.connected = false
    assertRefusal(await refusal(h.act(REQUESTS.interrupt(WORKING))), { reason: 'herdr-offline', status: 503 })
    h.state.health.connected = true
    h.state.stale = true
    assertRefusal(await refusal(h.act(REQUESTS.interrupt(WORKING))), { reason: 'herdr-offline', status: 503 })
    assert.deepEqual(h.fake.requests, [])
  })

  it('a state with no health at all is not trusted to be up', async () => {
    delete h.state.health
    assertRefusal(await refusal(h.act(REQUESTS.interrupt(WORKING))), { reason: 'herdr-offline', status: 503 })
    assert.deepEqual(h.fake.requests, [])
  })

  it('never connected (an empty cache): it is offline, not "unknown pane": the cache cannot say a pane does not exist', async () => {
    h.state.snapshot = EMPTY_SNAPSHOT
    h.state.health.connected = false
    assertRefusal(await refusal(h.act(REQUESTS.interrupt(WORKING))), { reason: 'herdr-offline', status: 503 })
    h.state.stale = true
    assertRefusal(await refusal(h.act(REQUESTS.interrupt('w9:p9'))), { reason: 'herdr-offline', status: 503 }, 'a stale cache cannot rule a pane out either')
    assert.deepEqual(h.fake.requests, [])
  })

  it('the socket dying between the cache check and the write: 503, and nothing is typed (answer)', async () => {
    await h.close()
    h = await boot({ wrapClient: dyingAfter('pane.get') })
    const error = await refusal(h.act(REQUESTS.answer(BLOCKED, BLOCKED_REVISION)))
    assertRefusal(error, { reason: 'herdr-offline', status: 503, message: /nothing was sent/i })
    assert.deepEqual(methods(h.fake), ['pane.get'], 'the fresh read went through; the write never got to herdr; no Enter was attempted')
    assert.deepEqual(h.fake.writeRequests(), [])
    assert.equal(h.state.refreshCalls.length, 0)
  })

  it('the socket dying between the cache check and the write: 503 for keys too', async () => {
    await h.close()
    h = await boot({ wrapClient: dyingAfter('pane.get') })
    assertRefusal(await refusal(h.act(REQUESTS.keys(BLOCKED, BLOCKED_REVISION))), { reason: 'herdr-offline', status: 503, message: /nothing was sent/i })
    assert.deepEqual(h.fake.writeRequests(), [])
  })

  it('herdr already gone when a write goes out (the cache still said up): 503, saying nothing was sent', async () => {
    await h.fake.stop()
    assertRefusal(await refusal(h.act(REQUESTS.interrupt(WORKING))), { reason: 'herdr-offline', status: 503, message: /nothing was sent/i })
    assertRefusal(await refusal(h.act(REQUESTS.rename(WORKING))), { reason: 'herdr-offline', status: 503 })
    assert.deepEqual(h.fake.writeRequests(), [])
  })

  it('a connection that drops mid-request is also 503, but it does not claim nothing was sent', async () => {
    h.fake.dropNext('pane.send_keys')
    const error = await refusal(h.act(REQUESTS.interrupt(WORKING)))
    assertRefusal(error, { reason: 'herdr-offline', status: 503, message: /UNKNOWN/ })
    assert.doesNotMatch(error.message, /nothing was sent/i)
  })

  it('and the same drop during a read is harmless to say: nothing was written', async () => {
    h.fake.dropNext('pane.get')
    const error = await refusal(h.act(REQUESTS.answer(BLOCKED, BLOCKED_REVISION)))
    assertRefusal(error, { reason: 'herdr-offline', status: 503, message: /nothing was sent/i })
    assert.deepEqual(h.fake.writeRequests(), [])
  })
})

describe('agent-blocked', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot() })
  afterEach(() => h.close())

  it('prompt to an agent the cache shows as blocked: 409 with detail.status, and herdr hears nothing at all', async () => {
    assertRefusal(await refusal(h.act(REQUESTS.prompt(BLOCKED))), { reason: 'agent-blocked', status: 409, detail: { status: 'blocked' } })
    assert.deepEqual(h.fake.writeRequests(), [])
    assert.deepEqual(h.fake.requests, [])
  })

  it('the cache is stale (the agent got blocked after the last refresh): herdr refuses, and it is reported, never typed instead', async () => {
    h.fake.world.update(IDLE, { status: 'blocked' }) // the host has not seen this yet
    assertRefusal(await refusal(h.act({ verb: 'prompt', pane: IDLE, text: 'start the next task' })), { reason: 'agent-blocked', status: 409, detail: { status: 'blocked' } })
    assert.deepEqual(methods(h.fake), ['agent.prompt'], 'one attempt, which herdr refused; no pane.send_text, no pane.send_keys, no retry')
    assert.equal(h.state.refreshCalls.length, 0, 'a failure does not trigger the post-write refresh')
  })

  it('recognised by herdr\'s wording alone, whatever the error code', async () => {
    h.fake.failNext('agent.prompt', { code: 'some_future_code', message: 'You must Answer the question on screen first.' })
    assertRefusal(await refusal(h.act(REQUESTS.prompt(IDLE))), { reason: 'agent-blocked', status: 409, detail: { status: 'blocked' } })
    assert.deepEqual(methods(h.fake), ['agent.prompt'])
  })

  it('and by herdr\'s code alone, whatever the wording', async () => {
    h.fake.failNext('agent.prompt', { code: 'agent_blocked', message: 'no' })
    assertRefusal(await refusal(h.act(REQUESTS.prompt(IDLE))), { reason: 'agent-blocked', status: 409, detail: { status: 'blocked' } })
  })

  it('any other herdr refusal of a prompt is not dressed up as one', async () => {
    h.fake.failNext('agent.prompt', { code: 'queue_full', message: 'too many prompts' })
    assertRefusal(await refusal(h.act(REQUESTS.prompt(IDLE))), { reason: 'herdr-error', status: 502, detail: { code: 'queue_full' } })
  })
})

describe('not-blocked', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot() })
  afterEach(() => h.close())

  for (const [status, pane] of [['working', WORKING], ['idle', IDLE], ['done', DONE], ['unknown', UNKNOWN]]) {
    it(`answer to a ${status} agent: 409, and herdr is only asked to read`, async () => {
      assertRefusal(await refusal(h.act({ verb: 'answer', pane, text: 'yes', enter: true, expectRevision: revisionOf(h, pane) })), { reason: 'not-blocked', status: 409 })
      assert.deepEqual(h.fake.writeRequests(), [])
      assert.deepEqual(methods(h.fake), ['pane.get'])
    })
  }

  it('is judged on the fresh status, not the cache: the cache says blocked, the agent has moved on', async () => {
    h.fake.world.update(BLOCKED, { status: 'working' }) // the host has not seen it yet
    assertRefusal(await refusal(h.act(REQUESTS.answer(BLOCKED, revisionOf(h, BLOCKED)))), { reason: 'not-blocked', status: 409 })
    assert.deepEqual(h.fake.writeRequests(), [])
  })

  it('and the other way round: a cache that says idle does not stop an answer to an agent that IS blocked now', async () => {
    h.fake.world.update(IDLE, { status: 'blocked' })
    assert.equal((await h.act({ verb: 'answer', pane: IDLE, text: 'ok', enter: false, expectRevision: revisionOf(h, IDLE) })).ok, true)
    assert.deepEqual(h.fake.writeRequests().map((request) => request.method), ['pane.send_text'])
  })

  it('is checked before the revision: a stale revision on an agent that is not waiting is "not-blocked", not "screen-changed"', async () => {
    assertRefusal(await refusal(h.act({ verb: 'answer', pane: WORKING, text: 'yes', enter: true, expectRevision: 1 })), { reason: 'not-blocked', status: 409 })
  })

  it('keys do not need a blocked agent (approvals, the screen view\'s key bar): only answer does', async () => {
    assert.equal((await h.act({ verb: 'keys', pane: WORKING, keys: ['esc'], expectRevision: revisionOf(h, WORKING) })).ok, true)
  })
})

describe('screen-changed', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot() })
  afterEach(() => h.close())

  for (const verb of ['answer', 'keys']) {
    it(`${verb} with a stale expectRevision: 409, detail.revision is the CURRENT value, nothing is written, exactly one read, no retry`, async () => {
      h.fake.world.touch(BLOCKED)
      h.fake.world.touch(BLOCKED) // the agent printed more after the user looked
      const current = revisionOf(h, BLOCKED)
      assert.equal(current, BLOCKED_REVISION + 2)
      assertRefusal(await refusal(h.act(REQUESTS[verb](BLOCKED, BLOCKED_REVISION))), { reason: 'screen-changed', status: 409, detail: { revision: current } })
      assert.deepEqual(h.fake.writeRequests(), [])
      assert.deepEqual(methods(h.fake), ['pane.get'], 'one fresh read; the host did not retry, and did not re-send with the new revision')
      assert.equal(h.logs.length, 1)
    })
  }

  it('no tolerance: one revision off in either direction, and a revision from the future, are all a changed screen', async () => {
    for (const expected of [BLOCKED_REVISION - 1, BLOCKED_REVISION + 1, BLOCKED_REVISION + 1000, 0]) {
      h.fake.clearRequests()
      assertRefusal(await refusal(h.act(REQUESTS.keys(BLOCKED, expected))), { reason: 'screen-changed', status: 409, detail: { revision: BLOCKED_REVISION } })
      assertRefusal(await refusal(h.act(REQUESTS.answer(BLOCKED, expected))), { reason: 'screen-changed', status: 409, detail: { revision: BLOCKED_REVISION } })
      assert.deepEqual(h.fake.writeRequests(), [], `expectRevision ${expected}`)
    }
  })

  it('the pane changed AFTER the cache was taken (the user saw exactly what the cache has): only the fresh read catches it', async () => {
    assert.equal(h.state.snapshot.panes.find((pane) => pane.id === BLOCKED).revision, BLOCKED_REVISION, 'the cache is at the revision the user saw')
    h.fake.world.touch(BLOCKED) // ...but the screen has moved since, and the cache does not know
    for (const verb of ['answer', 'keys']) {
      h.fake.clearRequests()
      assertRefusal(await refusal(h.act(REQUESTS[verb](BLOCKED, BLOCKED_REVISION))), { reason: 'screen-changed', status: 409, detail: { revision: BLOCKED_REVISION + 1 } })
      assert.deepEqual(h.fake.writeRequests(), [])
    }
  })

  it('the client\'s own choice to ask again with the revision it was given is just another request: refused until it matches', async () => {
    h.fake.world.touch(BLOCKED)
    const first = await refusal(h.act(REQUESTS.keys(BLOCKED, BLOCKED_REVISION)))
    assert.equal(first.detail.revision, BLOCKED_REVISION + 1)
    h.fake.world.touch(BLOCKED) // moved again before the client could react
    assertRefusal(await refusal(h.act(REQUESTS.keys(BLOCKED, first.detail.revision))), { reason: 'screen-changed', status: 409, detail: { revision: BLOCKED_REVISION + 2 } })
    assert.deepEqual(h.fake.writeRequests(), [])
  })

  it('a revision that herdr does not report is not "equal to anything": the host refuses and says herdr answered oddly', async () => {
    for (const pane of [{}, { revision: null }, { revision: '412' }, { revision: 4.5 }, { revision: -1 }, undefined]) {
      h.fake.handle('pane.get', () => ({ type: 'pane_info', pane }))
      assertRefusal(await refusal(h.act(REQUESTS.keys(BLOCKED, BLOCKED_REVISION))), { reason: 'herdr-error', status: 502, detail: { code: 'bad_reply' } })
    }
    assert.deepEqual(h.fake.writeRequests(), [])
  })
})

describe('confirm-required', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot() })
  afterEach(() => h.close())

  const notTrue = [['"true"', 'true'], ['"yes"', 'yes'], ['"True"', 'True'], ['1', 1], ['0', 0], ['false', false], ['null', null], ['[true]', [true]], ['{}', {}], ['""', '']]

  for (const verb of ['restart', 'close']) {
    for (const [label, confirm] of notTrue) {
      it(`${verb} with confirm ${label}: 400, and nothing happens (not even a read)`, async () => {
        assertRefusal(await refusal(h.act({ verb, pane: WORKING, confirm })), { reason: 'confirm-required', status: 400 })
        assert.deepEqual(h.fake.requests, [])
        assert.ok(h.fake.world.pane(WORKING), 'the pane is still there')
      })
    }

    it(`${verb} with no confirm field at all: 400, and nothing happens`, async () => {
      assertRefusal(await refusal(h.act({ verb, pane: WORKING })), { reason: 'confirm-required', status: 400 })
      assert.deepEqual(h.fake.requests, [])
    })
  }

  it('is decided before anything else about the request: before a missing pane, an extra field, a pane that does not exist', async () => {
    for (const request of [{ verb: 'close' }, { verb: 'close', confirm: 'yes', extra: 1 }, { verb: 'restart', pane: 'w9:p9', confirm: 1 }, { verb: 'restart', pane: 12, confirm: false, thenPrompt: '' }]) {
      assertRefusal(await refusal(h.act(request)), { reason: 'confirm-required', status: 400 })
    }
    assert.deepEqual(h.fake.requests, [])
  })

  it('exactly the boolean true gets past it (the control)', async () => {
    h.fake.handle('agent.start', (params) => ({ type: 'agent_started', agent: { pane_id: params.pane_id }, argv: [] }))
    assert.equal((await h.act({ verb: 'restart', pane: WORKING, confirm: true })).ok, true)
    assert.equal((await h.act({ verb: 'close', pane: WORKING, confirm: true })).ok, true)
    assert.equal(h.fake.world.pane(WORKING), null)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Validation (pure) and its conformance with the contract
// ---------------------------------------------------------------------------------------------------------------

/** FLEET-API.md §6 steps 2-6, as executable as test/contract.test.mjs makes it (reasons for requests that fail). */
function classify(request) {
  const keys = contract.$defs.Key.enum
  if (request === null || typeof request !== 'object' || Array.isArray(request) || typeof request.verb !== 'string') return 'invalid-request'
  if (!VERBS.includes(request.verb)) return 'unknown-verb'
  if ((request.verb === 'restart' || request.verb === 'close') && request.confirm !== true) return 'confirm-required'
  if (request.verb === 'keys' && Array.isArray(request.keys) && request.keys.some((key) => !keys.includes(key))) return 'key-not-allowed'
  return 'invalid-request'
}

const reasonOf = (request) => {
  try {
    validateRequest(request)
  } catch (error) {
    assert.ok(error instanceof FleetError, String(error?.stack ?? error))
    assert.equal(error.status, STATUS_BY_REASON[error.reason])
    return error.reason
  }
  return null
}

describe('validateRequest (pure) against the contract\'s conformance fixtures', SUITE, () => {
  it('accepts every fixtures act.valid request, and hands back an equal private copy', () => {
    assert.ok(fixtures.act.valid.length >= 7)
    for (const request of fixtures.act.valid) {
      const valid = validateRequest(request)
      assert.deepEqual(valid, request)
      assert.notEqual(valid, request, 'a copy: nothing the caller does to its object afterwards can change what is sent')
      if (request.keys) assert.notEqual(valid.keys, request.keys)
    }
  })

  it('gives every fixtures act.invalid request exactly the reason it declares', () => {
    assert.ok(fixtures.act.invalid.length >= 10)
    for (const { why, request, reason } of fixtures.act.invalid) assert.equal(reasonOf(request), reason, why)
  })

  it('the same through act(): the invalid ones are refused with their reason before herdr is touched', async () => {
    const h = await boot()
    try {
      for (const { why, request, reason } of fixtures.act.invalid) assertRefusal(await refusal(h.act(request)), { reason, status: STATUS_BY_REASON[reason] }, why)
      assert.deepEqual(h.fake.requests, [])
    } finally {
      await h.close()
    }
  })

  it('classifies in the documented order, first failing check wins', () => {
    const cases = [
      [null, 'invalid-request'], [[], 'invalid-request'], ['prompt', 'invalid-request'], [7, 'invalid-request'], [{}, 'invalid-request'],
      [{ verb: 7 }, 'invalid-request'], [{ verb: null }, 'invalid-request'],
      [{ verb: 'spawn', confirm: true }, 'unknown-verb'], [{ verb: 'PROMPT' }, 'unknown-verb'], [{ verb: '' }, 'unknown-verb'], [{ verb: 'constructor' }, 'unknown-verb'], [{ verb: '__proto__' }, 'unknown-verb'],
      [{ verb: 'close' }, 'confirm-required'], [{ verb: 'restart', pane: 3, confirm: 'true', thenPrompt: '' }, 'confirm-required'],
      [{ verb: 'keys', pane: 7, keys: ['nope'], expectRevision: 'x' }, 'key-not-allowed'],
      [{ verb: 'keys', pane: 'w1:p1', keys: ['enter', 'ctrl+z'], expectRevision: 1 }, 'key-not-allowed'],
      [{ verb: 'keys', pane: 'w1:p1', keys: [HYPHEN_CHORD], expectRevision: 1 }, 'key-not-allowed'],
      [{ verb: 'keys', pane: 'w1:p1', keys: ['enter', {}], expectRevision: 1 }, 'key-not-allowed'],
      [{ verb: 'keys', pane: 'w1:p1', keys: [1], expectRevision: 1 }, 'key-not-allowed'],
      [{ verb: 'keys', pane: 'w1:p1', keys: Array(9).fill('enter'), expectRevision: 1 }, 'invalid-request'],
      [{ verb: 'keys', pane: 'w1:p1', keys: [], expectRevision: 1 }, 'invalid-request'],
      [{ verb: 'keys', pane: 'w1:p1', keys: 'enter', expectRevision: 1 }, 'invalid-request'],
      [{ verb: 'keys', pane: 'w1:p1', keys: ['enter'] }, 'invalid-request'],
      [{ verb: 'answer', pane: 'w1:p1', text: 'x', enter: true }, 'invalid-request'],
      [{ verb: 'answer', pane: 'w1:p1', text: 'x', enter: 'yes', expectRevision: 1 }, 'invalid-request'],
      [{ verb: 'answer', pane: 'w1:p1', text: 'x'.repeat(2001), enter: true, expectRevision: 1 }, 'invalid-request'],
      [{ verb: 'prompt', pane: 'w1:p1', text: 'x'.repeat(20001) }, 'invalid-request'],
      [{ verb: 'prompt', pane: 'w1:p1', text: '' }, 'invalid-request'],
      [{ verb: 'prompt', pane: 'w1:p1', text: 'x', keys: ['enter'] }, 'invalid-request'],
      [{ verb: 'rename', pane: 'w1:p1', name: 'Bad Name' }, 'invalid-request'],
      [{ verb: 'interrupt', pane: 'w1:p1', force: true }, 'invalid-request'],
      [{ verb: 'restart', pane: 'w1:p1', confirm: true, thenPrompt: '' }, 'invalid-request'],
      [{ verb: 'close', pane: 'x'.repeat(65), confirm: true }, 'invalid-request'],
    ]
    for (const [request, reason] of cases) assert.equal(reasonOf(request), reason, JSON.stringify(request).slice(0, 80))
  })

  it('agrees with the contract on a few hundred systematic corruptions of every valid request: accepts what the schema accepts, and otherwise gives classify()\'s reason', () => {
    const values = [undefined, null, '', 'x', 0, -1, 1.5, 3, true, false, 'true', 'yes', [], ['enter'], {}, 'x'.repeat(25_000)]
    const corpus = []
    for (const base of fixtures.act.valid) {
      corpus.push(base, { ...base, extra: 1 }, { ...base, confirm: true })
      for (const field of Object.keys(base)) {
        for (const value of values) {
          const copy = { ...base }
          if (value === undefined) delete copy[field]
          else copy[field] = value
          corpus.push(copy)
        }
      }
    }
    assert.ok(corpus.length > 300, `corpus of ${corpus.length}`)
    let accepted = 0
    for (const request of corpus) {
      const verb = VERBS.includes(request.verb) ? request.verb : null
      const schemaOk = verb !== null && validateDef(contract, requestDef(verb), request).errors.length === 0
      const reason = reasonOf(request)
      const label = JSON.stringify(request).slice(0, 100)
      if (schemaOk) {
        assert.equal(reason, null, `accepted by the schema, so by the host: ${label}`)
        accepted += 1
      } else {
        assert.equal(reason, classify(request), label)
      }
    }
    assert.ok(accepted > 20 && accepted < corpus.length, 'the corpus has both accepted and rejected requests')
  })

  it('the key whitelist is exactly the documented one (a tripwire: widening it must be a deliberate change here too)', () => {
    const documented = ['enter', 'esc', 'tab', 'shift+tab', 'up', 'down', 'left', 'right', 'space', 'backspace', 'ctrl+c', 'ctrl+d', 'y', 'n', '1', '2', '3', '4']
    for (const key of documented) assert.equal(reasonOf({ verb: 'keys', pane: 'w1:p1', keys: [key], expectRevision: 1 }), null, key)
    for (const key of ['a', 'ctrl+z', 'ctrl+l', 'alt+x', 'Enter', 'ENTER', 'ctrl+C', '5', '0', 'f1', 'delete', 'home', ' enter', 'enter ', 'ctrl+', '+', '']) {
      assert.equal(reasonOf({ verb: 'keys', pane: 'w1:p1', keys: [key], expectRevision: 1 }), 'key-not-allowed', JSON.stringify(key))
    }
    assert.deepEqual([...contract.$defs.Key.enum].sort(), [...documented].sort())
  })

  it('refuses control characters in text that is typed into a terminal: they would be key presses, not text', () => {
    const controls = ['\u001b', '\u001b[201~', '\u0000', '\u0003', '\u0004', '\u0007', '\u0008', '\u000b', '\u000c', '\u000e', '\u001f', '\u007f', '\u0080', '\u009b', '\u009f']
    for (const control of controls) {
      const text = `before${control}after`
      assert.equal(reasonOf({ verb: 'prompt', pane: 'w1:p1', text }), 'invalid-request', `prompt ${JSON.stringify(control)}`)
      assert.equal(reasonOf({ verb: 'answer', pane: 'w1:p1', text, enter: true, expectRevision: 1 }), 'invalid-request', `answer ${JSON.stringify(control)}`)
      assert.equal(reasonOf({ verb: 'restart', pane: 'w1:p1', confirm: true, thenPrompt: text }), 'invalid-request', `thenPrompt ${JSON.stringify(control)}`)
    }
  })

  it('and accepts what people actually type: tabs, line breaks of either kind, CJK, emoji, a lone surrogate-free mix', () => {
    for (const text of ['a\tb', 'line one\nline two', 'dos\r\nline', '继续：把空闲折叠做成一行计数', '👍 ship it', ' ', '\n']) {
      assert.equal(reasonOf({ verb: 'prompt', pane: 'w1:p1', text }), null, JSON.stringify(text))
      assert.equal(reasonOf({ verb: 'answer', pane: 'w1:p1', text, enter: false, expectRevision: 1 }), null, JSON.stringify(text))
    }
  })

  it('says which field is wrong but never echoes a value, an unexpected field\'s name, or the verb it did not recognise', () => {
    const secret = 'SECRET-VALUE-9c1'
    const probes = [
      [{ verb: 'answer', pane: 'w1:p1', text: secret.repeat(300), enter: true, expectRevision: 1 }, /check text\./],
      [{ verb: 'answer', pane: 'w1:p1', text: secret, enter: secret, expectRevision: -1 }, /check enter, expectRevision\./],
      [{ verb: 'prompt', pane: 'w1:p1', text: secret, [secret]: 1 }, /check \(unexpected field\)\./],
      [{ verb: 'prompt', text: secret }, /check pane\./],
      [{ verb: 'keys', pane: 'w1:p1', keys: [secret], expectRevision: 1 }, /not on the allowed list/],
      [{ verb: secret }, /Unknown verb/],
      [{ verb: 'close', pane: 'w1:p1', confirm: secret }, /confirm/],
      [{ verb: 'prompt', pane: 'w1:p1', text: `${secret}\u001b` }, /control characters/],
    ]
    for (const [request, expected] of probes) {
      let error
      try { validateRequest(request) } catch (caught) { error = caught }
      assert.ok(error instanceof FleetError, JSON.stringify(request).slice(0, 80))
      assert.match(error.message, expected)
      assert.equal(error.message.includes(secret), false, 'the message does not repeat what was sent')
      assert.equal(error.detail, undefined)
    }
  })

  it('does not touch the object it is given', () => {
    const request = { verb: 'keys', pane: 'w1:p1', keys: ['1', 'enter'], expectRevision: 4 }
    const frozen = structuredClone(request)
    validateRequest(request)
    assert.deepEqual(request, frozen)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The seven verbs on the fake herdr: exact RPC sequence and parameters, response, bookkeeping
// ---------------------------------------------------------------------------------------------------------------

describe('the seven verbs, end to end on the fake herdr', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot() })
  afterEach(() => h.close())

  const assertResponse = (response, expected) => {
    assert.deepEqual(response, expected)
    assert.deepEqual(validateDef(contract, 'ActResponse', response).errors, [], 'a valid ActResponse')
  }
  const startAccepted = () => h.fake.handle('agent.start', (params) => ({ type: 'agent_started', agent: { pane_id: params.pane_id, name: params.name, agent: params.kind }, argv: [params.kind] }))

  it('prompt: agent.prompt {target: pane, text}, then the read-back and a forced refresh', async () => {
    const text = '继续：把空闲折叠做成一行计数，点开才展开。'
    assertResponse(await h.act({ verb: 'prompt', pane: IDLE, text }), { ok: true, verb: 'prompt', pane: IDLE, revision: 30 })
    assert.deepEqual(calls(h.fake), [
      ['agent.prompt', { target: IDLE, text }],
      ['pane.get', { pane_id: IDLE }],
      ['session.snapshot', {}],
    ])
    assert.deepEqual(h.state.refreshCalls, [{ force: true }])
  })

  it('prompt does not read first: herdr is the one that knows whether the agent is listening', async () => {
    await h.act(REQUESTS.prompt(WORKING)) // prompting a working agent is fine: it queues the prompt itself
    assert.equal(methods(h.fake)[0], 'agent.prompt')
  })

  it('answer with enter: pane.get, pane.send_text, a 150 ms pause, pane.send_keys [enter], read-back, refresh', async () => {
    assertResponse(await h.act({ verb: 'answer', pane: BLOCKED, text: '先别删，改成只删 dist/client.js', enter: true, expectRevision: BLOCKED_REVISION }), { ok: true, verb: 'answer', pane: BLOCKED, revision: BLOCKED_REVISION })
    assert.deepEqual(calls(h.fake), [
      ['pane.get', { pane_id: BLOCKED }],
      ['pane.send_text', { pane_id: BLOCKED, text: '先别删，改成只删 dist/client.js' }],
      ['pane.send_keys', { pane_id: BLOCKED, keys: ['enter'] }],
      ['pane.get', { pane_id: BLOCKED }],
      ['session.snapshot', {}],
    ])
    assert.deepEqual(h.sleeps, [150])
  })

  it('answer without enter: the text is typed and nothing presses Enter, and nobody waits', async () => {
    await h.act({ verb: 'answer', pane: BLOCKED, text: 'half an answer', enter: false, expectRevision: BLOCKED_REVISION })
    assert.deepEqual(methods(h.fake), ['pane.get', 'pane.send_text', 'pane.get', 'session.snapshot'])
    assert.deepEqual(h.sleeps, [])
  })

  it('keys: pane.get, then pane.send_keys {pane_id, keys} with the keys as given, in order', async () => {
    assertResponse(await h.act({ verb: 'keys', pane: BLOCKED, keys: ['shift+tab', '2', 'enter'], expectRevision: BLOCKED_REVISION }), { ok: true, verb: 'keys', pane: BLOCKED, revision: BLOCKED_REVISION })
    assert.deepEqual(calls(h.fake), [
      ['pane.get', { pane_id: BLOCKED }],
      ['pane.send_keys', { pane_id: BLOCKED, keys: ['shift+tab', '2', 'enter'] }],
      ['pane.get', { pane_id: BLOCKED }],
      ['session.snapshot', {}],
    ])
  })

  it('interrupt: exactly one chord, ctrl+c (plus-separated), accepted by the fake\'s key grammar; no revision needed', async () => {
    assertResponse(await h.act({ verb: 'interrupt', pane: WORKING }), { ok: true, verb: 'interrupt', pane: WORKING, revision: 20 })
    assert.deepEqual(calls(h.fake), [
      ['pane.send_keys', { pane_id: WORKING, keys: ['ctrl+c'] }],
      ['pane.get', { pane_id: WORKING }],
      ['session.snapshot', {}],
    ])
    assert.deepEqual(h.fake.requestsOf('pane.send_keys')[0].params.keys, ['ctrl+c'])
    assert.notEqual(h.fake.requestsOf('pane.send_keys')[0].params.keys[0], HYPHEN_CHORD)
    // the fake answered `ok` (it refuses a hyphen chord as invalid_key), so the grammar really accepted what was sent
  })

  it('interrupt works on a pane that is busy and whose screen keeps changing: it is the one verb for that', async () => {
    for (let i = 0; i < 5; i += 1) h.fake.world.touch(WORKING)
    assert.equal((await h.act(REQUESTS.interrupt(WORKING))).ok, true)
  })

  it('rename: agent.rename {target: pane, name}; the agent really has the new name afterwards', async () => {
    assertResponse(await h.act({ verb: 'rename', pane: IDLE, name: 'dsh-notes' }), { ok: true, verb: 'rename', pane: IDLE, revision: 31 })
    assert.deepEqual(calls(h.fake), [
      ['agent.rename', { target: IDLE, name: 'dsh-notes' }],
      ['pane.get', { pane_id: IDLE }],
      ['session.snapshot', {}],
    ])
    assert.equal(h.fake.world.agentInfo(IDLE).name, 'dsh-notes')
    assert.equal(h.state.snapshot.panes.find((pane) => pane.id === IDLE).agentName, 'dsh-notes', 'and the refresh made the cache say so')
  })

  it('restart: agent.start {name, kind, pane_id} with the agent\'s own name; nothing else, nothing killed', async () => {
    startAccepted()
    assertResponse(await h.act({ verb: 'restart', pane: BLOCKED, confirm: true }), { ok: true, verb: 'restart', pane: BLOCKED, revision: BLOCKED_REVISION })
    assert.deepEqual(calls(h.fake), [
      ['agent.start', { name: 'dsh-reviewer', kind: 'claude', pane_id: BLOCKED }],
      ['pane.get', { pane_id: BLOCKED }],
      ['session.snapshot', {}],
    ])
  })

  it('restart names an unnamed agent "<kind>-<pane id>" cleaned up to the contract\'s name pattern', async () => {
    startAccepted()
    await h.act({ verb: 'restart', pane: WORKING, confirm: true })
    assert.equal(h.fake.requestsOf('agent.start')[0].params.name, 'codex-w1-p2')
    const pattern = new RegExp(contract.$defs.AgentName.pattern)
    for (const kind of ['Claude Code', '99 Bots', '___', 'ÄÖÜ', 'x'.repeat(80), '-lead']) {
      h.fake.world.update(IDLE, { name: null })
      h.fake.world.pane(IDLE).agent.kind = kind
      await h.state.refresh()
      await h.act({ verb: 'restart', pane: IDLE, confirm: true })
      const sent = h.fake.requestsOf('agent.start').at(-1).params
      assert.match(sent.name, pattern, `${kind} -> ${sent.name}`)
      assert.equal(sent.kind, kind, 'the kind itself is passed through untouched')
    }
  })

  it('restart keeps an existing agent name verbatim when it already satisfies the pattern, and replaces one that does not', async () => {
    startAccepted()
    h.fake.world.update(IDLE, { name: 'a--b-' }) // legal, and not what a naive "clean up" would leave alone
    await h.state.refresh()
    await h.act({ verb: 'restart', pane: IDLE, confirm: true })
    assert.equal(h.fake.requestsOf('agent.start').at(-1).params.name, 'a--b-')
    h.fake.world.update(IDLE, { name: 'Not Valid!' })
    await h.state.refresh()
    await h.act({ verb: 'restart', pane: IDLE, confirm: true })
    assert.equal(h.fake.requestsOf('agent.start').at(-1).params.name, 'pi-w1-p3')
  })

  it('restart with thenPrompt: agent.start, then agent.prompt {target: pane, text}', async () => {
    startAccepted()
    const thenPrompt = '接着刚才的调研继续，先列出状态相关的方法。'
    assertResponse(await h.act({ verb: 'restart', pane: WORKING, confirm: true, thenPrompt }), { ok: true, verb: 'restart', pane: WORKING, revision: 20 })
    assert.deepEqual(calls(h.fake), [
      ['agent.start', { name: 'codex-w1-p2', kind: 'codex', pane_id: WORKING }],
      ['agent.prompt', { target: WORKING, text: thenPrompt }],
      ['pane.get', { pane_id: WORKING }],
      ['session.snapshot', {}],
    ])
    assert.deepEqual(h.sleeps, [], 'no pause when the first attempt works')
  })

  it('restart on a pane whose agent is alive: herdr refuses and it is reported as it is (herdr-error with herdr\'s code); no prompt follows', async () => {
    const error = await refusal(h.act({ verb: 'restart', pane: WORKING, confirm: true, thenPrompt: 'continue' }))
    assertRefusal(error, { reason: 'herdr-error', status: 502, detail: { code: 'agent_already_running' } })
    assert.deepEqual(methods(h.fake), ['agent.start'], 'the follow-up prompt is never sent after a refused start; no refresh either')
  })

  it('close: pane.close {pane_id}, then a refresh; the pane is gone; revision is null because there is nothing left to read', async () => {
    assertResponse(await h.act({ verb: 'close', pane: DONE, confirm: true }), { ok: true, verb: 'close', pane: DONE, revision: null })
    assert.deepEqual(calls(h.fake), [
      ['pane.close', { pane_id: DONE }],
      ['session.snapshot', {}],
    ])
    assert.equal(h.fake.world.pane(DONE), null)
    assert.equal(h.state.snapshot.panes.some((pane) => pane.id === DONE), false)
  })

  it('close forgets the pane on the DSH list, so a reused id does not inherit dsh-only access', async () => {
    h.store.policy = 'dsh-only'
    h.store.dshPanes = new Set([DONE, IDLE])
    await h.act({ verb: 'close', pane: DONE, confirm: true })
    assert.deepEqual([...h.store.dshPanes], [IDLE])
  })

  it('close has no force flag and no "only panes we created" rule: a field it does not know is invalid, and a pane under policy "all" closes', async () => {
    assert.equal(reasonOf({ verb: 'close', pane: DONE, confirm: true, force: true }), 'invalid-request')
    assert.equal((await h.act({ verb: 'close', pane: IDLE, confirm: true })).ok, true)
  })

  it('every response is a valid ActResponse, and a failure is never a resolved value', async () => {
    startAccepted()
    for (const request of [REQUESTS.prompt(IDLE), REQUESTS.answer(BLOCKED, BLOCKED_REVISION), REQUESTS.keys(BLOCKED, BLOCKED_REVISION), REQUESTS.interrupt(WORKING), REQUESTS.rename(IDLE), REQUESTS.restart(UNKNOWN), REQUESTS.close(DONE)]) {
      const response = await h.act(request)
      assert.deepEqual(validateDef(contract, 'ActResponse', response).errors, [], request.verb)
      assert.equal(response.verb, request.verb)
      assert.equal(response.pane, request.pane)
    }
  })
})

describe('answer: how the text reaches the terminal', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot() })
  afterEach(() => h.close())

  const typed = () => h.fake.requestsOf('pane.send_text').map((request) => request.params.text)
  const answerWith = (text, extra = {}) => h.act({ verb: 'answer', pane: BLOCKED, text, enter: true, expectRevision: BLOCKED_REVISION, ...extra })

  it('multi-line text is one bracketed paste, so the line breaks are text and not N submissions', async () => {
    await answerWith('first line\nsecond line\nthird')
    assert.deepEqual(typed(), ['\u001b[200~first line\nsecond line\nthird\u001b[201~'])
  })

  it('carriage returns and tabs are wrapped too; a lone paste marker in the middle cannot occur because control characters are refused', async () => {
    await answerWith('dos\r\nline')
    await answerWith('a\tb')
    assert.deepEqual(typed(), ['\u001b[200~dos\r\nline\u001b[201~', '\u001b[200~a\tb\u001b[201~'])
  })

  it('single-line text goes in as it is, wrapper-free (CJK and emoji included)', async () => {
    await answerWith('先别删，改成只删 dist/client.js 👍')
    assert.deepEqual(typed(), ['先别删，改成只删 dist/client.js 👍'])
  })

  it('text that would break out of the paste is refused before anything is sent', async () => {
    assertRefusal(await refusal(answerWith('safe\n\u001b[201~rm -rf ~\r')), { reason: 'invalid-request', status: 400 })
    assert.deepEqual(h.fake.requests, [])
  })

  it('if the text did not go in, Enter is not pressed: one failed send_text, no send_keys at all', async () => {
    h.fake.failNext('pane.send_text', { code: 'send_failed', message: 'pty closed' })
    assertRefusal(await refusal(answerWith('hello')), { reason: 'herdr-error', status: 502, detail: { code: 'send_failed' } })
    assert.deepEqual(methods(h.fake), ['pane.get', 'pane.send_text'])
    assert.deepEqual(h.sleeps, [], 'it did not even wait for the Enter that will not come')
  })

  it('if the text went in and Enter failed, the error says exactly that', async () => {
    h.fake.failNext('pane.send_keys', { code: 'send_failed', message: 'pty closed' })
    const error = await refusal(answerWith('hello'))
    assertRefusal(error, { reason: 'herdr-error', status: 502, detail: { code: 'send_failed' }, message: /^The text was typed, but Enter was not sent\./ })
    assert.deepEqual(methods(h.fake), ['pane.get', 'pane.send_text', 'pane.send_keys'], 'no retry of either step')
  })

  it('the text is sent once: a refusal is not retried, a success is not repeated', async () => {
    await answerWith('only once')
    assert.equal(h.fake.requestsOf('pane.send_text').length, 1)
    assert.equal(h.fake.requestsOf('pane.send_keys').length, 1)
  })
})

describe('restart: the follow-up prompt and the registration race', SUITE, () => {
  let h
  beforeEach(async () => {
    h = await boot()
    h.fake.handle('agent.start', (params) => ({ type: 'agent_started', agent: { pane_id: params.pane_id, name: params.name, agent: params.kind }, argv: [params.kind] }))
  })
  afterEach(() => h.close())

  const race = { code: 'agent_not_found', message: 'unknown agent or pane w1:p2' }
  const request = { verb: 'restart', pane: WORKING, confirm: true, thenPrompt: 'carry on' }

  it('retries the prompt only while herdr says "unknown agent or pane": two misses, then it lands', async () => {
    h.fake.failNext('agent.prompt', race)
    h.fake.failNext('agent.prompt', race)
    assert.equal((await h.act(request)).ok, true)
    assert.equal(h.fake.requestsOf('agent.start').length, 1, 'the agent is started once, however often the prompt is retried')
    assert.equal(h.fake.requestsOf('agent.prompt').length, 3)
    assert.deepEqual(h.sleeps, [250, 250])
  })

  it('gives up after 8 attempts, 250 ms apart, and then says the agent WAS restarted and the prompt was not delivered', async () => {
    for (let i = 0; i < 8; i += 1) h.fake.failNext('agent.prompt', race)
    const error = await refusal(h.act(request))
    assertRefusal(error, { reason: 'herdr-error', status: 502, detail: { code: 'agent_not_found' }, message: /was restarted.*not delivered/ })
    assert.equal(h.fake.requestsOf('agent.prompt').length, 8)
    assert.deepEqual(h.sleeps, Array(7).fill(250))
    assert.equal(h.fake.requestsOf('agent.start').length, 1)
  })

  it('any other refusal of the prompt is final on the first try, and the message still says the restart happened', async () => {
    h.fake.failNext('agent.prompt', { code: 'queue_full', message: 'too many prompts' })
    const error = await refusal(h.act(request))
    assertRefusal(error, { reason: 'herdr-error', status: 502, detail: { code: 'queue_full' }, message: /^The agent was restarted, but the follow-up prompt was not delivered\./ })
    assert.equal(h.fake.requestsOf('agent.prompt').length, 1)
    assert.deepEqual(h.sleeps, [])
  })

  it('a prompt that times out is NOT retried: it may have been delivered', async () => {
    await h.close()
    h = await boot({ timeoutMs: 150 })
    h.fake.handle('agent.start', (params) => ({ type: 'agent_started', agent: { pane_id: params.pane_id }, argv: [] }))
    h.fake.hangNext('agent.prompt')
    const error = await refusal(h.act(request))
    assertRefusal(error, { reason: 'timeout', status: 504, message: /UNKNOWN/ })
    assert.match(error.message, /was restarted/)
    assert.equal(h.fake.requestsOf('agent.prompt').length, 1)
  })

  it('a start that fails ends it: no prompt is ever attempted', async () => {
    h.fake.failNext('agent.start', { code: 'launch_failed', message: 'no such binary' })
    assertRefusal(await refusal(h.act(request)), { reason: 'herdr-error', status: 502, detail: { code: 'launch_failed' } })
    assert.equal(h.fake.requestsOf('agent.prompt').length, 0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------------------------------------------

describe('the per-pane lock', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot() })
  afterEach(() => h.close())

  it('two answers to one pane run one after the other: their RPCs never interleave', { timeout: 10_000 }, async () => {
    h.fake.delayNext('pane.send_text', 80) // makes interleaving easy to see: the first answer lingers mid-way
    const first = h.act({ verb: 'answer', pane: BLOCKED, text: 'first', enter: true, expectRevision: BLOCKED_REVISION })
    const second = h.act({ verb: 'answer', pane: BLOCKED, text: 'second', enter: true, expectRevision: BLOCKED_REVISION })
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.ok && b.ok, true)
    assert.deepEqual(methods(h.fake), [
      'pane.get', 'pane.send_text', 'pane.send_keys', 'pane.get', 'session.snapshot',
      'pane.get', 'pane.send_text', 'pane.send_keys', 'pane.get', 'session.snapshot',
    ])
    assert.deepEqual(h.fake.requestsOf('pane.send_text').map((request) => request.params.text), ['first', 'second'], 'in the order they were asked')
  })

  it('the second of two identical answers finds the screen the first one changed, and is refused instead of typing blind', { timeout: 10_000 }, async () => {
    h.fake.handle('pane.send_keys', (params, { world }) => { world.touch(params.pane_id); return { type: 'ok' } }) // pressing Enter changes the screen
    const first = h.act({ verb: 'answer', pane: BLOCKED, text: 'once', enter: true, expectRevision: BLOCKED_REVISION })
    const second = h.act({ verb: 'answer', pane: BLOCKED, text: 'once', enter: true, expectRevision: BLOCKED_REVISION })
    const [a, b] = await Promise.allSettled([first, second])
    assert.equal(a.status, 'fulfilled')
    assertRefusal(b.reason, { reason: 'screen-changed', status: 409, detail: { revision: BLOCKED_REVISION + 1 } })
    assert.equal(h.fake.requestsOf('pane.send_text').length, 1, 'typed once')
  })

  it('different panes do not wait for each other', { timeout: 10_000 }, async () => {
    h.fake.delayNext('pane.send_text', 400)
    const slow = h.act({ verb: 'answer', pane: BLOCKED, text: 'slow', enter: false, expectRevision: BLOCKED_REVISION })
    let slowDone = false
    slow.then(() => { slowDone = true })
    await until(() => h.fake.requestsOf('pane.send_text').length === 1, { what: 'the slow answer to be in flight' })
    assert.equal((await h.act(REQUESTS.interrupt(WORKING))).ok, true)
    assert.equal(slowDone, false, 'the interrupt on another pane finished while the first pane was still busy')
    await slow
  })

  it('a failure releases the lock: the request queued behind it still runs', { timeout: 10_000 }, async () => {
    h.fake.failNext('pane.send_keys', { code: 'send_failed', message: 'nope' })
    const failing = h.act(REQUESTS.interrupt(WORKING))
    const queued = h.act(REQUESTS.interrupt(WORKING))
    const [a, b] = await Promise.allSettled([failing, queued])
    assert.equal(a.status, 'rejected')
    assert.equal(b.status, 'fulfilled')
    assert.deepEqual(methods(h.fake), ['pane.send_keys', 'pane.send_keys', 'pane.get', 'session.snapshot'])
  })

  it('a refusal does not wait behind a long action on the same pane: the state-based checks run before queueing', { timeout: 10_000 }, async () => {
    h.fake.delayNext('pane.send_text', 300)
    const slow = h.act({ verb: 'answer', pane: BLOCKED, text: 'slow', enter: false, expectRevision: BLOCKED_REVISION })
    await until(() => h.fake.requestsOf('pane.send_text').length === 1, { what: 'the slow answer to be in flight' })
    const started = Date.now()
    assertRefusal(await refusal(h.act({ verb: 'close', pane: BLOCKED, confirm: 'yes' })), { reason: 'confirm-required', status: 400 })
    assertRefusal(await refusal(h.act(REQUESTS.interrupt('w9:p9'))), { reason: 'unknown-pane', status: 404 })
    assert.ok(Date.now() - started < 200, 'answered at once')
    await slow
  })

  it('the next queued action sees the world the previous one left: a pane closed ahead of it is simply gone, with no write attempted', { timeout: 10_000 }, async () => {
    h.fake.delayNext('pane.close', 100)
    const closing = h.act({ verb: 'close', pane: WORKING, confirm: true })
    await until(() => h.fake.requestsOf('pane.close').length === 1, { what: 'the close to be in flight' })
    const queued = h.act(REQUESTS.interrupt(WORKING))
    const [a, b] = await Promise.allSettled([closing, queued])
    assert.equal(a.status, 'fulfilled')
    assertRefusal(b.reason, { reason: 'unknown-pane', status: 404 })
    assert.equal(h.fake.requestsOf('pane.send_keys').length, 0, 'the interrupt was never sent to a pane that is gone')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------------------------------------------

describe('timeout', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot({ timeoutMs: 150 }) })
  afterEach(() => h.close())

  it('a write that herdr never answers is a 504 that says the outcome is UNKNOWN, and it is not retried', async () => {
    h.fake.hangNext('pane.send_keys')
    assertRefusal(await refusal(h.act(REQUESTS.interrupt(WORKING))), { reason: 'timeout', status: 504, message: /UNKNOWN/ })
    assert.equal(h.fake.requestsOf('pane.send_keys').length, 1)
    assert.equal(h.state.refreshCalls.length, 0)
  })

  it('answer: if the text hangs, Enter is not sent and nothing is retried', async () => {
    h.fake.hangNext('pane.send_text')
    assertRefusal(await refusal(h.act(REQUESTS.answer(BLOCKED, BLOCKED_REVISION))), { reason: 'timeout', status: 504, message: /UNKNOWN/ })
    assert.deepEqual(methods(h.fake), ['pane.get', 'pane.send_text'])
  })

  it('answer: if Enter hangs, the message says the text was typed, and the outcome of Enter is unknown', async () => {
    h.fake.hangNext('pane.send_keys')
    const error = await refusal(h.act(REQUESTS.answer(BLOCKED, BLOCKED_REVISION)))
    assertRefusal(error, { reason: 'timeout', status: 504, message: /^The text was typed, but Enter was not sent\./ })
    assert.match(error.message, /UNKNOWN/)
  })

  it('a READ that times out (the fresh pane.get) says nothing was sent, and nothing was', async () => {
    h.fake.hangNext('pane.get')
    const error = await refusal(h.act(REQUESTS.keys(BLOCKED, BLOCKED_REVISION)))
    assertRefusal(error, { reason: 'timeout', status: 504, message: /Nothing was sent/ })
    assert.doesNotMatch(error.message, /UNKNOWN/)
    assert.deepEqual(h.fake.writeRequests(), [])
  })

  it('a prompt that times out: 504, UNKNOWN, one attempt', async () => {
    h.fake.hangNext('agent.prompt')
    assertRefusal(await refusal(h.act(REQUESTS.prompt(IDLE))), { reason: 'timeout', status: 504, message: /UNKNOWN/ })
    assert.equal(h.fake.requestsOf('agent.prompt').length, 1)
  })
})

describe('mapHerdrError', SUITE, () => {
  const herdr = (code, message = 'm') => new HerdrError(message, { method: 'pane.send_keys', code })

  it('every offline-class failure is herdr-offline (503)', () => {
    for (const code of ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTSOCK', 'connection_closed', 'write_failed', 'socket_error']) {
      assertRefusal(mapHerdrError(herdr(code), { verb: 'keys' }), { reason: 'herdr-offline', status: 503 })
    }
  })

  it('only a failed CONNECT claims nothing was sent; a connection lost mid-write says the outcome is unknown', () => {
    for (const code of ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK']) assert.match(mapHerdrError(herdr(code), { write: true }).message, /nothing was sent/i, code)
    for (const code of ['ECONNRESET', 'EPIPE', 'connection_closed', 'write_failed', 'socket_error']) assert.match(mapHerdrError(herdr(code), { write: true }).message, /UNKNOWN/, code)
    assert.match(mapHerdrError(herdr('connection_closed'), { write: false }).message, /nothing was sent/i, 'a read lost mid-way wrote nothing')
    assert.match(mapHerdrError(herdr('connection_closed')).message, /UNKNOWN/, 'with no context given, the cautious wording')
  })

  it('timeout is a 504 that says the outcome is UNKNOWN; for a read it says nothing was sent; by default it is cautious', () => {
    assertRefusal(mapHerdrError(herdr('timeout'), { verb: 'prompt' }), { reason: 'timeout', status: 504, message: /UNKNOWN/ })
    assertRefusal(mapHerdrError(herdr('timeout'), { verb: 'keys', write: false }), { reason: 'timeout', status: 504, message: /Nothing was sent/ })
    assert.match(mapHerdrError(herdr('timeout')).message, /UNKNOWN/)
  })

  it('"unknown pane" and "unknown agent or pane", in any case, are unknown-pane (404)', () => {
    for (const message of ['unknown agent or pane w1:p9', 'Unknown pane w1:p9', 'UNKNOWN AGENT OR PANE', 'error: unknown pane']) {
      assertRefusal(mapHerdrError(herdr('pane_not_found', message), { verb: 'rename' }), { reason: 'unknown-pane', status: 404 })
    }
  })

  it('a refused prompt (code or wording) is agent-blocked with detail.status', () => {
    assertRefusal(mapHerdrError(herdr('agent_blocked', 'x'), { verb: 'prompt' }), { reason: 'agent-blocked', status: 409, detail: { status: 'blocked' } })
    assertRefusal(mapHerdrError(herdr('whatever', 'please answer the question on screen first'), { verb: 'prompt' }), { reason: 'agent-blocked', status: 409, detail: { status: 'blocked' } })
  })

  it('any other error frame is herdr-error (502) with herdr\'s code and none of herdr\'s message', () => {
    const error = mapHerdrError(herdr('invalid_params', 'cannot type SECRET-TEXT-1'), { verb: 'answer' })
    assertRefusal(error, { reason: 'herdr-error', status: 502, detail: { code: 'invalid_params' } })
    assert.equal(JSON.stringify(error.toResponse()).includes('SECRET-TEXT-1'), false)
  })

  it('a code that is not a short identifier is not passed through as one', () => {
    for (const code of [undefined, null, '', 'has space', 'x'.repeat(65), 'a/b', { nested: true }, NaN]) {
      assert.deepEqual(mapHerdrError(herdr(code, 'x'), { verb: 'rename' }).detail, { code: 'unknown' }, String(code))
    }
    assert.deepEqual(mapHerdrError(herdr(-32602, 'x')).detail, { code: '-32602' }, 'a numeric code is a code')
    assert.deepEqual(mapHerdrError(herdr('E.bad:thing-1_x', 'x')).detail, { code: 'E.bad:thing-1_x' })
  })

  it('an aborted or closed client, a malformed reply, an oversized frame: herdr-error with the client\'s code (they are not "offline")', () => {
    for (const code of ['aborted', 'malformed', 'frame_too_large', 'client_closed']) {
      assertRefusal(mapHerdrError(herdr(code, 'x'), { verb: 'interrupt' }), { reason: 'herdr-error', status: 502, detail: { code } })
    }
  })

  it('a FleetError passes through untouched; anything else is internal (500) without its message or stack', () => {
    const own = new FleetError('screen-changed', 'x', { revision: 3 })
    assert.equal(mapHerdrError(own, { verb: 'keys' }), own)
    for (const thrown of [new TypeError('SECRET-TEXT-2 is undefined'), new Error('boom'), 'a string', null, undefined, { reason: 'timeout' }]) {
      const error = mapHerdrError(thrown, { verb: 'prompt' })
      assertRefusal(error, { reason: 'internal', status: 500 })
      assert.equal(JSON.stringify(error.toResponse()).includes('SECRET-TEXT-2'), false)
      assert.equal(JSON.stringify(error.toResponse()).includes('boom'), false)
    }
  })

  it('does not echo a verb it does not know', () => {
    assert.doesNotMatch(mapHerdrError(herdr('x', 'm'), { verb: 'SECRET-VERB' }).message, /SECRET-VERB/)
    assert.match(mapHerdrError(herdr('x', 'm'), { verb: 'close' }).message, /close/)
  })
})

describe('bookkeeping after a write: read-back, refresh, log', SUITE, () => {
  let h
  beforeEach(async () => { h = await boot() })
  afterEach(() => h.close())

  it('the revision in the response is read AFTER the write, not copied from before it', async () => {
    h.fake.handle('pane.send_keys', (params, { world }) => { world.touch(params.pane_id); world.touch(params.pane_id); return { type: 'ok' } })
    const response = await h.act(REQUESTS.keys(BLOCKED, BLOCKED_REVISION))
    assert.equal(response.revision, BLOCKED_REVISION + 2)
  })

  it('a read-back that fails or says nothing useful gives revision null, and the write still counts as done', async () => {
    h.fake.failNext('pane.get', { code: 'internal_error', message: 'x' })
    assert.deepEqual(await h.act(REQUESTS.interrupt(WORKING)), { ok: true, verb: 'interrupt', pane: WORKING, revision: null })
    for (const pane of [{}, { revision: 'x' }, { revision: -3 }, undefined]) {
      h.fake.handle('pane.get', () => ({ type: 'pane_info', pane }))
      assert.equal((await h.act(REQUESTS.interrupt(WORKING))).revision, null)
    }
    assert.equal(h.logs.every((entry) => entry.ok), true)
  })

  it('a read-back lost to a dropped connection does not turn a delivered write into an error', async () => {
    h.fake.dropNext('pane.get')
    assert.equal((await h.act(REQUESTS.interrupt(WORKING))).revision, null)
  })

  it('refreshes the state once with { force: true } after a success, and not at all after a refusal or a failure', async () => {
    await h.act(REQUESTS.interrupt(WORKING))
    assert.deepEqual(h.state.refreshCalls, [{ force: true }])
    await refusal(h.act(REQUESTS.interrupt(SHELL)))
    await refusal(h.act(REQUESTS.keys(BLOCKED, 1)))
    h.fake.failNext('pane.send_keys', { code: 'x', message: 'x' })
    await refusal(h.act(REQUESTS.interrupt(WORKING)))
    assert.equal(h.state.refreshCalls.length, 1)
  })

  it('a refresh that fails is ignored: the write already happened', async () => {
    h.state.refreshError = new HerdrError('down', { code: 'ECONNREFUSED' })
    assert.equal((await h.act(REQUESTS.interrupt(WORKING))).ok, true)
    h.state.refreshError = new TypeError('a bug in the state')
    assert.equal((await h.act(REQUESTS.interrupt(WORKING))).ok, true)
  })

  it('a state without refresh() is fine too (the poll will catch up)', async () => {
    delete h.state.refresh
    assert.equal((await h.act(REQUESTS.interrupt(WORKING))).ok, true)
  })

  it('logs exactly one entry per request with only verb, pane, ok, reason, ms', async () => {
    await h.act(REQUESTS.interrupt(WORKING))
    await refusal(h.act(REQUESTS.interrupt(SHELL)))
    await refusal(h.act({ verb: 'nope' }))
    await refusal(h.act(null))
    assert.equal(h.logs.length, 4)
    for (const entry of h.logs) assert.deepEqual(Object.keys(entry).sort(), ['ms', 'ok', 'pane', 'reason', 'verb'])
    assert.deepEqual(h.logs.map(({ verb, pane, ok, reason }) => ({ verb, pane, ok, reason })), [
      { verb: 'interrupt', pane: WORKING, ok: true, reason: null },
      { verb: 'interrupt', pane: SHELL, ok: false, reason: 'not-an-agent' },
      { verb: null, pane: null, ok: false, reason: 'unknown-verb' },
      { verb: null, pane: null, ok: false, reason: 'invalid-request' },
    ])
    for (const entry of h.logs) assert.ok(Number.isInteger(entry.ms) && entry.ms >= 0)
  })

  it('times the request with the injected clock', async () => {
    await h.close()
    let t = 1000
    h = await boot({ now: () => { t += 7; return t } })
    await h.act(REQUESTS.interrupt(WORKING))
    assert.equal(h.logs[0].ms, 7)
  })

  it('a logger that throws changes nothing about the outcome of a write that happened (or of a refusal)', async () => {
    await h.close()
    h = await boot()
    const { act } = createActions({ client: h.client, state: h.state, store: h.store, log: () => { throw new Error('logger down') }, sleep: async () => {} })
    assert.equal((await act(REQUESTS.interrupt(WORKING))).ok, true)
    assertRefusal(await refusal(act(REQUESTS.interrupt(SHELL))), { reason: 'not-an-agent', status: 409 })
  })

  it('logs the verb of a request that failed validation only when it is one of ours', async () => {
    await refusal(h.act({ verb: 'answer', pane: 'w1:p1' })) // a real verb, malformed
    assert.deepEqual([h.logs[0].verb, h.logs[0].pane], ['answer', null], 'the pane of an invalid request is not trusted into a log either')
  })
})

describe('createActions', SUITE, () => {
  it('fails at wiring time, not on the first request, when a dependency is missing', () => {
    const ok = { client: { request: async () => ({}) }, state: {}, store: {} }
    assert.doesNotThrow(() => createActions(ok))
    for (const broken of [undefined, {}, { ...ok, client: {} }, { ...ok, client: null }, { ...ok, state: null }, { ...ok, state: 'x' }, { ...ok, store: null }, { ...ok, store: undefined }]) {
      assert.throws(() => createActions(broken), TypeError)
    }
  })

  it('refuses (as internal) rather than guessing when a dependency misbehaves: a store whose policy throws writes nothing', async () => {
    const h = await boot()
    try {
      const store = { get policy() { throw new Error('disk on fire') }, dshPanes: new Set() }
      const { act } = createActions({ client: h.client, state: h.state, store, sleep: async () => {} })
      assertRefusal(await refusal(act(REQUESTS.interrupt(WORKING))), { reason: 'internal', status: 500 })
      assert.deepEqual(h.fake.requests, [])
    } finally {
      await h.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// What was typed must not leak: logs, messages, detail
// ---------------------------------------------------------------------------------------------------------------

describe('nothing that was typed is echoed back (logs, messages, detail, responses)', SUITE, () => {
  const SECRETS = {
    prompt: 'PROMPT-SECRET-7f3a91',
    answer: 'ANSWER-SECRET-c2b8d4',
    then: 'THEN-SECRET-5e60aa',
    key: 'KEY-SECRET-1d9f33',
    herdr: 'HERDR-ECHO-SECRET-84b2',
  }

  it('across every verb, every success and every refusal, none of it appears anywhere an operator or a client can read', async () => {
    const h = await boot({ timeoutMs: 150 })
    const surfaces = []
    const seen = (value) => surfaces.push(JSON.stringify(value))
    const run = async (promise) => {
      try {
        seen(await promise)
      } catch (error) {
        assert.ok(error instanceof FleetError, String(error?.stack ?? error))
        seen({ message: error.message, detail: error.detail, response: error.toResponse(), stack: error.stack })
      }
    }
    h.fake.handle('agent.start', (params) => ({ type: 'agent_started', agent: { pane_id: params.pane_id }, argv: [] }))
    try {
      // successes
      await run(h.act({ verb: 'prompt', pane: IDLE, text: SECRETS.prompt }))
      await run(h.act({ verb: 'answer', pane: BLOCKED, text: `${SECRETS.answer}\nmore`, enter: true, expectRevision: BLOCKED_REVISION }))
      await run(h.act({ verb: 'restart', pane: WORKING, confirm: true, thenPrompt: SECRETS.then }))
      // refusals, one of each kind, each carrying a secret in the request
      await run(h.act({ verb: 'prompt', pane: 'w9:p9', text: SECRETS.prompt }))
      await run(h.act({ verb: 'prompt', pane: SHELL, text: SECRETS.prompt }))
      await run(h.act({ verb: 'prompt', pane: BLOCKED, text: SECRETS.prompt }))
      await run(h.act({ verb: 'answer', pane: WORKING, text: SECRETS.answer, enter: true, expectRevision: 20 }))
      await run(h.act({ verb: 'answer', pane: BLOCKED, text: SECRETS.answer, enter: true, expectRevision: 1 }))
      await run(h.act({ verb: 'keys', pane: BLOCKED, keys: [SECRETS.key], expectRevision: BLOCKED_REVISION }))
      await run(h.act({ verb: 'keys', pane: BLOCKED, keys: ['1'], expectRevision: BLOCKED_REVISION, [SECRETS.key]: SECRETS.prompt }))
      await run(h.act({ verb: 'close', pane: WORKING, confirm: SECRETS.key, thenPrompt: SECRETS.then }))
      await run(h.act({ verb: SECRETS.key, pane: WORKING, text: SECRETS.prompt }))
      await run(h.act({ verb: 'prompt', pane: IDLE, text: `${SECRETS.prompt}\u001b` }))
      await run(h.act({ verb: 'prompt', pane: IDLE, text: SECRETS.prompt, enter: SECRETS.key }))
      h.store.policy = 'read-only'
      await run(h.act({ verb: 'prompt', pane: IDLE, text: SECRETS.prompt }))
      h.store.policy = 'all'
      // herdr itself echoing what it was sent in its error message
      h.fake.failNext('agent.prompt', { code: 'invalid_text', message: `cannot submit: ${SECRETS.prompt}` })
      await run(h.act({ verb: 'prompt', pane: IDLE, text: SECRETS.prompt }))
      h.fake.failNext('pane.send_text', { code: 'invalid_text', message: `cannot type: ${SECRETS.answer}` })
      await run(h.act({ verb: 'answer', pane: BLOCKED, text: SECRETS.answer, enter: true, expectRevision: BLOCKED_REVISION }))
      // (an identifier-shaped code is passed through by design; one that is not an identifier is replaced)
      h.fake.failNext('agent.prompt', { code: `echo ${SECRETS.herdr}`, message: SECRETS.herdr })
      await run(h.act({ verb: 'prompt', pane: IDLE, text: SECRETS.prompt }))
      // timeouts and a connection that dies
      h.fake.hangNext('agent.prompt')
      await run(h.act({ verb: 'prompt', pane: IDLE, text: SECRETS.prompt }))
      h.fake.dropNext('pane.send_text')
      await run(h.act({ verb: 'answer', pane: BLOCKED, text: SECRETS.answer, enter: true, expectRevision: BLOCKED_REVISION }))
      h.state.stale = true
      await run(h.act({ verb: 'prompt', pane: IDLE, text: SECRETS.prompt }))
    } finally {
      await h.close()
    }
    seen(h.logs)

    assert.ok(surfaces.length >= 20, 'the scenarios ran')
    assert.ok(h.logs.length >= 20)
    const everything = surfaces.join('\n')
    for (const [name, secret] of Object.entries(SECRETS)) assert.equal(everything.includes(secret), false, `${name} secret leaked into a log, message, detail or response`)
    // and the one thing herdr says in its error frames that we DO pass on is a short code, never the message
    assert.match(everything, /"code":"unknown"/, 'a code that is not an identifier is replaced, not forwarded')
  })

  it('keys are not echoed either: not in the log, not in the message of a failure', async () => {
    const h = await boot()
    try {
      h.fake.failNext('pane.send_keys', { code: 'send_failed', message: 'could not press shift+tab' })
      const error = await refusal(h.act({ verb: 'keys', pane: BLOCKED, keys: ['shift+tab', '3'], expectRevision: BLOCKED_REVISION }))
      assert.equal(`${error.message} ${JSON.stringify(error.detail)} ${JSON.stringify(h.logs)}`.includes('shift+tab'), false)
      await h.act({ verb: 'keys', pane: BLOCKED, keys: ['shift+tab'], expectRevision: BLOCKED_REVISION })
      assert.equal(JSON.stringify(h.logs).includes('shift+tab'), false)
    } finally {
      await h.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The herdr surface the write path is allowed to touch
// ---------------------------------------------------------------------------------------------------------------

describe('the herdr methods the write path uses', SUITE, () => {
  /** Method names in the backticked heads of the rows of FLEET-HOST.md §4's table. */
  function documentedMethods() {
    const start = hostDoc.indexOf('## 4. ')
    const end = hostDoc.indexOf('\n## 5. ', start)
    assert.ok(start >= 0 && end > start, 'FLEET-HOST.md lost its §4')
    const rows = hostDoc.slice(start, end).split('\n').filter((line) => line.startsWith('|'))
    return new Set(rows.flatMap((line) => [...line.matchAll(/`((?:agent|pane|session)\.[a-z_]+)[ `]/g)].map((match) => match[1])))
  }

  it('§4\'s table names exactly the methods this module is built around (a sanity check on the parse below)', () => {
    assert.deepEqual([...documentedMethods()].sort(), ['agent.prompt', 'agent.rename', 'agent.start', 'pane.close', 'pane.get', 'pane.send_keys', 'pane.send_text'])
  })

  it('all seven verbs, success paths and refusals, use only methods from that table (plus the snapshot the state stub fetches)', async () => {
    const h = await boot()
    h.fake.handle('agent.start', (params) => ({ type: 'agent_started', agent: { pane_id: params.pane_id }, argv: [] }))
    try {
      for (const request of [REQUESTS.prompt(IDLE), REQUESTS.answer(BLOCKED, BLOCKED_REVISION), REQUESTS.keys(BLOCKED, BLOCKED_REVISION), REQUESTS.interrupt(WORKING), REQUESTS.rename(IDLE), { ...REQUESTS.restart(UNKNOWN), thenPrompt: 'go' }, REQUESTS.close(DONE)]) {
        await h.act(request)
      }
      await refusal(h.act(REQUESTS.prompt(BLOCKED)))
      await refusal(h.act(REQUESTS.keys(BLOCKED, 1)))
    } finally {
      await h.close()
    }
    const allowed = new Set([...documentedMethods(), 'session.snapshot'])
    const used = new Set(usedMethods)
    assert.ok(used.size >= 8, `the run exercised ${used.size} methods`)
    for (const method of used) assert.ok(allowed.has(method), `${method} is not in FLEET-HOST.md §4`)
  })

  it('never the lookalikes: no agent.send_keys, pane.send_input or pane.release_agent anywhere in this file\'s runs', () => {
    for (const method of ['agent.send_keys', 'pane.send_input', 'pane.release_agent']) assert.equal(usedMethods.has(method), false, method)
    assert.ok(usedMethods.has('pane.send_keys') && usedMethods.has('pane.send_text') && usedMethods.has('agent.prompt'), 'the collection really covered the write methods')
  })
})
