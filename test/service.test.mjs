/**
 * lib/fleet/service.js — the H5′ glue.
 *
 * The service's whole job is wiring, so these tests check exactly that: that a pane from herdr reaches the contract
 * shapes of FramesResponse / ScreenResponse, that a shell and an unreadable transcript are ANSWERS rather than
 * errors, that an unknown pane throws so the transport can answer 404, and that the change signal fires when a
 * gate verdict moves. Every response is validated against the real contract, so this file fails if the glue ever
 * produces a shape lib/http.js would hand to a browser unchecked.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createFleetService } from '../lib/fleet/service.js'
import { createWorld } from './helpers/wire.js'
import { normalizeSnapshot } from '../lib/herdr/normalize.js'
import { loadContract, validateDef } from '../lib/fleet/schema.js'

const contract = loadContract()

/** A HerdrState stand-in: the service only reads these four getters and listens for 'change'. */
function fakeHerdr(snapshot) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    snapshot,
    health: { connected: true, socket: '/tmp/x.sock', version: '0.9.5', protocol: 22, lastOkAt: 1000, error: null, session: null },
    stale: false,
    revision: 3,
  })
}

/** The minimum FleetStore the service touches. */
function fakeStore({ write = 'all', ids = [] } = {}) {
  return { policy: write, dshPanes: new Set(ids) }
}

/** A client whose pane.read is scriptable; every call is recorded. */
function fakeClient(read = { text: 'hello', revision: 7 }) {
  const calls = []
  return {
    calls,
    async request(method, params, opts) {
      calls.push([method, params, opts])
      if (method !== 'pane.read') throw new Error(`unexpected method ${method}`)
      if (read instanceof Error) throw read
      return { read }
    },
  }
}

function worldWith({ panes }) {
  const world = createWorld()
  world.addWorkspace({ id: 'w1', label: 'alpha', tabs: [{ id: 'w1:t1', label: 'main' }] })
  for (const spec of panes) world.addPane('w1:t1', spec)
  return world
}

function serviceFor({ panes, client = fakeClient(), store = fakeStore(), readGateConfig, spawn, readHead } = {}) {
  const world = worldWith({ panes })
  // world.snapshot() is the WIRE shape (snake_case); buildState consumes the normalized one.
  const herdr = fakeHerdr(normalizeSnapshot(world.snapshot()))
  const service = createFleetService({
    client,
    herdr,
    store,
    now: () => 5_000_000,
    ...(readGateConfig === undefined ? {} : { readGateConfig }),
    ...(spawn === undefined ? {} : { spawn }),
    ...(readHead === undefined ? {} : { readHead }),
  })
  return { service, herdr, client, world }
}

describe('fleet service: state()', () => {
  it('is the contract State, and every pane carries a checks block (none until a gate runs)', () => {
    const { service } = serviceFor({
      panes: [{ id: 'w1:p1', title: 'fix', cwd: '/Users/demo/work', agent: { kind: 'claude', name: 'dsh-fixer', status: 'working' } }],
    })
    const state = service.state()
    assert.deepEqual(validateDef(contract, 'State', state).errors, [])
    assert.deepEqual(state.panes[0].checks, {
      gate: 'none', startedAt: null, durationMs: null, baseRevision: null, headRevision: null, steps: [], failure: null,
    })
  })

  it('publishes the store policy it was given, not a default', () => {
    const { service } = serviceFor({
      panes: [{ id: 'w1:p1', title: 'x', agent: { kind: 'pi', name: 'a', status: 'idle' } }],
      store: fakeStore({ write: 'read-only' }),
    })
    assert.equal(service.state().policy.write, 'read-only')
    assert.equal(service.state().panes[0].writable, false)
  })
})

describe('fleet service: onChange()', () => {
  it('fires when herdr says its visible content changed', () => {
    const { service, herdr } = serviceFor({ panes: [{ id: 'w1:p1', title: 'x', agent: { kind: 'pi', name: 'a', status: 'idle' } }] })
    let fired = 0
    const off = service.onChange(() => { fired += 1 })
    herdr.emit('change')
    assert.equal(fired, 1)
    off()
    herdr.emit('change')
    assert.equal(fired, 1, 'unsubscribed listeners stop hearing about changes')
  })

  it('one throwing listener does not stop the others', () => {
    const { service, herdr } = serviceFor({ panes: [{ id: 'w1:p1', title: 'x', agent: { kind: 'pi', name: 'a', status: 'idle' } }] })
    let reached = 0
    service.onChange(() => { throw new Error('boom') })
    service.onChange(() => { reached += 1 })
    herdr.emit('change')
    assert.equal(reached, 1)
  })
})

describe('fleet service: frames()', () => {
  it('an unknown pane throws, so the transport answers 404 instead of inventing an empty page', async () => {
    const { service } = serviceFor({ panes: [{ id: 'w1:p1', title: 'x', agent: { kind: 'pi', name: 'a', status: 'idle' } }] })
    await assert.rejects(() => service.frames('w9:p9'), /unknown-pane/)
  })

  it('a shell is unsupported-agent, not an error: it has no transcript and that is the answer', async () => {
    const { service } = serviceFor({ panes: [{ id: 'w1:p1', title: 'zsh' }] })
    const page = await service.frames('w1:p1')
    assert.deepEqual(validateDef(contract, 'FramesResponse', page).errors, [])
    assert.equal(page.reason, 'unsupported-agent')
    assert.deepEqual(page.frames, [])
    assert.equal(page.ok, true)
  })

  it('a transcript that is not there yet is not-yet with an empty page, still contract-valid', async () => {
    const { service } = serviceFor({
      panes: [{ id: 'w1:p1', title: 'x', cwd: '/Users/demo/work', agent: { kind: 'pi', name: 'a', status: 'idle', session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: '/nonexistent/pi.jsonl' } } }],
    })
    const page = await service.frames('w1:p1')
    assert.deepEqual(validateDef(contract, 'FramesResponse', page).errors, [])
    assert.ok(['not-yet', 'no-transcript', 'unreadable'].includes(page.reason), `unexpected reason ${page.reason}`)
    assert.deepEqual(page.frames, [])
  })
})

