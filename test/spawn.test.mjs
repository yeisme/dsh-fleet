import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createWorktree, spawnAgent, createBotCommand, SPAWN_KINDS } from '../lib/fleet/spawn.js'
import { FleetError } from '../lib/fleet/errors.js'
import { FleetService } from '../lib/fleet/service.js'
import { createFleetEndpoints, FLEET_PATHS } from '../lib/http.js'
import { EMPTY_SNAPSHOT } from '../lib/herdr/normalize.js'
import { apply } from '../index.js'

function makeStubClient({ paneId = 'w1:p9', onRequest } = {}) {
  const calls = []
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params })
      if (onRequest) return onRequest(method, params)
      if (method === 'agent.start') {
        return {
          type: 'agent_started',
          agent: { pane_id: params.pane_id ?? paneId, name: params.name, agent: params.kind },
          argv: [params.kind],
        }
      }
      if (method === 'agent.prompt') {
        return { type: 'agent_prompted', agent: { pane_id: params.target } }
      }
      return { type: 'ok' }
    },
  }
}

function makeStubState({ connected = true, stale = false, snapshot = EMPTY_SNAPSHOT } = {}) {
  let refreshed = 0
  return {
    snapshot,
    health: { connected, socket: '/tmp/fake.sock', version: '0.9.5', protocol: 22, lastOkAt: 1000, error: null, session: null },
    stale,
    get refreshCount() { return refreshed },
    async refresh() { refreshed += 1; return snapshot },
    on() {},
    off() {},
  }
}

function makeStubStore({ policy = 'all', withAddHelper = false } = {}) {
  const dshPanes = new Set()
  const store = { policy, dshPanes, setPolicy(next) { store.policy = next } }
  if (withAddHelper) {
    store.addDshPane = (id) => { dshPanes.add(id) }
  }
  return store
}

describe('spawnAgent validation & refusals', () => {
  it('rejects invalid request shapes and fields before touching herdr', async () => {
    const client = makeStubClient()
    const state = makeStubState()
    const store = makeStubStore()

    const badRequests = [
      null,
      'claude',
      [],
      { kind: 'unknown-bot', cwd: '/tmp/work' },
      { kind: 'claude', cwd: '' },
      { kind: 'claude', cwd: '   ' },
      { kind: 'claude', cwd: '/tmp/work', name: 'BadName' },
      { kind: 'claude', cwd: '/tmp/work', name: '1starts-with-digit' },
      { kind: 'claude', cwd: '/tmp/work', name: 'a'.repeat(33) },
      { kind: 'claude', cwd: '/tmp/work', prompt: 123 },
      { kind: 'claude', cwd: '/tmp/work', prompt: 'x'.repeat(20_001) },
      { kind: 'claude', cwd: '/tmp/work', prompt: 'hello \u001b[31mred' },
      { kind: 'claude', cwd: '/tmp/work', worktree: 'yes' },
      { kind: 'claude', cwd: 'relative/path', worktree: true },
    ]

    for (const request of badRequests) {
      await assert.rejects(
        spawnAgent({ client, state, store, request }),
        (error) => error instanceof FleetError && error.reason === 'invalid-request',
        `expected invalid-request for ${JSON.stringify(request)}`,
      )
    }
    assert.deepEqual(client.calls, [], 'no herdr calls on invalid requests')
  })

  it('refuses when store.policy is read-only with detail.policy', async () => {
    const client = makeStubClient()
    const state = makeStubState()
    const store = makeStubStore({ policy: 'read-only' })

    await assert.rejects(
      spawnAgent({ client, state, store, request: { kind: 'claude', cwd: '/tmp/work', name: 'worker' } }),
      (error) => error instanceof FleetError
        && error.reason === 'policy-denied'
        && error.detail?.policy === 'read-only',
    )
    assert.deepEqual(client.calls, [])
  })

  it('refuses when herdr is offline or stale', async () => {
    const client = makeStubClient()
    const store = makeStubStore({ policy: 'all' })

    for (const state of [makeStubState({ connected: false }), makeStubState({ connected: true, stale: true })]) {
      await assert.rejects(
        spawnAgent({ client, state, store, request: { kind: 'codex', cwd: '/tmp/work' } }),
        (error) => error instanceof FleetError && error.reason === 'herdr-offline',
      )
    }
    assert.deepEqual(client.calls, [])
  })
})

