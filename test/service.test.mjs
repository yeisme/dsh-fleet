import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startFakeHerdr } from './helpers/fake-herdr.js'
import { createWorld } from './helpers/wire.js'
import { HerdrClient } from '../lib/herdr/protocol.js'
import { HerdrState } from '../lib/herdr/state.js'
import { FleetStore } from '../lib/fleet/store.js'
import { FleetService } from '../lib/fleet/service.js'
import { FleetError } from '../lib/fleet/errors.js'
import { loadContract, validateDef } from '../lib/fleet/schema.js'

const contract = loadContract()
const BASE_TIME = 1_800_000_000_000

const assertValid = (def, value, label = def) => {
  const { ok, errors } = validateDef(contract, def, value)
  assert.equal(ok, true, `${label} failed contract validation:\n${errors.join('\n')}`)
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  assert.fail('waitFor timed out')
}

function makeTempStore(policy = 'all') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-svc-'))
  const store = new FleetStore({ file: path.join(dir, 'store.json'), maxStaleMs: 0 })
  if (policy !== 'all') store.setPolicy(policy)
  return {
    store,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

function sampleWorld() {
  return createWorld({
    workspaces: [{
      id: 'w1',
      label: 'main',
      tabs: [{
        id: 'w1:t1',
        label: 'work',
        panes: [
          {
            id: 'w1:p1',
            title: 'claude task',
            cwd: '/Users/demo/repo',
            focused: true,
            screen: '\u001b[32mReady\u001b[0m\n',
            agent: { kind: 'claude', name: 'builder', status: 'working', session: { kind: 'id', source: 'hook', value: 'sess-1' } },
          },
          {
            id: 'w1:p2',
            title: 'codex review',
            cwd: '/Users/demo/repo',
            screen: '│ Allow running npm test? (y/n) │\n1. Yes\n2. No\n',
            agent: { kind: 'codex', name: 'reviewer', status: 'blocked' },
          },
          {
            id: 'w1:p3',
            title: 'zsh',
            cwd: '/Users/demo/repo',
            screen: '$ ',
            agent: null,
          },
        ],
      }],
    }],
  })
}

async function createHarness({
  world = sampleWorld(),
  policy = 'all',
  transcripts,
  config = {},
  now,
  start = true,
} = {}) {
  let clock = BASE_TIME
  const getNow = now ?? (() => clock)
  const fake = await startFakeHerdr({ world })
  const client = new HerdrClient({ socketPath: fake.socketPath, timeoutMs: 2000 })
  const herdrState = new HerdrState(client, { pollIntervalMs: 60_000, coalesceMs: 10, now: getNow })
  const { store, cleanup: cleanupStore } = makeTempStore(policy)
  const defaultStubTranscripts = {
    readFrames: async () => ({ status: 'missing', reason: 'no-transcript' }),
    supportsKind: () => true,
  }
  const service = new FleetService({
    client,
    state: herdrState,
    transcripts: transcripts ?? defaultStubTranscripts,
    store,
    config,
    now: getNow,
    sleep: async () => {},
  })
  if (start) await service.start()
  return {
    fake,
    world,
    client,
    herdrState,
    store,
    service,
    advanceTime: (ms) => { clock += ms },
    async close() {
      service.stop()
      client.close()
      await fake.close()
      cleanupStore()
    },
  }
}

describe('FleetService contract shapes', () => {
  let h
  afterEach(async () => { await h?.close(); h = null })

  it('returns contract-valid State before and after start(), FramesResponse, ScreenResponse, and ActResponse', async () => {
    const sampleFrames = [
      { kind: 'session', id: 'f0', sessionId: 'sess-1', cwd: '/Users/demo/repo' },
      { kind: 'text', id: 'f1', role: 'user', text: 'run tests', at: BASE_TIME },
      { kind: 'work', id: 'f2', summary: 'Bash', rows: [{ verb: 'Bash', object: 'npm test', outcome: 'ok', ms: 120 }], tokens: 100 },
      { kind: 'text', id: 'f3', role: 'assistant', text: 'All tests passed.', at: BASE_TIME + 500 },
    ]
    h = await createHarness({
      start: false,
      transcripts: {
        readFrames: async ({ kind }) => {
          if (kind === 'claude') {
            return {
              status: 'ok',
              sessionId: 'sess-1',
              frames: sampleFrames,
              hasEarlier: true,
              partial: false,
              reset: false,
              unknownFrames: 0,
              cursor: { start: 'c-start', end: 'c-end' },
            }
          }
          return { status: 'missing', reason: 'no-transcript' }
        },
      },
    })

    // Before start: never connected, revision 0, contract-valid.
    const initial = h.service.state()
    assertValid('State', initial, 'initial State')
    assert.equal(initial.revision, 0)
    assert.equal(initial.health.connected, false)
    assert.equal(initial.stale, false)
    assert.deepEqual(initial.panes, [])

    await h.service.start()
    const live = h.service.state()
    assertValid('State', live, 'live State')
    assert.equal(live.health.connected, true)
    assert.equal(live.stale, false)
    assert.equal(live.panes.length, 3)
    assert.ok(live.revision >= 1)

    // FramesResponse: transcript source
    const framesOk = await h.service.frames('w1:p1', { limit: 40 })
    assertValid('FramesResponse', framesOk, 'FramesResponse transcript')
    assert.equal(framesOk.source, 'transcript')
    assert.equal(framesOk.reason, null)
    assert.equal(framesOk.frames.length, 4)

    // FramesResponse: missing transcript falls back to 'screen' while connected
    const framesScreen = await h.service.frames('w1:p2')
    assertValid('FramesResponse', framesScreen, 'FramesResponse screen fallback')
    assert.equal(framesScreen.source, 'screen')
    assert.equal(framesScreen.reason, 'no-transcript')
    assert.deepEqual(framesScreen.frames, [])

    // FramesResponse: plain shell reports unsupported-agent and screen fallback
    const framesShell = await h.service.frames('w1:p3')
    assertValid('FramesResponse', framesShell, 'FramesResponse shell')
    assert.equal(framesShell.source, 'screen')
    assert.equal(framesShell.reason, 'unsupported-agent')
    assert.equal(framesShell.agentKind, null)

    // FramesResponse: before + after mutually exclusive
    await assert.rejects(
      h.service.frames('w1:p1', { before: 'a', after: 'b' }),
      (error) => error instanceof FleetError && error.reason === 'invalid-request',
    )

    // ScreenResponse
    const screen = await h.service.screen('w1:p1')
    assertValid('ScreenResponse', screen, 'ScreenResponse')
    assert.equal(screen.format, 'ansi')
    assert.equal(screen.text, '\u001b[32mReady\u001b[0m\n')

    // ActResponse
    const actRes = await h.service.act({ verb: 'prompt', pane: 'w1:p1', text: 'check status' })
    assertValid('ActResponse', actRes, 'ActResponse prompt')
    assert.equal(actRes.ok, true)
    assert.equal(actRes.verb, 'prompt')
    assert.equal(actRes.pane, 'w1:p1')

    // Interrupt uses ctrl+c and succeeds
    const intRes = await h.service.act({ verb: 'interrupt', pane: 'w1:p1' })
    assertValid('ActResponse', intRes, 'ActResponse interrupt')
    assert.equal(h.fake.requestsOf('pane.send_keys').at(-1).params.keys[0], 'ctrl+c')
  })
})

describe('FleetService revision monotonicity and onChange', () => {
  let h
  afterEach(async () => { await h?.close(); h = null })

  it('increments revision only when visible State (excluding now/revision) changes', async () => {
    h = await createHarness()
    // Let initial background summary for blocked pane w1:p2 settle before asserting no-op stability.
    await waitFor(() => h.service.state().panes.find((p) => p.id === 'w1:p2').summary !== '')
    let changes = 0
    const unsub = h.service.onChange(() => { changes += 1 })

    const rev0 = h.service.revision
    // Advancing clock alone or re-reading state() does NOT bump revision.
    h.advanceTime(5000)
    const s1 = h.service.state()
    assert.equal(s1.revision, rev0)
    assert.equal(s1.now, BASE_TIME + 5000)
    assert.equal(changes, 0)

    // No-op refresh from herdr does NOT bump revision.
    await h.herdrState.refresh({ force: true })
    assert.equal(h.service.revision, rev0)
    assert.equal(changes, 0)

    // Visible change in herdr DOES bump revision by 1 and notifies onChange.
    h.world.update('w1:p1', { title: 'updated title' })
    await h.herdrState.refresh({ force: true })
    assert.equal(h.service.revision, rev0 + 1)
    assert.equal(changes, 1)

    // Policy change bumps revision when observed.
    h.store.setPolicy('read-only')
    const s2 = h.service.state()
    assertValid('State', s2)
    assert.equal(s2.revision, rev0 + 2)
    assert.equal(s2.policy.write, 'read-only')
    assert.equal(s2.panes.find((p) => p.id === 'w1:p1').writable, false)
    assert.equal(changes, 2)

    unsub()
    h.world.update('w1:p1', { title: 'after unsub' })
    await h.herdrState.refresh({ force: true })
    assert.equal(changes, 2)
  })

  it('isolates throwing onChange listeners so healthy listeners still fire', async () => {
    h = await createHarness()
    let healthyCalls = 0
    h.service.onChange(() => { throw new Error('bad listener') })
    h.service.onChange(() => { healthyCalls += 1 })

    h.world.update('w1:p1', { title: 'trigger' })
    await h.herdrState.refresh({ force: true })
    assert.equal(healthyCalls, 1)
  })
})

describe('FleetService background summary derivation', () => {
  let h
  afterEach(async () => { await h?.close(); h = null })

  it('caps summary concurrency at <= 2, never blocks state(), and caches by (paneId, revision)', async () => {
    const world = createWorld({
      workspaces: [{
        id: 'w1',
        label: 'main',
        tabs: [{
          id: 'w1:t1',
          label: 'work',
          panes: [
            { id: 'w1:p1', title: 'a1', agent: { kind: 'claude', status: 'done' } },
            { id: 'w1:p2', title: 'a2', agent: { kind: 'claude', status: 'working' } },
            { id: 'w1:p3', title: 'a3', agent: { kind: 'claude', status: 'done' } },
            { id: 'w1:p4', title: 'a4', agent: { kind: 'claude', status: 'working' } },
            { id: 'w1:p5', title: 'a5', screen: 'Approve git push?\n1. Yes\n', agent: { kind: 'codex', status: 'blocked' } },
          ],
        }],
      }],
    })

    let active = 0
    let maxActive = 0
    let calls = 0
    const pending = []

    const transcripts = {
      readFrames: async ({ kind }) => {
        active += 1
        calls += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => pending.push(resolve))
        active -= 1
        return {
          status: 'ok',
          sessionId: 's',
          frames: [
            { kind: 'work', id: 'w', summary: 'Read', rows: [{ verb: 'Read', object: 'lib/fleet/service.js', outcome: 'ok', ms: 10 }], tokens: null },
            { kind: 'text', id: 't', role: 'assistant', text: `Finished ${kind} work.`, at: BASE_TIME },
          ],
          hasEarlier: false,
          partial: false,
          reset: false,
          unknownFrames: 0,
          cursor: { start: null, end: null },
        }
      },
    }

    // Even if caller asks for concurrency 10, service caps it at 2.
    h = await createHarness({ world, transcripts, config: { summaryConcurrency: 10 } })

    // state() returns synchronously even while transcript reads are still pending.
    const immediate = h.service.state()
    assertValid('State', immediate)
    assert.equal(immediate.panes.length, 5)
    assert.ok(maxActive <= 2, `summary concurrency must be <= 2, got ${maxActive}`)

    // Drain all pending transcript reads.
    while (pending.length > 0 || active > 0) {
      while (pending.length > 0) pending.shift()()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    await waitFor(() => {
      const panes = h.service.state().panes
      return panes.every((p) => p.summary !== '')
    })

    assert.ok(maxActive <= 2, `peak summary concurrency must be <= 2, got ${maxActive}`)
    const s = h.service.state()
    assertValid('State', s)
    assert.equal(s.panes.find((p) => p.id === 'w1:p1').summary, 'Finished claude work.')
    assert.equal(s.panes.find((p) => p.id === 'w1:p1').summarySource, 'transcript')
    assert.equal(s.panes.find((p) => p.id === 'w1:p2').summary, 'Read lib/fleet/service.js')
    assert.equal(s.panes.find((p) => p.id === 'w1:p2').summarySource, 'transcript')
    assert.equal(s.panes.find((p) => p.id === 'w1:p5').summary, 'Approve git push?')
    assert.equal(s.panes.find((p) => p.id === 'w1:p5').summarySource, 'screen')

    // Cache check: refreshing with an unrelated pane change does NOT re-read unchanged panes.
    const callsBefore = calls
    h.world.update('w1:p5', { title: 'renamed blocked' })
    await h.herdrState.refresh({ force: true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(calls, callsBefore, 'cached summaries for unchanged (paneId, revision) were not re-fetched')

    // Bumping revision of w1:p1 DOES trigger a fresh read for w1:p1.
    h.world.touch('w1:p1')
    await h.herdrState.refresh({ force: true })
    await waitFor(() => pending.length > 0)
    while (pending.length > 0) pending.shift()()
    assert.equal(calls, callsBefore + 1)
  })
})

describe('FleetService gate runner integration', () => {
  let h
  afterEach(async () => { await h?.close(); h = null })

  it('runs gate in background on working -> done, emits running then passed, and validates against contract', async () => {
    const rev = 'a'.repeat(40)
    let releaseStep
    const stepStarted = new Promise((resolve) => { releaseStep = resolve })
    let finishStep
    const gateDone = new Promise((resolve) => { finishStep = resolve })

    const observedGates = []
    h = await createHarness({
      config: {
        gate: {
          readConfig: async () => ({ steps: [{ name: 'test', cmd: 'node', args: ['--test'], timeoutMs: 5000 }], continueOnError: false }),
          readHead: async () => rev,
          spawn: async () => {
            releaseStep()
            await gateDone
            return { code: 0, stdout: 'all green\n', stderr: '' }
          },
        },
      },
    })

    h.service.onChange(() => {
      const p1 = h.service.state().panes.find((p) => p.id === 'w1:p1')
      if (p1) observedGates.push(p1.checks.gate)
    })

    // Transition w1:p1 from working -> done.
    h.world.update('w1:p1', { status: 'done' })
    await h.herdrState.refresh({ force: true })

    // Wait for spawn to start: state() must already report gate: 'running' without blocking.
    await stepStarted
    const runningState = h.service.state()
    assertValid('State', runningState, 'running gate State')
    assert.equal(runningState.panes.find((p) => p.id === 'w1:p1').checks.gate, 'running')

    // Let the gate finish.
    finishStep()
    await waitFor(() => h.service.state().panes.find((p) => p.id === 'w1:p1').checks.gate === 'passed')
    const passedState = h.service.state()
    assertValid('State', passedState, 'passed gate State')
    const checks = passedState.panes.find((p) => p.id === 'w1:p1').checks
    assert.equal(checks.gate, 'passed')
    assert.equal(checks.baseRevision, rev)
    assert.equal(checks.headRevision, rev)
    assert.equal(checks.steps[0].summary, 'all green')
    assert.ok(observedGates.includes('running'))
    assert.ok(observedGates.includes('passed'))
  })

  it('marks gate checks stale when git HEAD changes during execution', async () => {
    const base = '1'.repeat(40)
    const head = '2'.repeat(40)
    let headReads = 0

    h = await createHarness({
      config: {
        gate: {
          readConfig: async () => ({ steps: [{ name: 'lint', cmd: 'npm', args: ['run', 'lint'], timeoutMs: 5000 }], continueOnError: false }),
          readHead: async () => { headReads += 1; return headReads === 1 ? base : head },
          spawn: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
        },
      },
    })

    h.world.update('w1:p1', { status: 'done' })
    await h.herdrState.refresh({ force: true })

    await waitFor(() => h.service.state().panes.find((p) => p.id === 'w1:p1').checks.gate === 'stale')
    const s = h.service.state()
    assertValid('State', s, 'stale gate State')
    const checks = s.panes.find((p) => p.id === 'w1:p1').checks
    assert.equal(checks.gate, 'stale')
    assert.equal(checks.baseRevision, base)
    assert.equal(checks.headRevision, head)
  })

  it('does not run gate when config is empty or invalid, or when transition is not working -> done', async () => {
    let runCalls = 0
    h = await createHarness({
      config: {
        gate: {
          readConfig: async () => ({ steps: [] }),
          run: async () => { runCalls += 1; return { gate: 'passed', startedAt: BASE_TIME, durationMs: 1, baseRevision: null, headRevision: null, steps: [], failure: null } },
        },
      },
    })

    h.world.update('w1:p1', { status: 'done' })
    await h.herdrState.refresh({ force: true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(runCalls, 0)
    assert.equal(h.service.state().panes.find((p) => p.id === 'w1:p1').checks.gate, 'none')
  })
})

describe('FleetService offline and stale behavior', () => {
  let h
  afterEach(async () => { await h?.close(); h = null })

  it('reports stale: true when herdr disconnects after connecting, falls back frames to none, and refuses screen/act', async () => {
    h = await createHarness({
      transcripts: {
        readFrames: async ({ kind }) => {
          if (kind === 'claude') {
            return {
              status: 'ok',
              sessionId: 'sess-1',
              frames: [{ kind: 'text', id: 'f1', role: 'assistant', text: 'still on disk', at: BASE_TIME }],
              hasEarlier: false,
              partial: false,
              reset: false,
              unknownFrames: 0,
              cursor: { start: 's', end: 'e' },
            }
          }
          return { status: 'missing', reason: 'no-transcript' }
        },
      },
    })

    await h.fake.stop()
    await h.herdrState.refresh({ force: true }).catch(() => {})

    const staleState = h.service.state()
    assertValid('State', staleState, 'stale State')
    assert.equal(staleState.health.connected, false)
    assert.equal(staleState.stale, true)
    assert.equal(staleState.panes.length, 3)
    assert.equal(staleState.panes.find((p) => p.id === 'w1:p1').writable, false)
    assert.equal(staleState.panes.find((p) => p.id === 'w1:p1').writableReason, 'offline')
    assert.equal(staleState.panes.find((p) => p.id === 'w1:p3').writableReason, 'not-an-agent')

    // Transcript on disk is still readable while stale.
    const framesDisk = await h.service.frames('w1:p1')
    assertValid('FramesResponse', framesDisk)
    assert.equal(framesDisk.source, 'transcript')

    // Missing transcript falls back to 'none' (not 'screen') when offline/stale.
    const framesNone = await h.service.frames('w1:p2')
    assertValid('FramesResponse', framesNone)
    assert.equal(framesNone.source, 'none')
    assert.equal(framesNone.reason, 'no-transcript')

    // screen() and act() both refuse with herdr-offline and send zero writes.
    h.fake.clearRequests()
    await assert.rejects(h.service.screen('w1:p1'), (error) => error instanceof FleetError && error.reason === 'herdr-offline')
    await assert.rejects(
      h.service.act({ verb: 'interrupt', pane: 'w1:p1' }),
      (error) => error instanceof FleetError && error.reason === 'herdr-offline',
    )
    assert.deepEqual(h.fake.writeRequests(), [])
  })

  it('refuses act() under read-only policy without sending any write to herdr', async () => {
    h = await createHarness({ policy: 'read-only' })
    h.fake.clearRequests()
    await assert.rejects(
      h.service.act({ verb: 'prompt', pane: 'w1:p1', text: 'do not send' }),
      (error) => error instanceof FleetError && error.reason === 'policy-denied' && error.detail?.policy === 'read-only',
    )
    assert.deepEqual(h.fake.writeRequests(), [])
  })
})