describe('fleet service: screen()', () => {
  const pane = { id: 'w1:p1', title: 'x', agent: { kind: 'pi', name: 'a', status: 'working' } }

  it('is the contract ScreenResponse in ansi, and it really asks herdr for ansi', async () => {
    const client = fakeClient({ text: '\u001b[31mred\u001b[0m', revision: 12, cols: 80, rows: 24 })
    const { service } = serviceFor({ panes: [pane], client })
    const screen = await service.screen('w1:p1')
    assert.deepEqual(validateDef(contract, 'ScreenResponse', screen).errors, [])
    assert.equal(screen.format, 'ansi')
    assert.equal(screen.text, '\u001b[31mred\u001b[0m')
    assert.equal(screen.revision, 12)
    assert.equal(client.calls[0][1].format, 'ansi')
    assert.equal(client.calls[0][1].source, 'visible')
  })

  it('a failed read is empty text at revision 0, never an error that blanks the panel', async () => {
    const { service } = serviceFor({ panes: [pane], client: fakeClient(new Error('EAGAIN')) })
    const screen = await service.screen('w1:p1')
    assert.deepEqual(validateDef(contract, 'ScreenResponse', screen).errors, [])
    assert.equal(screen.text, '')
    assert.equal(screen.revision, 0)
  })

  it('an unknown pane throws so the transport answers 404', async () => {
    const { service } = serviceFor({ panes: [pane] })
    await assert.rejects(() => service.screen('w9:p9'), /unknown-pane/)
  })
})

describe('fleet service: gate()', () => {
  const pane = { id: 'w1:p1', title: 'x', cwd: '/Users/demo/work', agent: { kind: 'pi', name: 'a', status: 'done' } }

  it('no configured steps means gate=none: nobody asked for a verdict', async () => {
    const { service } = serviceFor({ panes: [pane], readGateConfig: async () => ({ steps: [] }) })
    const checks = await service.gate('w1:p1')
    assert.equal(checks.gate, 'none')
    assert.deepEqual(validateDef(contract, 'Checks', checks).errors, [])
    assert.equal(service.state().panes[0].checks.gate, 'none')
  })

  it('a passing gate reaches Pane.checks and the change signal fires', async () => {
    let changes = 0
    const { service } = serviceFor({
      panes: [pane],
      readGateConfig: async () => ({ steps: [{ name: 'test', cmd: 'npm', args: ['test'], timeoutMs: 1000 }] }),
      spawn: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
      readHead: async () => 'abc123',
    })
    service.onChange(() => { changes += 1 })
    const checks = await service.gate('w1:p1')
    assert.equal(checks.gate, 'passed')
    assert.deepEqual(validateDef(contract, 'Checks', checks).errors, [])
    assert.equal(service.state().panes[0].checks.gate, 'passed')
    assert.ok(changes >= 2, 'running then the verdict both publish')
  })

  it('a failing gate is failed, and the verdict is what State shows', async () => {
    const { service } = serviceFor({
      panes: [pane],
      readGateConfig: async () => ({ steps: [{ name: 'lint', cmd: 'npm', args: ['run', 'lint'], timeoutMs: 1000 }] }),
      spawn: async () => ({ code: 2, stdout: '', stderr: 'boom' }),
      readHead: async () => 'abc123',
    })
    const checks = await service.gate('w1:p1')
    assert.equal(checks.gate, 'failed')
    assert.equal(checks.failure.step, 'lint')
    assert.equal(service.state().panes[0].checks.gate, 'failed')
  })

  it('refuses a second gate for the same pane while one is running', async () => {
    let release = null
    const { service } = serviceFor({
      panes: [pane],
      readGateConfig: async () => ({ steps: [{ name: 'test', cmd: 'npm', args: ['test'], timeoutMs: 1000 }] }),
      spawn: () => new Promise((resolve) => { release = () => resolve({ code: 0, stdout: '', stderr: '' }) }),
      readHead: async () => 'abc',
    })
    const first = service.gate('w1:p1')
    // gate() awaits the config read before it marks the pane busy, so let that microtask land first.
    await new Promise((resolve) => setImmediate(resolve))
    await assert.rejects(() => service.gate('w1:p1'), /gate-running/)
    release()
    await first
  })

  it('a pane with no cwd has nothing to verify', async () => {
    const { service } = serviceFor({ panes: [{ id: 'w1:p1', title: 'x', cwd: '', agent: { kind: 'pi', name: 'a', status: 'done' } }] })
    await assert.rejects(() => service.gate('w1:p1'), /no-cwd/)
  })

  it('an unknown pane is refused', async () => {
    const { service } = serviceFor({ panes: [pane] })
    await assert.rejects(() => service.gate('w9:p9'), /unknown-pane/)
  })
})

describe('fleet service: stop()', () => {
  it('drops listeners so a stopped service stops publishing', () => {
    const { service, herdr } = serviceFor({ panes: [{ id: 'w1:p1', title: 'x', agent: { kind: 'pi', name: 'a', status: 'idle' } }] })
    let fired = 0
    service.onChange(() => { fired += 1 })
    service.stop()
    herdr.emit('change')
    assert.equal(fired, 0)
  })
})