describe('spawnAgent happy paths & safety', () => {
  it('spawns all supported kinds, records pane in store.dshPanes, and sends initial prompt without logging it', async () => {
    const secret = 'TOP-SECRET-PROMPT-42'
    for (const kind of SPAWN_KINDS) {
      const client = makeStubClient({ paneId: `w1:p-${kind}` })
      const state = makeStubState()
      const store = makeStubStore({ policy: 'dsh-only', withAddHelper: kind === 'claude' })
      const logs = []

      const res = await spawnAgent({
        client,
        state,
        store,
        request: { kind, cwd: '/Users/demo/project', name: `agent_${kind}`, prompt: secret },
        log: (entry) => logs.push(entry),
      })

      assert.deepEqual(res, {
        ok: true,
        pane: `w1:p-${kind}`,
        kind,
        name: `agent_${kind}`,
        cwd: '/Users/demo/project',
        worktree: null,
      })
      assert.ok(store.dshPanes.has(`w1:p-${kind}`), 'created pane recorded in dshPanes')
      assert.equal(client.calls.length, 2)
      assert.equal(client.calls[0].method, 'agent.start')
      assert.deepEqual(client.calls[0].params, { name: `agent_${kind}`, kind, cwd: '/Users/demo/project' })
      assert.equal(client.calls[1].method, 'agent.prompt')
      assert.deepEqual(client.calls[1].params, { target: `w1:p-${kind}`, text: secret })
      assert.equal(logs.length, 1)
      assert.equal(logs[0].ok, true)
      assert.ok(!JSON.stringify(logs).includes(secret), 'prompt must never be logged')
    }
  })

  it('creates an isolated worktree before starting the agent when worktree is true', async () => {
    const client = makeStubClient({ paneId: 'w1:p22' })
    const state = makeStubState()
    const store = makeStubStore({ policy: 'all' })
    const execCalls = []
    const spawnExec = async (cmd, args, opts) => {
      execCalls.push({ cmd, args, opts })
      return { code: 0, stdout: '', stderr: '' }
    }

    const res = await spawnAgent({
      client,
      state,
      store,
      request: { kind: 'pi', cwd: '/Users/demo/repo', name: 'feature_x', worktree: true },
      spawnExec,
    })

    const expectedPath = path.join('/Users/demo/repo', '.worktrees', 'feature_x')
    assert.equal(execCalls.length, 1)
    assert.equal(execCalls[0].cmd, 'git')
    assert.deepEqual(execCalls[0].args, ['worktree', 'add', '-b', 'fleet/feature_x', expectedPath])
    assert.equal(execCalls[0].opts.shell, false)
    assert.equal(execCalls[0].opts.cwd, '/Users/demo/repo')
    assert.deepEqual(res, {
      ok: true,
      pane: 'w1:p22',
      kind: 'pi',
      name: 'feature_x',
      cwd: expectedPath,
      worktree: 'fleet/feature_x',
    })
    assert.equal(client.calls[0].params.cwd, expectedPath)
  })
})

describe('createWorktree in a real temp git repo', () => {
  const temps = []
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates a real git worktree on a new branch with shell: false', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-wt-'))
    temps.push(repoDir)

    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Fleet Test'], { cwd: repoDir, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'fleet@example.test'], { cwd: repoDir, stdio: 'ignore' })
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n')
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' })

    const worktreePath = path.join(repoDir, '.worktrees', 'worker-1')
    const result = await createWorktree({
      cwd: repoDir,
      branch: 'fleet/worker-1',
      worktreePath,
    })

    assert.deepEqual(result, { ok: true, cwd: worktreePath, branch: 'fleet/worker-1' })
    assert.ok(fs.existsSync(path.join(worktreePath, 'README.md')))
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim()
    assert.equal(branch, 'fleet/worker-1')
  })

  it('rejects shell-injection branch names and relative cwd before invoking git', async () => {
    let called = false
    const spawn = async () => { called = true; return { code: 0 } }

    for (const bad of [
      { cwd: 'relative/dir', branch: 'fleet/ok', worktreePath: '/tmp/wt' },
      { cwd: '/tmp', branch: 'fleet/a;rm -rf /', worktreePath: '/tmp/wt' },
      { cwd: '/tmp', branch: '-flag', worktreePath: '/tmp/wt' },
      { cwd: '/tmp', branch: 'fleet/../escape', worktreePath: '/tmp/wt' },
      { cwd: '/tmp', branch: 'UPPERCASE', worktreePath: '/tmp/wt' },
      { cwd: '/tmp', branch: 'fleet/ok', worktreePath: '' },
    ]) {
      await assert.rejects(
        createWorktree({ ...bad, spawn }),
        (error) => error instanceof FleetError && error.reason === 'invalid-request',
      )
    }
    assert.equal(called, false)
  })
})

