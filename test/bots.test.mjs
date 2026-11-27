import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderRegistry, mergeProviderPanes, namespacePaneId } from '../lib/fleet/providers/registry.js'
import { ExternalBotProvider } from '../lib/fleet/providers/external-bots.js'
import { BOT_PATHS, createBotEndpoints, installBotRoutes } from '../lib/fleet/bots-http.js'
import { sortByAttention } from '../lib/fleet/attention.js'
import { loadContract, validateDef } from '../lib/fleet/schema.js'
import { MAX_BODY_BYTES } from '../lib/security.js'

const contract = loadContract()

function makeHerdrPane(overrides = {}) {
  return Object.freeze({
    id: 'w1:p7',
    workspaceId: 'w1',
    tabId: 'w1:t1',
    workspaceLabel: 'dsh-fleet',
    tabLabel: 'codex',
    title: 'codex',
    cwd: '/Users/demo/dsh-fleet',
    focused: true,
    agent: Object.freeze({
      kind: 'codex',
      name: 'codex-1',
      display: 'Codex',
      session: Object.freeze({ kind: 'codex', source: 'herdr' }),
      interactiveReady: true,
    }),
    status: 'working',
    stalled: false,
    completionSeq: 0,
    stateChangeSeq: 2,
    stateSince: 1_700_000_000_000,
    outputAt: 1_700_000_005_000,
    revision: 12,
    summary: 'Running tests',
    summarySource: 'transcript',
    writable: true,
    writableReason: null,
    checks: Object.freeze({
      gate: 'none',
      startedAt: null,
      durationMs: null,
      baseRevision: null,
      headRevision: null,
      steps: Object.freeze([]),
      failure: null,
    }),
    ...overrides,
  })
}

