import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { startFakeHerdr } from './helpers/fake-herdr.js'
import { createWorld } from './helpers/wire.js'
import { HerdrClient } from '../lib/herdr/protocol.js'
import { HerdrState } from '../lib/herdr/state.js'
import { FleetStore } from '../lib/fleet/store.js'
import { FleetService } from '../lib/fleet/service.js'
import { ProviderRegistry } from '../lib/fleet/providers/registry.js'
import { ExternalBotProvider } from '../lib/fleet/providers/external-bots.js'
import { createFleetEndpoints, FLEET_PATHS } from '../lib/http.js'
import { createBotEndpoints, BOT_PATHS } from '../lib/fleet/bots-http.js'
import { loadContract, validateDef } from '../lib/fleet/schema.js'

const contract = loadContract()
const BASE_TIME = 1_800_000_000_000

function assertValid(def, value, label = def) {
  const { ok, errors } = validateDef(contract, def, value)
  assert.equal(ok, true, `${label} failed contract validation:\n${errors.join('\n')}`)
}

function assertStateInvariants(state) {
  assertValid('State', state, 'State')
  assert.equal(new Set(state.panes.map((pane) => pane.id)).size, state.panes.length, 'pane ids are unique')
  assert.ok(state.panes.filter((pane) => pane.focused).length <= 1, 'at most one focused pane')

  const expected = { blocked: 0, done: 0, working: 0, idle: 0, unknown: 0, agents: 0, shells: 0, panes: state.panes.length }
  const byWorkspace = new Map()
  for (const pane of state.panes) {
    if (pane.agent === null) expected.shells += 1
    else { expected.agents += 1; expected[pane.status] += 1 }
    const entry = byWorkspace.get(pane.workspaceId) ?? { tabs: new Set(), panes: 0, focused: false }
    entry.tabs.add(pane.tabId)
    entry.panes += 1
    entry.focused ||= pane.focused
    byWorkspace.set(pane.workspaceId, entry)
  }
  assert.deepEqual(state.counts, expected, 'counts match panes')
  assert.deepEqual(
    state.workspaces.map(({ id, tabCount, paneCount, focused }) => [id, tabCount, paneCount, focused]).sort(),
    [...byWorkspace].map(([id, entry]) => [id, entry.tabs.size, entry.panes, entry.focused]).sort(),
    'workspaces match panes',
  )
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function openSse(url) {
  const response = await fetch(url)
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []

  const drain = () => {
    while (true) {
      const idx = buffer.indexOf('\n\n')
      if (idx === -1) break
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      if (!block.startsWith('event:')) continue
      const fields = Object.fromEntries(
        block.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
      )
      events.push({ event: fields.event, id: fields.id, data: JSON.parse(fields.data) })
    }
  }

  return {
    async nextEvent(predicate = () => true, { timeoutMs = 2000 } = {}) {
      const deadline = Date.now() + timeoutMs
      while (true) {
        drain()
        while (events.length > 0) {
          const ev = events.shift()
          if (predicate(ev)) return ev
        }
        if (Date.now() > deadline) {
          assert.fail('SSE timed out waiting for matching event')
        }
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 50)),
        ])
        if (done) assert.fail('SSE stream ended unexpectedly')
        if (value) buffer += decoder.decode(value, { stream: true })
      }
    },
    async close() {
      await reader.cancel().catch(() => {})
    },
  }
}