describe('POST /plugin/fleet/spawn via node:http', () => {
  let server
  let fleet

  afterEach(async () => {
    fleet?.dispose()
    server?.closeAllConnections?.()
    if (server) await new Promise((resolve) => server.close(resolve))
    server = null
    fleet = null
  })

  async function boot(storePolicy = 'all') {
    const client = makeStubClient({ paneId: 'w1:p55' })
    const state = makeStubState()
    const store = makeStubStore({ policy: storePolicy })
    const service = new FleetService({ client, state, store })
    const connection = { requestRejection: () => undefined }
    fleet = createFleetEndpoints({ service, connection })
    const byPath = new Map(fleet.endpoints.map(({ path: p, handler }) => [p, handler]))
    server = http.createServer((req, res) => {
      const handler = byPath.get(new URL(req.url, 'http://localhost').pathname)
      if (!handler) { res.writeHead(404).end(); return }
      void handler(req, res)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    return { base, client, state, store, service }
  }

  it('spawns via HTTP POST, refreshes state, and enforces JSON + policy', async () => {
    const { base, state, store } = await boot('all')
    const url = `${base}${FLEET_PATHS.spawn}`

    const okRes = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'claude', cwd: '/Users/demo/app', name: 'http_bot' }),
    })
    assert.equal(okRes.status, 200)
    const body = await okRes.json()
    assert.deepEqual(body, {
      ok: true,
      pane: 'w1:p55',
      kind: 'claude',
      name: 'http_bot',
      cwd: '/Users/demo/app',
      worktree: null,
    })
    assert.equal(state.refreshCount, 1)
    assert.ok(store.dshPanes.has('w1:p55'))

    const badCt = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    assert.equal(badCt.status, 415)

    const badMethod = await fetch(url, { method: 'GET' })
    assert.equal(badMethod.status, 405)

    store.policy = 'read-only'
    const denied = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'claude', cwd: '/Users/demo/app' }),
    })
    assert.equal(denied.status, 403)
    const deniedBody = await denied.json()
    assert.equal(deniedBody.reason, 'policy-denied')
    assert.equal(deniedBody.detail.policy, 'read-only')
  })
})

describe('/bot command listing and dispatching', () => {
  it('lists active agents/bots on empty input and dispatches prompts by name or pane id without echoing prompt', async () => {
    const acts = []
    const panes = [
      { id: 'w1:p1', status: 'idle', agent: { kind: 'claude', name: 'planner', display: 'claude' } },
      { id: 'bot:openclaw-1', status: 'working', agent: { kind: 'openclaw', name: 'claw', display: 'openclaw' } },
      { id: 'w1:p3', status: 'unknown', agent: null },
    ]
    const service = {
      state: () => ({ panes }),
      act: async (req) => { acts.push(req); return { ok: true, verb: req.verb, pane: req.pane, revision: 2 } },
    }

    const cmd = createBotCommand(service)
    assert.equal(cmd.name, 'bot')

    const listed = await cmd.handler({ rawInput: '' })
    assert.equal(listed.kind, 'success')
    assert.match(listed.text, /planner \(w1:p1\) \[claude\] — idle/)
    assert.match(listed.text, /claw \(bot:openclaw-1\) \[openclaw\] — working/)
    assert.ok(!listed.text.includes('w1:p3'), 'plain shells are excluded')

    const secret = 'SUPER-SECRET-BOT-PROMPT'
    const byName = await cmd.handler({ rawInput: `planner ${secret}` })
    assert.equal(byName.kind, 'success')
    assert.ok(!byName.text.includes(secret), 'prompt must not be echoed')
    assert.deepEqual(acts[0], { verb: 'prompt', pane: 'w1:p1', text: secret })

    const byId = await cmd.handler({ rawInput: `bot:openclaw-1 check status` })
    assert.equal(byId.kind, 'success')
    assert.deepEqual(acts[1], { verb: 'prompt', pane: 'bot:openclaw-1', text: 'check status' })

    const unknown = await cmd.handler({ rawInput: 'ghost hello' })
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /Unknown agent or bot/)
    assert.equal(acts.length, 2)

    const missingPrompt = await cmd.handler({ rawInput: 'planner' })
    assert.equal(missingPrompt.kind, 'error')
    assert.match(missingPrompt.text, /Usage:/)
  })

  it('is registered by index.js apply(ctx)', () => {
    const registeredCommands = []
    const cleanups = []
    const ctx = {
      webServer: { register: () => () => {} },
      connection: { requestRejection: () => undefined },
      commands: {
        register: (spec) => {
          registeredCommands.push(spec)
          return () => {}
        },
      },
      effect: (fn) => {
        const dispose = fn()
        if (typeof dispose === 'function') cleanups.push(dispose)
      },
      logger: { info() {}, warn() {}, debug() {} },
    }

    apply(ctx)
    try {
      const botCmd = registeredCommands.find((c) => c.name === 'bot')
      assert.ok(botCmd, '/bot command should be registered by apply(ctx)')
      assert.equal(typeof botCmd.handler, 'function')
    } finally {
      for (const dispose of cleanups) {
        try { dispose() } catch { /* ignore */ }
      }
    }
  })
})