async function bootBotsHttp({ provider, rejectWith } = {}) {
  const warnings = []
  const connection = { requestRejection: () => rejectWith }
  const bots = createBotEndpoints({ provider, connection, logger: { warn: (...args) => warnings.push(args) } })
  const byPath = new Map(bots.endpoints.map(({ path, handler }) => [path, handler]))
  const server = http.createServer((request, response) => {
    const handler = byPath.get(new URL(request.url, 'http://x').pathname)
    if (!handler) { response.writeHead(404).end(); return }
    void handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    warnings,
    url: (path) => `${base}${path}`,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const post = (url, body, headers = { 'content-type': 'application/json' }) =>
  fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('ExternalBotProvider: registration, static config, TTL staleness, schema compliance', () => {
  it('loads static bots from JSON config file and ignores missing config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-bots-'))
    try {
      const missing = new ExternalBotProvider({ configPath: join(dir, 'nope.json'), now: () => 1_700_000_000_000 })
      assert.deepEqual(missing.loadConfig(), [])

      const cfgPath = join(dir, 'bots.json')
      writeFileSync(cfgPath, JSON.stringify({
        bots: [
          { id: 'openclaw', display: 'OpenClaw', kind: 'openclaw', status: 'idle', callbackUrl: 'http://127.0.0.1:4100/act' },
          { id: 'Invalid Name With Spaces', display: 'Telegram Relay', kind: 'telegram', status: 'working', summary: 'Syncing inbox' },
        ],
      }))

      const provider = new ExternalBotProvider({ configPath: cfgPath, now: () => 1_700_000_000_000 })
      provider.start()
      try {
        const panes = provider.listPanes()
        assert.equal(panes.length, 2)
        for (const pane of panes) {
          assert.deepEqual(validateDef(contract, 'Pane', pane).errors, [], pane.id)
        }
        assert.equal(panes[0].id, 'bot:openclaw')
        assert.equal(panes[0].agent.name, 'openclaw')
        assert.equal(panes[0].writable, true)
        assert.equal(panes[0].writableReason, null)
        // Invalid AgentName is sanitized to null rather than breaking contract schema.
        assert.equal(panes[1].agent.name, null)
        assert.equal(panes[1].writable, false)
        assert.equal(panes[1].writableReason, 'policy-read-only')
      } finally {
        provider.stop()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks missed-heartbeat bots stale/offline without deleting last known state, and recovers on heartbeat', () => {
    let clock = 1_700_000_000_000
    let changes = 0
    const provider = new ExternalBotProvider({ ttlMs: 60_000, now: () => clock })
    provider.onChange(() => { changes += 1 })

    const initial = provider.register({
      id: 'researcher',
      display: 'Research Bot',
      status: 'working',
      summary: 'Indexing papers',
      callbackUrl: 'http://127.0.0.1:4200/hook',
    })
    assert.deepEqual(validateDef(contract, 'Pane', initial).errors, [])
    assert.equal(initial.writable, true)
    assert.equal(initial.writableReason, null)

    // Still alive at exactly TTL.
    clock += 60_000
    assert.equal(provider.listPanes()[0].writable, true)
    assert.equal(provider.listBots()[0].online, true)

    // Missed heartbeat past TTL -> offline/stale, but last known status and summary remain intact.
    clock += 1
    assert.equal(provider.sweep(), true)
    const stalePane = provider.listPanes()[0]
    assert.deepEqual(validateDef(contract, 'Pane', stalePane).errors, [])
    assert.equal(stalePane.status, 'working')
    assert.equal(stalePane.summary, 'Indexing papers')
    assert.equal(stalePane.writable, false)
    assert.equal(stalePane.writableReason, 'offline')
    assert.equal(provider.listBots()[0].stale, true)

    // Heartbeat recovers the bot and updates status -> done increments completionSeq.
    clock += 5_000
    const recovered = provider.heartbeat('researcher', { status: 'done', summary: 'Indexed 42 papers' })
    assert.deepEqual(validateDef(contract, 'Pane', recovered).errors, [])
    assert.equal(recovered.writable, true)
    assert.equal(recovered.writableReason, null)
    assert.equal(recovered.status, 'done')
    assert.equal(recovered.completionSeq, 1)
    assert.equal(recovered.summary, 'Indexed 42 papers')
    assert.ok(changes >= 3)
  })
})

describe('ExternalBotProvider: frame ring buffer & pagination', () => {
  it('stores all 5 contract frame kinds, evicts oldest past capacity, and supports before/after/reset', async () => {
    let clock = 1_700_000_000_000
    const provider = new ExternalBotProvider({ maxFrames: 4, now: () => clock })
    provider.register({ id: 'notes', display: 'Notes Bot', status: 'working' })

    const empty = await provider.frames('bot:notes')
    assert.deepEqual(validateDef(contract, 'FramesResponse', empty).errors, [])
    assert.equal(empty.source, 'none')
    assert.equal(empty.reason, 'not-yet')

    const sampleFrames = [
      { kind: 'session', sessionId: 's-1', cwd: '/Users/demo/notes' },
      { kind: 'text', role: 'user', text: 'Summarize today' },
      { kind: 'reasoning', text: 'Checking daily notes' },
      { kind: 'work', summary: 'Read ×1', rows: [{ verb: 'Read', object: 'today.md', outcome: 'ok', ms: 12 }], tokens: 120 },
      { kind: 'final', text: 'Done summarizing.', reason: 'end_turn', ms: 350 },
    ]
    for (const f of sampleFrames) {
      clock += 100
      const stored = provider.recordEvent('notes', f)
      assert.deepEqual(validateDef(contract, 'Frame', stored).errors, [], f.kind)
    }

    // Ring buffer cap = 4 -> oldest ('session') evicted, partial = true.
    const latest = await provider.frames('bot:notes', { limit: 2 })
    assert.deepEqual(validateDef(contract, 'FramesResponse', latest).errors, [])
    assert.equal(latest.source, 'transcript')
    assert.equal(latest.partial, true)
    assert.equal(latest.hasEarlier, true)
    assert.equal(latest.frames.length, 2)
    assert.deepEqual(latest.frames.map((f) => f.kind), ['work', 'final'])

    // Page backwards with `before`.
    const earlier = await provider.frames('bot:notes', { before: latest.cursor.start, limit: 10 })
    assert.deepEqual(validateDef(contract, 'FramesResponse', earlier).errors, [])
    assert.deepEqual(earlier.frames.map((f) => f.kind), ['text', 'reasoning'])

    // Incremental fetch with `after` when up to date.
    const noNew = await provider.frames('bot:notes', { after: latest.cursor.end })
    assert.deepEqual(validateDef(contract, 'FramesResponse', noNew).errors, [])
    assert.deepEqual(noNew.frames, [])
    assert.equal(noNew.reset, false)

    // Incremental fetch after a new event arrives.
    clock += 100
    provider.recordEvent('bot:notes', { kind: 'text', role: 'assistant', text: 'Follow-up note' })
    const inc = await provider.frames('bot:notes', { after: latest.cursor.end })
    assert.deepEqual(validateDef(contract, 'FramesResponse', inc).errors, [])
    assert.equal(inc.reset, false)
    assert.equal(inc.frames.length, 1)
    assert.equal(inc.frames[0].text, 'Follow-up note')

    // Evicted cursor triggers reset: true.
    const resetResp = await provider.frames('bot:notes', { after: 'seq:1' })
    assert.deepEqual(validateDef(contract, 'FramesResponse', resetResp).errors, [])
    assert.equal(resetResp.reset, true)
    assert.equal(resetResp.frames.length, 4)
  })
})

describe('ProviderRegistry: pure merge, namespacing, routing, and attention.js ranking', () => {
  it('keeps herdr panes verbatim, namespaces external bots <= 64 chars, and ranks unified panes with attention.js', async () => {
    const now = 1_700_000_010_000
    const herdrPane = makeHerdrPane({ id: 'w1:p7', status: 'working', stateSince: now - 5_000 })
    const herdrShell = makeHerdrPane({ id: 'w1:p2', agent: null, status: 'unknown', writable: false, writableReason: 'not-an-agent' })
    const herdrCalls = []
    const herdrProvider = {
      id: 'herdr',
      kind: 'herdr',
      listPanes: () => [herdrPane, herdrShell],
      onChange: () => () => {},
      act: async (req) => { herdrCalls.push(req); return { ok: true, verb: req.verb, pane: req.pane, revision: 13 } },
      frames: async (id) => ({ ok: true, paneId: id, source: 'none', reason: 'not-yet', agentKind: 'codex', sessionId: null, frames: [], hasEarlier: false, partial: false, reset: false, unknownFrames: 0, cursor: { start: null, end: null } }),
    }

    const botCalls = []
    const botsProvider = new ExternalBotProvider({
      now: () => now,
      fetcher: async (url, init) => {
        botCalls.push({ url, body: JSON.parse(init.body) })
        return { ok: true, status: 200 }
      },
    })
    const longId = `very-long-external-bot-identifier-${'x'.repeat(50)}`
    botsProvider.register({ id: longId, display: 'Long Bot', status: 'blocked', screenText: 'Approve deploy?', callbackUrl: 'http://127.0.0.1:4300/act' })
    botsProvider.register({ id: 'idle-bot', display: 'Idle Bot', status: 'idle', callbackUrl: 'http://127.0.0.1:4301/act' })

    const registry = new ProviderRegistry()
    registry.register(herdrProvider).register(botsProvider)

    const panes = registry.listPanes()
    assert.equal(panes.length, 4)

    // herdr pane is kept verbatim (exact same frozen reference, unchanged id).
    assert.strictEqual(panes.find((p) => p.id === 'w1:p7'), herdrPane)

    // Long external bot id is namespaced with `bot:` and <= 64 code points.
    const longBotPane = panes.find((p) => p.agent?.display === 'Long Bot')
    assert.ok(longBotPane.id.startsWith('bot:'))
    assert.ok([...longBotPane.id].length <= 64)
    assert.deepEqual(validateDef(contract, 'Pane', longBotPane).errors, [])

    // Distinct long ids with the same prefix do not collide.
    assert.notEqual(namespacePaneId(`${'a'.repeat(70)}1`), namespacePaneId(`${'a'.repeat(70)}2`))

    // Unified attention ranking: blocked bot -> working herdr -> idle bot -> herdr shell.
    const ranked = sortByAttention(panes, { now })
    assert.deepEqual(ranked.map((p) => p.id), [longBotPane.id, 'w1:p7', 'bot:idle-bot', 'w1:p2'])

    // Routing act() sends to the owning provider.
    const herdrRes = await registry.act({ verb: 'interrupt', pane: 'w1:p7' })
    assert.equal(herdrRes.pane, 'w1:p7')
    assert.equal(herdrCalls.length, 1)

    const botRes = await registry.act({ verb: 'prompt', pane: 'bot:idle-bot', text: 'check status' })
    assert.equal(botRes.pane, 'bot:idle-bot')
    assert.equal(botCalls.length, 1)
    assert.equal(botCalls[0].body.verb, 'prompt')

    // Pure merge does not mutate external provider objects either.
    const customPane = Object.freeze(makeHerdrPane({ id: 'raw-1' }))
    const merged = mergeProviderPanes([
      { provider: { id: 'custom', kind: 'webhook' }, panes: [customPane] },
    ])
    assert.equal(merged.panes[0].id, 'webhook:raw-1')
    assert.equal(customPane.id, 'raw-1')
  })
})

describe('ExternalBotProvider: safe action dispatch & expectRevision enforcement', () => {
  it('enforces expectRevision on answer, blocks prompt when blocked, never retries, and never logs secrets', async () => {
    let clock = 1_700_000_000_000
    const fetched = []
    const logs = []
    const provider = new ExternalBotProvider({
      ttlMs: 60_000,
      now: () => clock,
      log: (entry) => logs.push(entry),
      fetcher: async (url, init) => {
        fetched.push({ url, body: JSON.parse(init.body) })
        return { ok: true, status: 200 }
      },
    })

    const pane = provider.register({
      id: 'approver',
      display: 'Approver Bot',
      status: 'blocked',
      screenText: 'Deploy to staging? [y/n]',
      callbackUrl: 'http://127.0.0.1:4400/act',
    })

    const secret = 'SUPER-SECRET-PROMPT-TOKEN'

    // prompt on blocked bot -> 409 agent-blocked, fetcher never called.
    await assert.rejects(
      provider.act({ verb: 'prompt', pane: pane.id, text: secret }),
      (err) => err.reason === 'agent-blocked' && err.status === 409 && !err.message.includes(secret),
    )
    assert.equal(fetched.length, 0)

    // answer with stale expectRevision -> 409 screen-changed, fetcher never called, no auto-retry.
    await assert.rejects(
      provider.act({ verb: 'answer', pane: pane.id, text: secret, enter: true, expectRevision: pane.revision + 99 }),
      (err) => err.reason === 'screen-changed' && err.status === 409 && err.detail?.revision === pane.revision && !err.message.includes(secret),
    )
    assert.equal(fetched.length, 0)

    // answer with matching expectRevision succeeds and bumps revision.
    const ans = await provider.act({ verb: 'answer', pane: pane.id, text: secret, enter: true, expectRevision: pane.revision })
    assert.deepEqual(validateDef(contract, 'ActResponse', ans).errors, [])
    assert.equal(ans.revision, pane.revision + 1)
    assert.equal(fetched.length, 1)

    // Repeating the same answer with the old expectRevision is now rejected with screen-changed.
    await assert.rejects(
      provider.act({ verb: 'answer', pane: pane.id, text: secret, enter: true, expectRevision: pane.revision }),
      (err) => err.reason === 'screen-changed' && err.detail?.revision === pane.revision + 1,
    )
    assert.equal(fetched.length, 1)

    // interrupt works without expectRevision.
    const intr = await provider.act({ verb: 'interrupt', pane: pane.id })
    assert.equal(intr.ok, true)
    assert.equal(fetched.length, 2)

    // Once bot transitions to idle, answer is rejected with not-blocked.
    const idlePane = provider.heartbeat('approver', { status: 'idle' })
    await assert.rejects(
      provider.act({ verb: 'answer', pane: idlePane.id, text: secret, enter: true, expectRevision: idlePane.revision }),
      (err) => err.reason === 'not-blocked' && err.status === 409,
    )
    assert.equal(fetched.length, 2)

    // Once bot misses heartbeat TTL, prompt is rejected with herdr-offline (503).
    clock += 61_000
    await assert.rejects(
      provider.act({ verb: 'prompt', pane: idlePane.id, text: secret }),
      (err) => err.reason === 'herdr-offline' && err.status === 503,
    )
    assert.equal(fetched.length, 2)

    // Secret text never reached logs.
    assert.ok(!JSON.stringify(logs).includes(secret), 'prompt/answer text must never be logged')
  })

  it('respects read-only policy and refuses writes before calling fetcher', async () => {
    let called = 0
    const provider = new ExternalBotProvider({
      policy: 'read-only',
      fetcher: async () => { called += 1; return { ok: true, status: 200 } },
    })
    const pane = provider.register({ id: 'ro', status: 'idle', callbackUrl: 'http://127.0.0.1:4500/act' })
    assert.equal(pane.writable, false)
    assert.equal(pane.writableReason, 'policy-read-only')
    await assert.rejects(
      provider.act({ verb: 'prompt', pane: pane.id, text: 'hello' }),
      (err) => err.reason === 'policy-denied' && err.status === 403 && err.detail?.policy === 'read-only',
    )
    assert.equal(called, 0)
  })

  it('keeps intrinsic policy-read-only over transient offline when a bot has no callbackUrl', async () => {
    let clock = 1_700_000_000_000
    const provider = new ExternalBotProvider({ ttlMs: 60_000, now: () => clock })
    const pane = provider.register({ id: 'passive', status: 'idle' })
    assert.equal(pane.writable, false)
    assert.equal(pane.writableReason, 'policy-read-only')
    clock += 61_000
    const stalePane = provider.listPanes()[0]
    assert.equal(stalePane.writable, false)
    assert.equal(stalePane.writableReason, 'policy-read-only')
    await assert.rejects(
      provider.act({ verb: 'prompt', pane: pane.id, text: 'hello' }),
      (err) => err.reason === 'policy-denied' && err.status === 403 && err.detail?.policy === 'read-only',
    )
  })
})

describe('HTTP integration: /plugin/fleet/bots/* endpoints and security guards', () => {
  let provider
  let app

  beforeEach(async () => {
    provider = new ExternalBotProvider({ ttlMs: 60_000, now: () => 1_700_000_000_000 })
    app = await bootBotsHttp({ provider })
  })

  afterEach(async () => {
    await app?.close()
  })

  it('supports register, heartbeat, event, and list end-to-end', async () => {
    const reg = await post(app.url(BOT_PATHS.register), { id: 'mailer', display: 'Mail Bot', status: 'idle' })
    assert.equal(reg.status, 200)
    const regBody = await reg.json()
    assert.equal(regBody.ok, true)
    assert.equal(regBody.id, 'bot:mailer')
    assert.deepEqual(validateDef(contract, 'Pane', regBody.pane).errors, [])

    const hb = await post(app.url(BOT_PATHS.heartbeat), { id: 'mailer', status: 'working', summary: 'Drafting reply' })
    assert.equal(hb.status, 200)
    const hbBody = await hb.json()
    assert.equal(hbBody.pane.status, 'working')
    assert.deepEqual(validateDef(contract, 'Pane', hbBody.pane).errors, [])

    const ev = await post(app.url(BOT_PATHS.event), {
      id: 'bot:mailer',
      frame: { kind: 'text', role: 'assistant', text: 'Draft ready for review' },
    })
    assert.equal(ev.status, 200)
    const evBody = await ev.json()
    assert.deepEqual(validateDef(contract, 'Frame', evBody.frame).errors, [])

    const list = await fetch(app.url(BOT_PATHS.list))
    assert.equal(list.status, 200)
    const listBody = await list.json()
    assert.equal(listBody.ok, true)
    assert.equal(listBody.bots.length, 1)
    assert.equal(listBody.bots[0].id, 'bot:mailer')
    assert.equal(listBody.bots[0].frameCount, 1)
    assert.deepEqual(validateDef(contract, 'Pane', listBody.bots[0].pane).errors, [])
  })

  it('enforces 403 forbidden, 405 method-not-allowed, 415 unsupported-media-type, and 413 payload-too-large', async () => {
    // 405 method-not-allowed
    const badMethods = [
      ['POST', BOT_PATHS.list, 'GET'],
      ['GET', BOT_PATHS.register, 'POST'],
      ['PUT', BOT_PATHS.heartbeat, 'POST'],
      ['DELETE', BOT_PATHS.event, 'POST'],
    ]
    for (const [method, path, allow] of badMethods) {
      const res = await fetch(app.url(path), { method, body: method === 'GET' ? undefined : '{}' })
      assert.equal(res.status, 405, `${method} ${path}`)
      assert.equal(res.headers.get('allow'), allow)
      const body = await res.json()
      assert.deepEqual(validateDef(contract, 'ErrorResponse', body).errors, [])
      assert.equal(body.reason, 'method-not-allowed')
    }

    // 415 unsupported-media-type
    const wrongType = await post(app.url(BOT_PATHS.register), '{"id":"x"}', { 'content-type': 'text/plain' })
    assert.equal(wrongType.status, 415)
    const wrongBody = await wrongType.json()
    assert.deepEqual(validateDef(contract, 'ErrorResponse', wrongBody).errors, [])
    assert.equal(wrongBody.reason, 'unsupported-media-type')

    // 413 payload-too-large
    const big = JSON.stringify({ id: 'big', summary: 'x'.repeat(MAX_BODY_BYTES + 16) })
    const tooBig = await post(app.url(BOT_PATHS.register), big)
    assert.equal(tooBig.status, 413)
    const bigBody = await tooBig.json()
    assert.deepEqual(validateDef(contract, 'ErrorResponse', bigBody).errors, [])
    assert.equal(bigBody.reason, 'payload-too-large')

    // 403 forbidden
    await app.close()
    app = await bootBotsHttp({ provider, rejectWith: { status: 403 } })
    for (const path of Object.values(BOT_PATHS)) {
      const res = await fetch(app.url(path), {
        method: path === BOT_PATHS.list ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: path === BOT_PATHS.list ? undefined : '{"id":"x"}',
      })
      assert.equal(res.status, 403, path)
      const body = await res.json()
      assert.deepEqual(validateDef(contract, 'ErrorResponse', body).errors, [])
      assert.equal(body.reason, 'forbidden')
    }
  })

  it('installBotRoutes registers all four endpoints via ctx.effect', () => {
    const registered = []
    const ctx = {
      connection: { requestRejection: () => undefined },
      webServer: { register: (entry) => { registered.push(entry); return () => {} } },
      effect: (fn) => fn(),
      logger: { warn: () => {} },
    }
    installBotRoutes(ctx, { provider })
    assert.deepEqual(registered.map((r) => r.path), Object.values(BOT_PATHS))
  })
})
