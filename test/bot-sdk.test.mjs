import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ExternalBotProvider } from '../lib/fleet/providers/external-bots.js'
import { createBotEndpoints } from '../lib/fleet/bots-http.js'
import { FleetBotClient } from '../lib/sdk/bot-client.js'

async function startFleetBotServer(provider) {
  const { endpoints } = createBotEndpoints({
    provider,
    connection: { requestRejection: () => undefined },
  })
  const byPath = new Map(endpoints.map((ep) => [ep.path, ep.handler]))

  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    const handler = byPath.get(pathname)
    if (!handler) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, reason: 'not-found', message: 'not found' }))
      return
    }
    handler(request, response)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

describe('FleetBotClient SDK end-to-end', () => {
  const cleanups = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()
      await fn()
    }
  })

  it('supports register, heartbeat, frames, approval callback, prompt/interrupt handlers, and clean stop', async () => {
    const provider = new ExternalBotProvider({ policy: 'all', ttlMs: 30_000 })
    const fleet = await startFleetBotServer(provider)
    cleanups.push(() => fleet.close())

    const client = new FleetBotClient({
      baseUrl: fleet.baseUrl,
      id: 'sdk-e2e-bot',
      name: 'sdk-e2e-bot',
      kind: 'custom-agent',
      cwd: '/tmp/sdk-e2e',
      workspaceLabel: 'External Bots',
      heartbeatMs: 50,
      ttlMs: 30_000,
    })
    cleanups.push(() => client.stop())

    const receivedPrompts = []
    const receivedInterrupts = []
    client.onPrompt((payload) => { receivedPrompts.push(payload) })
    client.onInterrupt((payload) => { receivedInterrupts.push(payload) })

    // 1. Register via start()
    const registered = await client.start()
    assert.equal(client.paneId, 'bot:sdk-e2e-bot')
    assert.equal(registered.id, 'bot:sdk-e2e-bot')
    assert.equal(registered.workspaceLabel, 'External Bots')
    assert.equal(registered.agent.kind, 'custom-agent')
    assert.equal(registered.writable, true)
    assert.ok(client.callbackUrl.startsWith('http://127.0.0.1:'))

    // 2. Heartbeat & status update
    const working = await client.setStatus('working', { summary: 'Analyzing repository' })
    assert.equal(working.status, 'working')
    assert.equal(working.summary, 'Analyzing repository')

    // Let at least one periodic heartbeat fire
    await new Promise((resolve) => setTimeout(resolve, 75))
    const listed = provider.listBots()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].online, true)
    assert.equal(listed[0].hasCallback, true)

    // 3. Push text, work, and final frames
    const textFrame = await client.pushText('assistant', 'Starting analysis')
    assert.equal(textFrame.kind, 'text')
    assert.equal(textFrame.role, 'assistant')

    const workFrame = await client.pushWork(
      'Checked 2 files',
      [
        { verb: 'read', object: 'package.json', outcome: 'ok', ms: 12 },
        { verb: 'lint', object: 'lib/sdk/bot-client.js', outcome: 'ok', ms: 34 },
      ],
      512,
    )
    assert.equal(workFrame.kind, 'work')
    assert.equal(workFrame.rows.length, 2)
    assert.equal(workFrame.tokens, 512)

    const finalFrame = await client.pushFinal('Analysis complete', 'done', 95)
    assert.equal(finalFrame.kind, 'final')
    assert.equal(finalFrame.reason, 'done')
    assert.equal(finalFrame.ms, 95)

    const framesRes = await provider.frames(client.paneId)
    assert.equal(framesRes.ok, true)
    assert.deepEqual(framesRes.frames.map((f) => f.kind), ['text', 'work', 'final'])

    // 4. requestApproval -> blocked -> stale revision rejected -> valid answer resolves promise
    const approvalPromise = client.requestApproval('Deploy to staging? (y/n)', { timeoutMs: 5000 })

    // Wait until status is reflected as blocked on the provider
    let screen = null
    for (let i = 0; i < 40; i += 1) {
      const pane = provider.listPanes().find((p) => p.id === client.paneId)
      if (pane?.status === 'blocked') {
        screen = await provider.screen(client.paneId)
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(screen, 'bot must transition to blocked state')
    assert.equal(screen.text, 'Deploy to staging? (y/n)')

    // Stale expectRevision must fail with screen-changed and not resolve approval
    await assert.rejects(
      () => provider.act({
        verb: 'answer',
        pane: client.paneId,
        text: 'n',
        enter: true,
        expectRevision: screen.revision - 1,
      }),
      (error) => error.reason === 'screen-changed',
    )

    // Matching expectRevision delivers the answer to the bot's local callback server
    const actAnswer = await provider.act({
      verb: 'answer',
      pane: client.paneId,
      text: 'y',
      enter: true,
      expectRevision: screen.revision,
    })
    assert.equal(actAnswer.ok, true)

    const answer = await approvalPromise
    assert.deepEqual(answer, { text: 'y', enter: true })

    // 5. Move out of blocked, then verify onPrompt and onInterrupt callbacks
    await client.setStatus('idle', { summary: 'Waiting for next task' })

    const actPrompt = await provider.act({
      verb: 'prompt',
      pane: client.paneId,
      text: 'Run smoke tests',
    })
    assert.equal(actPrompt.ok, true)
    assert.equal(receivedPrompts.length, 1)
    assert.deepEqual(receivedPrompts[0], {
      verb: 'prompt',
      text: 'Run smoke tests',
      pane: 'bot:sdk-e2e-bot',
      botId: 'sdk-e2e-bot',
    })

    const actInterrupt = await provider.act({
      verb: 'interrupt',
      pane: client.paneId,
    })
    assert.equal(actInterrupt.ok, true)
    assert.equal(receivedInterrupts.length, 1)
    assert.deepEqual(receivedInterrupts[0], {
      verb: 'interrupt',
      pane: 'bot:sdk-e2e-bot',
      botId: 'sdk-e2e-bot',
    })

    // 6. Clean, idempotent stop() closes callback server
    const closedUrl = client.callbackUrl
    await client.stop()
    await client.stop()
    assert.equal(client.callbackUrl, null)

    await assert.rejects(() => fetch(closedUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'interrupt' }),
    }))
  })

  it('rejects requestApproval on timeout and on stop()', async () => {
    const provider = new ExternalBotProvider({ policy: 'all' })
    const fleet = await startFleetBotServer(provider)
    cleanups.push(() => fleet.close())

    const client = new FleetBotClient({
      baseUrl: fleet.baseUrl,
      id: 'timeout-bot',
      heartbeatMs: 0,
    })
    cleanups.push(() => client.stop())

    await client.start()

    await assert.rejects(
      () => client.requestApproval('Will time out?', { timeoutMs: 40 }),
      /timed out/,
    )

    const pending = client.requestApproval('Will stop before answer?', { timeoutMs: 5000 })
    // Ensure requestApproval has registered its waiter before stopping
    await new Promise((resolve) => setTimeout(resolve, 25))
    await client.stop()
    await assert.rejects(() => pending, /stopped before approval/)
  })
})
