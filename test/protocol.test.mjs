import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { HerdrClient, HerdrError, isOfflineError, probe } from '../lib/herdr/protocol.js'
import { discoverBinary, discoverSocket, socketCandidates } from '../lib/herdr/discover.js'
import { startFakeHerdr } from './helpers/fake-herdr.js'
import { createWorld } from './helpers/wire.js'

const demoWorld = () => createWorld({
  workspaces: [{ id: 'w1', label: 'demo', tabs: [{ id: 'w1:t1', label: 'main', panes: [{ id: 'w1:p1', title: 'agent', agent: { kind: 'claude', status: 'idle' } }] }] }],
})

/** Poll until `condition()` is truthy; fail loudly instead of hanging the suite. */
async function until(condition, { timeoutMs = 2000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const rejection = async (promise) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  return assert.fail('expected the promise to reject')
}

describe('HerdrClient.request', () => {
  let fake
  let client
  beforeEach(async () => {
    fake = await startFakeHerdr({ world: demoWorld() })
    client = new HerdrClient({ socketPath: fake.socketPath, timeoutMs: 1000 })
  })
  afterEach(async () => {
    client.close()
    await fake.close()
  })

  it('returns the typed result and sends the params untouched', async () => {
    const result = await client.request('pane.get', { pane_id: 'w1:p1' })
    assert.equal(result.type, 'pane_info')
    assert.equal(result.pane.pane_id, 'w1:p1')
    const [sent] = fake.requestsOf('pane.get')
    assert.deepEqual(sent.params, { pane_id: 'w1:p1' })
  })

  it('gives every request its own id', async () => {
    await client.request('ping')
    await client.request('ping')
    const [first, second] = fake.requestsOf('ping')
    assert.notEqual(first.id, second.id)
  })

  it('turns an error frame into a HerdrError that keeps herdr\'s code and message, and is not "offline"', async () => {
    fake.world.update('w1:p1', { status: 'blocked' })
    const error = await rejection(client.request('agent.prompt', { target: 'w1:p1', text: 'hello' }))
    assert.ok(error instanceof HerdrError)
    assert.equal(error.code, 'agent_blocked')
    assert.match(error.message, /answer the question on screen first/)
    assert.equal(error.method, 'agent.prompt')
    assert.equal(isOfflineError(error), false, 'herdr answered, it is reachable')
    assert.equal(client.connected, true, 'an error frame still proves the server is alive')
    assert.match(client.lastError, /answer the question/)
  })

  it('a request that is never answered times out (code "timeout", not offline)', async () => {
    fake.hangNext('ping')
    const started = Date.now()
    const error = await rejection(client.request('ping', {}, { timeoutMs: 60 }))
    assert.equal(error.code, 'timeout')
    assert.equal(isOfflineError(error), false)
    assert.ok(Date.now() - started < 1000, 'the per-request timeout wins over the 1 s default')
  })

  it('a connection closed before the answer is "connection_closed" (offline-class)', async () => {
    fake.dropNext('ping')
    const error = await rejection(client.request('ping'))
    assert.equal(error.code, 'connection_closed')
    assert.equal(isOfflineError(error), true)
  })

  it('malformed JSON from the server is "malformed" (not offline)', async () => {
    fake.rawNext('ping', 'this is not json\n')
    const error = await rejection(client.request('ping'))
    assert.equal(error.code, 'malformed')
    assert.equal(isOfflineError(error), false)
  })

  it('cuts off a runaway frame at maxFrameBytes', async () => {
    const small = new HerdrClient({ socketPath: fake.socketPath, timeoutMs: 1000, maxFrameBytes: 1024 })
    fake.rawNext('ping', 'x'.repeat(8192)) // no newline: would otherwise grow the buffer until the peer stops
    const error = await rejection(small.request('ping'))
    assert.equal(error.code, 'frame_too_large')
    small.close()
  })

  it('an abort signal cancels only the local wait (code "aborted")', async () => {
    fake.hangNext('ping')
    const controller = new AbortController()
    const pending = client.request('ping', {}, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const error = await rejection(pending)
    assert.equal(error.code, 'aborted')
    assert.equal(isOfflineError(error), false)
  })

  it('a socket that does not exist is an offline error (ENOENT)', async () => {
    const lonely = new HerdrClient({ socketPath: path.join(os.tmpdir(), `no-such-herdr-${process.pid}.sock`), timeoutMs: 500 })
    const error = await rejection(lonely.request('ping'))
    assert.equal(error.code, 'ENOENT')
    assert.equal(isOfflineError(error), true)
    assert.equal(lonely.connected, false)
    assert.ok(lonely.lastError)
  })

  it('survives herdr going away and coming back, with the same client', async () => {
    await client.request('ping')
    await fake.stop()
    const down = await rejection(client.request('ping'))
    assert.equal(isOfflineError(down), true, `down: ${down.code}`)
    await fake.start()
    const result = await client.request('ping')
    assert.equal(result.type, 'pong')
  })

  it('a closed client refuses new requests', async () => {
    client.close()
    const error = await rejection(client.request('ping'))
    assert.equal(error.code, 'client_closed')
  })

  it('probe() reports the server version and protocol', async () => {
    assert.deepEqual(await probe(client), { version: '0.9.5', protocol: 22, capabilities: {} })
  })

  it('a new client is not "connected" until the server has answered', async () => {
    const fresh = new HerdrClient({ socketPath: fake.socketPath })
    assert.equal(fresh.connected, false)
    await fresh.request('ping')
    assert.equal(fresh.connected, true)
    fresh.close()
  })
})

describe('HerdrClient.subscribe', () => {
  let fake
  let client
  beforeEach(async () => {
    fake = await startFakeHerdr({ world: demoWorld() })
    client = new HerdrClient({ socketPath: fake.socketPath, timeoutMs: 400 })
  })
  afterEach(async () => {
    client.close()
    await fake.close()
  })

  it('acknowledges, sends the subscription list, and delivers pushed events in order', async () => {
    const events = []
    let acked = 0
    const subscriptions = [{ type: 'pane.updated' }, { type: 'pane.closed' }]
    const handle = client.subscribe(subscriptions, { onEvent: (frame) => events.push(frame), onAck: () => { acked += 1 } })
    await handle.ready
    assert.equal(acked, 1)
    assert.deepEqual(fake.requestsOf('events.subscribe')[0].params, { subscriptions })
    assert.equal(fake.subscriberCount(), 1)

    fake.push('pane_updated', { pane_id: 'w1:p1' })
    fake.push('pane_closed', { pane_id: 'w1:p2' })
    await until(() => events.length === 2, { what: 'two events' })
    assert.deepEqual(events, [
      { event: 'pane_updated', data: { pane_id: 'w1:p1' } },
      { event: 'pane_closed', data: { pane_id: 'w1:p2' } },
    ])
    handle.close()
  })

  it('surfaces a dropped subscription through onLost (herdr\'s events_lost), once', async () => {
    let lost = 0
    const handle = client.subscribe([{ type: 'pane.updated' }], { onLost: () => { lost += 1 } })
    await handle.ready
    fake.dropSubscribers()
    await until(() => lost === 1, { what: 'onLost' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(lost, 1)
  })

  it('closing the handle yourself is not a loss', async () => {
    let lost = 0
    const handle = client.subscribe([{ type: 'pane.updated' }], { onLost: () => { lost += 1 } })
    await handle.ready
    handle.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(lost, 0)
  })

  it('a rejected subscription rejects ready() with herdr\'s code', async () => {
    fake.failNext('events.subscribe', { code: 'invalid_subscription', message: 'unknown subscription type' })
    const handle = client.subscribe([{ type: 'nonsense' }])
    const error = await rejection(handle.ready)
    assert.equal(error.code, 'invalid_subscription')
  })

  it('subscribing to a herdr that is down rejects ready() as an offline error', async () => {
    await fake.stop()
    const error = await rejection(client.subscribe([{ type: 'pane.updated' }]).ready)
    assert.equal(isOfflineError(error), true, `got ${error.code}`)
  })

  it('an acknowledgement that never comes times out', async () => {
    fake.hangNext('events.subscribe')
    const error = await rejection(client.subscribe([{ type: 'pane.updated' }]).ready)
    assert.equal(error.code, 'timeout')
  })

  it('setSubscription() keeps one live subscription: the previous handle is closed', async () => {
    const first = client.subscribe([{ type: 'pane.updated' }])
    await first.ready
    client.setSubscription(first)
    assert.equal(client.subscribed, true)
    const second = client.subscribe([{ type: 'pane.updated' }])
    await second.ready
    client.setSubscription(second)
    await until(() => fake.subscriberCount() === 1, { what: 'the first subscription to close' })
    client.setSubscription(null)
    await until(() => fake.subscriberCount() === 0, { what: 'the second subscription to close' })
    assert.equal(client.subscribed, false)
  })
})

describe('isOfflineError', () => {
  it('only HerdrErrors of the socket-failure family count', () => {
    for (const code of ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'connection_closed', 'write_failed', 'socket_error']) {
      assert.equal(isOfflineError(new HerdrError('x', { code })), true, code)
    }
    for (const code of ['timeout', 'aborted', 'malformed', 'frame_too_large', 'client_closed', 'agent_blocked', 'pane_not_found', undefined]) {
      assert.equal(isOfflineError(new HerdrError('x', { code })), false, String(code))
    }
    assert.equal(isOfflineError(new Error('ENOENT')), false)
    assert.equal(isOfflineError(null), false)
  })
})

describe('discoverSocket / discoverBinary', () => {
  const home = '/home/demo'
  const base = { home, platform: 'linux' }
  const existing = (...paths) => (candidate) => paths.includes(candidate)

  it('prefers HERDR_SOCKET_PATH, then the named session, then the default location', () => {
    const env = { HERDR_SOCKET_PATH: '/run/custom.sock', HERDR_SESSION: 'fleet-test', XDG_CONFIG_HOME: '/cfg' }
    assert.deepEqual(socketCandidates({ ...base, env }), [
      '/run/custom.sock',
      '/cfg/herdr/sessions/fleet-test/herdr.sock',
      '/cfg/herdr/herdr.sock',
      '/home/demo/.config/herdr/herdr.sock',
    ])
    assert.deepEqual(discoverSocket(undefined, { ...base, env, exists: existing('/cfg/herdr/sessions/fleet-test/herdr.sock', '/cfg/herdr/herdr.sock') }),
      { socketPath: '/cfg/herdr/sessions/fleet-test/herdr.sock', socketExists: true })
  })

  it('reports where it looked when nothing exists, and honours an explicit path', () => {
    assert.deepEqual(discoverSocket(undefined, { ...base, env: {}, exists: () => false }), { socketPath: '/home/demo/.config/herdr/herdr.sock', socketExists: false })
    assert.deepEqual(discoverSocket('/x/y.sock', { ...base, env: {}, exists: existing('/x/y.sock') }), { socketPath: '/x/y.sock', socketExists: true })
    assert.deepEqual(discoverSocket('/x/y.sock', { ...base, env: {}, exists: () => false }), { socketPath: '/x/y.sock', socketExists: false })
  })

  it('finds the binary: config, HERDR_BIN_PATH, known install dirs, then PATH', () => {
    const none = () => false
    assert.deepEqual(discoverBinary('/opt/h', { ...base, env: {}, executable: none }), { binaryPath: '/opt/h', binarySource: 'config' })
    assert.deepEqual(discoverBinary(undefined, { ...base, env: { HERDR_BIN_PATH: '/pinned/herdr' }, executable: existing('/pinned/herdr', '/home/demo/.local/bin/herdr') }),
      { binaryPath: '/pinned/herdr', binarySource: 'candidate' })
    assert.deepEqual(discoverBinary(undefined, { ...base, env: {}, executable: existing('/home/demo/.local/bin/herdr') }),
      { binaryPath: '/home/demo/.local/bin/herdr', binarySource: 'candidate' })
    assert.deepEqual(discoverBinary(undefined, { ...base, env: { PATH: '/nope:/usr/games' }, executable: existing('/usr/games/herdr') }),
      { binaryPath: '/usr/games/herdr', binarySource: 'PATH' })
    assert.deepEqual(discoverBinary(undefined, { ...base, env: { PATH: '/nope' }, executable: none }), { binaryPath: null, binarySource: null })
  })
})