async function startCallbackServer() {
  const received = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      received.push(JSON.parse(text))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/callback`
  return {
    url,
    received,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function bootIntegration({ policy = 'all' } = {}) {
  let clock = BASE_TIME
  const getNow = () => clock
  const world = createWorld({
    workspaces: [{
      id: 'w1',
      label: 'main',
      tabs: [{
        id: 'w1:t1',
        label: 'work',
        panes: [
          {
            id: 'w1:p1',
            title: 'claude builder',
            cwd: '/Users/demo/repo',
            focused: true,
            screen: '\u001b[32mReady\u001b[0m\n',
            agent: { kind: 'claude', name: 'builder', status: 'idle' },
          },
          {
            id: 'w1:p2',
            title: 'zsh',
            cwd: '/Users/demo/repo',
            screen: '$ ',
            agent: null,
          },
        ],
      }],
    }],
  })

  const fake = await startFakeHerdr({ world })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-int-'))
  const store = new FleetStore({ file: path.join(dir, 'store.json'), maxStaleMs: 0 })
  if (policy !== 'all') store.setPolicy(policy)

  const client = new HerdrClient({ socketPath: fake.socketPath, timeoutMs: 2000 })
  const herdrState = new HerdrState(client, { pollIntervalMs: 60_000, coalesceMs: 10, now: getNow })
  const botProvider = new ExternalBotProvider({
    now: getNow,
    policy: () => ({ write: store.policy, dshPanes: store.dshPanes }),
  })
  const registry = new ProviderRegistry()
  registry.register(botProvider)

  const service = new FleetService({
    client,
    state: herdrState,
    transcripts: { readFrames: async () => ({ status: 'missing', reason: 'no-transcript' }) },
    store,
    registry,
    now: getNow,
    sleep: async () => {},
  })

  await registry.start()
  await service.start()

  const connection = { requestRejection: () => undefined }
  const fleet = createFleetEndpoints({ service, connection, heartbeatMs: 60_000 })
  const bots = createBotEndpoints({ provider: botProvider, connection })
  const byPath = new Map([...fleet.endpoints, ...bots.endpoints].map(({ path: p, handler }) => [p, handler]))

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    const handler = byPath.get(pathname)
    if (!handler) {
      response.writeHead(404).end()
      return
    }
    void handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const callbackServer = await startCallbackServer()

  return {
    base,
    url: (p, q = '') => `${base}${p}${q}`,
    fake,
    store,
    service,
    botProvider,
    registry,
    callbackServer,
    advanceTime: (ms) => { clock += ms },
    async close() {
      fleet.dispose()
      service.stop()
      botProvider.stop()
      await registry.stop()
      client.close()
      await callbackServer.close()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await fake.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('Fleet end-to-end integration', () => {
  let app
  afterEach(async () => {
    await app?.close()
    app = null
  })

  it('registers external bot, streams state over SSE, serves frames/screen, and dispatches act callbacks', async () => {
    app = await bootIntegration()
    const sse = await openSse(app.url(FLEET_PATHS.stream))
    try {
      const initial = await sse.nextEvent()
      assert.equal(initial.event, 'state')
      assertStateInvariants(initial.data)
      assert.equal(initial.data.panes.length, 2)
      const initialRev = initial.data.revision

      // Register external bot via HTTP
      const regRes = await postJson(app.url(BOT_PATHS.register), {
        id: 'deploy-bot',
        kind: 'bot',
        display: 'Deploy Bot',
        status: 'idle',
        cwd: '/Users/demo/deploy',
        callbackUrl: app.callbackServer.url,
      })
      assert.equal(regRes.status, 200)
      const regBody = await regRes.json()
      assert.equal(regBody.ok, true)
      assert.equal(regBody.id, 'bot:deploy-bot')

      // SSE immediately broadcasts updated state containing bot:deploy-bot
      const afterReg = await sse.nextEvent((ev) => ev.data.panes.some((p) => p.id === 'bot:deploy-bot'))
      assertStateInvariants(afterReg.data)
      assert.ok(afterReg.data.revision > initialRev)
      assert.equal(afterReg.data.panes.length, 3)
      const botPane = afterReg.data.panes.find((p) => p.id === 'bot:deploy-bot')
      assert.equal(botPane.writable, true)
      assert.equal(botPane.workspaceId, 'bots')

      // GET /plugin/fleet/state agrees and validates against contract
      const stateRes = await fetch(app.url(FLEET_PATHS.state))
      assert.equal(stateRes.status, 200)
      const stateBody = await stateRes.json()
      assertStateInvariants(stateBody)
      assert.equal(stateBody.panes.length, 3)
      assert.ok(stateBody.panes.some((p) => p.id === 'bot:deploy-bot'))
      assert.ok(stateBody.panes.some((p) => p.id === 'w1:p1'))

      // Push an assistant text event frame to the bot
      const revBeforeEvent = stateBody.revision
      const eventRes = await postJson(app.url(BOT_PATHS.event), {
        id: 'bot:deploy-bot',
        frame: { kind: 'text', role: 'assistant', text: 'Deploy pipeline ready.' },
      })
      assert.equal(eventRes.status, 200)
      const eventBody = await eventRes.json()
      assert.equal(eventBody.ok, true)

      // SSE broadcasts updated summary and incremented revision
      const afterEvent = await sse.nextEvent((ev) => ev.data.revision > revBeforeEvent)
      assertStateInvariants(afterEvent.data)
      const updatedBot = afterEvent.data.panes.find((p) => p.id === 'bot:deploy-bot')
      assert.equal(updatedBot.summary, 'Deploy pipeline ready.')

      // GET /plugin/fleet/frames returns the recorded frame in contract shape
      const framesRes = await fetch(app.url(FLEET_PATHS.frames, `?pane=${encodeURIComponent('bot:deploy-bot')}`))
      assert.equal(framesRes.status, 200)
      const framesBody = await framesRes.json()
      assertValid('FramesResponse', framesBody, 'bot FramesResponse')
      assert.equal(framesBody.paneId, 'bot:deploy-bot')
      assert.equal(framesBody.source, 'transcript')
      assert.equal(framesBody.frames.length, 1)
      assert.equal(framesBody.frames[0].text, 'Deploy pipeline ready.')

      // GET /plugin/fleet/screen works for the bot pane
      const screenRes = await fetch(app.url(FLEET_PATHS.screen, `?pane=${encodeURIComponent('bot:deploy-bot')}`))
      assert.equal(screenRes.status, 200)
      const screenBody = await screenRes.json()
      assertValid('ScreenResponse', screenBody, 'bot ScreenResponse')
      assert.equal(screenBody.paneId, 'bot:deploy-bot')

      // POST /plugin/fleet/act dispatches prompt to the bot callback server
      const actRes = await postJson(app.url(FLEET_PATHS.act), {
        verb: 'prompt',
        pane: 'bot:deploy-bot',
        text: 'deploy staging',
      })
      assert.equal(actRes.status, 200)
      const actBody = await actRes.json()
      assertValid('ActResponse', actBody, 'bot ActResponse')
      assert.equal(actBody.pane, 'bot:deploy-bot')
      assert.equal(actBody.verb, 'prompt')
      assert.equal(app.callbackServer.received.length, 1)
      assert.deepEqual(app.callbackServer.received[0], {
        verb: 'prompt',
        pane: 'bot:deploy-bot',
        botId: 'deploy-bot',
        text: 'deploy staging',
      })

      // GET /plugin/fleet/bots/list reports the bot without leaking callbackUrl
      const listRes = await fetch(app.url(BOT_PATHS.list))
      assert.equal(listRes.status, 200)
      const listText = await listRes.text()
      assert.ok(!listText.includes(app.callbackServer.url), 'callbackUrl must never be exposed in /bots/list')
      const listBody = JSON.parse(listText)
      assert.equal(listBody.bots.length, 1)
      assert.equal(listBody.bots[0].id, 'bot:deploy-bot')
      assert.equal(listBody.bots[0].frameCount, 1)
    } finally {
      await sse.close()
    }
  })

  it('switches policy via POST /plugin/fleet/policy, broadcasts SSE, enforces policy-denied, and rejects invalid policies', async () => {
    app = await bootIntegration()
    const sse = await openSse(app.url(FLEET_PATHS.stream))
    try {
      const initial = await sse.nextEvent()
      assert.equal(initial.data.policy.write, 'all')

      // Register an external bot so both herdr and external panes are tested under policy changes
      const regRes = await postJson(app.url(BOT_PATHS.register), {
        id: 'policy-bot',
        kind: 'bot',
        display: 'Policy Bot',
        status: 'idle',
        callbackUrl: app.callbackServer.url,
      })
      assert.equal(regRes.status, 200)
      await sse.nextEvent((ev) => ev.data.panes.some((p) => p.id === 'bot:policy-bot'))

      // Switch to read-only
      const roRes = await postJson(app.url(FLEET_PATHS.policy), { write: 'read-only' })
      assert.equal(roRes.status, 200)
      assert.deepEqual(await roRes.json(), { ok: true, policy: { write: 'read-only' } })

      const roEvent = await sse.nextEvent((ev) => ev.data.policy.write === 'read-only')
      assertStateInvariants(roEvent.data)
      assert.equal(roEvent.data.panes.find((p) => p.id === 'w1:p1').writable, false)
      assert.equal(roEvent.data.panes.find((p) => p.id === 'w1:p1').writableReason, 'policy-read-only')
      assert.equal(roEvent.data.panes.find((p) => p.id === 'bot:policy-bot').writable, false)
      assert.equal(roEvent.data.panes.find((p) => p.id === 'bot:policy-bot').writableReason, 'policy-read-only')

      // Writes are denied on both herdr and external bot panes
      app.fake.clearRequests()
      const deniedHerdr = await postJson(app.url(FLEET_PATHS.act), { verb: 'prompt', pane: 'w1:p1', text: 'blocked' })
      assert.equal(deniedHerdr.status, 403)
      const deniedHerdrBody = await deniedHerdr.json()
      assertValid('ErrorResponse', deniedHerdrBody, 'herdr policy-denied')
      assert.equal(deniedHerdrBody.reason, 'policy-denied')
      assert.equal(deniedHerdrBody.detail?.policy, 'read-only')

      const deniedBot = await postJson(app.url(FLEET_PATHS.act), { verb: 'prompt', pane: 'bot:policy-bot', text: 'blocked' })
      assert.equal(deniedBot.status, 403)
      const deniedBotBody = await deniedBot.json()
      assertValid('ErrorResponse', deniedBotBody, 'bot policy-denied')
      assert.equal(deniedBotBody.reason, 'policy-denied')
      assert.equal(deniedBotBody.detail?.policy, 'read-only')

      assert.deepEqual(app.fake.writeRequests(), [], 'no write reached herdr under read-only')
      assert.equal(app.callbackServer.received.length, 0, 'no callback reached bot under read-only')

      // Switch to dsh-only
      const dshRes = await postJson(app.url(FLEET_PATHS.policy), { write: 'dsh-only' })
      assert.equal(dshRes.status, 200)
      assert.deepEqual(await dshRes.json(), { ok: true, policy: { write: 'dsh-only' } })

      const dshEvent = await sse.nextEvent((ev) => ev.data.policy.write === 'dsh-only')
      assertStateInvariants(dshEvent.data)
      assert.equal(dshEvent.data.panes.find((p) => p.id === 'w1:p1').writableReason, 'policy-dsh-only')
      assert.equal(dshEvent.data.panes.find((p) => p.id === 'bot:policy-bot').writableReason, 'policy-dsh-only')

      const deniedDsh = await postJson(app.url(FLEET_PATHS.act), { verb: 'prompt', pane: 'bot:policy-bot', text: 'denied' })
      assert.equal(deniedDsh.status, 403)
      assert.equal((await deniedDsh.json()).reason, 'policy-denied')

      // Switch back to all
      const allRes = await postJson(app.url(FLEET_PATHS.policy), { write: 'all' })
      assert.equal(allRes.status, 200)
      assert.deepEqual(await allRes.json(), { ok: true, policy: { write: 'all' } })

      const allEvent = await sse.nextEvent((ev) => ev.data.policy.write === 'all')
      assertStateInvariants(allEvent.data)
      assert.equal(allEvent.data.panes.find((p) => p.id === 'w1:p1').writable, true)
      assert.equal(allEvent.data.panes.find((p) => p.id === 'bot:policy-bot').writable, true)

      const allowedBot = await postJson(app.url(FLEET_PATHS.act), { verb: 'prompt', pane: 'bot:policy-bot', text: 'go' })
      assert.equal(allowedBot.status, 200)
      assert.equal(app.callbackServer.received.length, 1)

      // Invalid policies are rejected with 400 invalid-request and leave current policy untouched
      for (const payload of [{ write: 'admin' }, { write: '' }, {}, { write: 123 }, { write: null }]) {
        const badRes = await postJson(app.url(FLEET_PATHS.policy), payload)
        assert.equal(badRes.status, 400, JSON.stringify(payload))
        const badBody = await badRes.json()
        assertValid('ErrorResponse', badBody, 'invalid policy error')
        assert.equal(badBody.reason, 'invalid-request')
      }
      assert.equal((await (await fetch(app.url(FLEET_PATHS.state))).json()).policy.write, 'all')
    } finally {
      await sse.close()
    }
  })
})
