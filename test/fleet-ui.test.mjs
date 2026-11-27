import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fixtures from '../fixtures/fleet.json' with { type: 'json' }
import {
  FixtureTransport,
  SCENARIO_NAMES,
  TIME_FIELDS,
  rebaseTimestamps,
} from '../src/fleet/transport.js'
import { parseAnsi, spanToReactStyle, stripAnsi } from '../src/fleet/ansi.js'

describe('ansi.js SGR parser', () => {
  it('parses standard, bright, bold, dim, italic, underline, inverse, and reset SGR codes', () => {
    const lines = parseAnsi('\u001b[1;36mHeader\u001b[0m plain \u001b[2;3;4;91mWarn\u001b[22;39m end')
    assert.equal(lines.length, 1)
    assert.equal(lines[0].length, 4)

    assert.equal(lines[0][0].text, 'Header')
    assert.equal(lines[0][0].style.bold, true)
    assert.match(lines[0][0].style.fg, /cyan/)

    assert.equal(lines[0][1].text, ' plain ')
    assert.equal(lines[0][1].style.bold, false)
    assert.equal(lines[0][1].style.fg, null)

    assert.equal(lines[0][2].text, 'Warn')
    assert.equal(lines[0][2].style.dim, true)
    assert.equal(lines[0][2].style.italic, true)
    assert.equal(lines[0][2].style.underline, true)
    assert.match(lines[0][2].style.fg, /bright-red/)

    assert.equal(lines[0][3].text, ' end')
    assert.equal(lines[0][3].style.dim, false)
    assert.equal(lines[0][3].style.fg, null)
    assert.equal(lines[0][3].style.italic, true)
  })

  it('parses 256-color and 24-bit RGB SGR codes and converts to React styles', () => {
    const lines = parseAnsi('\u001b[38;5;196mred256\u001b[48;2;10;20;30mrgb\u001b[7minv\u001b[m')
    assert.equal(lines[0][0].style.fg, 'rgb(255, 0, 0)')
    assert.equal(lines[0][1].style.bg, 'rgb(10, 20, 30)')
    assert.equal(lines[0][2].style.inverse, true)
    const invStyle = spanToReactStyle(lines[0][2].style)
    assert.equal(invStyle.color, 'rgb(10, 20, 30)')
    assert.equal(invStyle.backgroundColor, 'rgb(255, 0, 0)')
  })

  it('ignores non-SGR CSI and OSC sequences without leaking escape characters', () => {
    const raw = '\u001b[2J\u001b[?25l\u001b]0;window title\u0007\u001b[1;32mOK\u001b[0m\u001b[3A\nnext'
    const lines = parseAnsi(raw)
    assert.equal(lines.length, 2)
    assert.equal(lines[0].map((s) => s.text).join(''), 'OK')
    assert.equal(lines[0][0].style.bold, true)
    assert.equal(lines[1].map((s) => s.text).join(''), 'next')
    assert.equal(stripAnsi(raw), 'OK\nnext')
  })

  it('strips fixture blocked screen cleanly', () => {
    const screen = fixtures.scenarios.busy.screens['w1:p1']
    const plain = stripAnsi(screen.text)
    assert.match(plain, /Do you want to proceed\?/)
    assert.equal(plain.includes('\u001b'), false)
  })
})

describe('FixtureTransport', () => {
  it('loads all 6 scenarios and rebases ONLY TIME_FIELDS by exact delta while preserving null and ms', async () => {
    const fakeNow = fixtures.now + 500_000
    const expectedDelta = 500_000

    for (const name of SCENARIO_NAMES) {
      const transport = new FixtureTransport({ scenario: name, fixtures, now: () => fakeNow })
      const state = await transport.getState()
      const origState = fixtures.scenarios[name].state
      assert.equal(state.now, origState.now + expectedDelta, `${name}: state.now rebased`)
      if (origState.health.lastOkAt === null) {
        assert.equal(state.health.lastOkAt, null, `${name}: null lastOkAt preserved`)
      } else {
        assert.equal(state.health.lastOkAt, origState.health.lastOkAt + expectedDelta, `${name}: lastOkAt rebased`)
      }
      for (let i = 0; i < state.panes.length; i++) {
        assert.equal(state.panes[i].stateSince, origState.panes[i].stateSince + expectedDelta)
        if (origState.panes[i].outputAt === null) assert.equal(state.panes[i].outputAt, null)
        else assert.equal(state.panes[i].outputAt, origState.panes[i].outputAt + expectedDelta)
      }
    }

    // Verify durations (`ms`) are NOT shifted by rebaseTimestamps, while `at` IS shifted
    const sample = { now: 1000, at: 900, ms: 250, durationMs: 400, outputAt: null, nested: { stateSince: 800, lastOkAt: 950 } }
    const rebased = rebaseTimestamps(sample, 10_000)
    assert.equal(rebased.now, 11_000)
    assert.equal(rebased.at, 10_900)
    assert.equal(rebased.ms, 250)
    assert.equal(rebased.durationMs, 400)
    assert.equal(rebased.outputAt, null)
    assert.equal(rebased.nested.stateSince, 10_800)
    assert.equal(rebased.nested.lastOkAt, 10_950)
    assert.deepEqual([...TIME_FIELDS].sort(), ['at', 'lastOkAt', 'now', 'outputAt', 'stateSince'])
  })

  it('rejects every act.invalid case from fixtures/fleet.json with the exact contract reason', async () => {
    const transport = new FixtureTransport({ scenario: 'busy', fixtures, delta: 0 })
    for (const { why, request, reason } of fixtures.act.invalid) {
      const res = await transport.act(request)
      assert.equal(res.ok, false, `${why}: must fail`)
      assert.equal(res.reason, reason, `${why}: expected ${reason}, got ${res.reason}`)
    }
  })

  it('enforces expectRevision -> 409 screen-changed refusal without mutating pane state', async () => {
    const transport = new FixtureTransport({ scenario: 'busy', fixtures, delta: 0 })
    const screenBefore = await transport.getScreen('w1:p1')
    assert.equal(screenBefore.ok, true)

    // Simulate screen changing before user clicks approve
    const newRev = transport.bumpPaneRevision('w1:p1', 'New confirmation dialog!')
    assert.equal(newRev, screenBefore.revision + 1)

    const staleKeysRes = await transport.act({
      verb: 'keys',
      pane: 'w1:p1',
      keys: ['1'],
      expectRevision: screenBefore.revision,
    })
    assert.equal(staleKeysRes.ok, false)
    assert.equal(staleKeysRes.status, 409)
    assert.equal(staleKeysRes.reason, 'screen-changed')
    assert.equal(staleKeysRes.detail.revision, newRev)

    const staleAnswerRes = await transport.act({
      verb: 'answer',
      pane: 'w1:p1',
      text: 'yes',
      enter: true,
      expectRevision: screenBefore.revision,
    })
    assert.equal(staleAnswerRes.ok, false)
    assert.equal(staleAnswerRes.status, 409)
    assert.equal(staleAnswerRes.reason, 'screen-changed')

    // Pane must still be blocked at newRev (no blind mutation!)
    const stateAfter = await transport.getState()
    const pane = stateAfter.panes.find((p) => p.id === 'w1:p1')
    assert.equal(pane.status, 'blocked')
    assert.equal(pane.revision, newRev)

    // Re-reading screen and sending with fresh revision succeeds
    const freshScreen = await transport.getScreen('w1:p1')
    const okRes = await transport.act({
      verb: 'keys',
      pane: 'w1:p1',
      keys: ['1'],
      expectRevision: freshScreen.revision,
    })
    assert.equal(okRes.ok, true)
    assert.equal(okRes.verb, 'keys')
  })

  it('enforces confirm === true guard for restart and close', async () => {
    const transport = new FixtureTransport({ scenario: 'busy', fixtures, delta: 0 })
    for (const badConfirm of [undefined, false, 'true', 'yes', 1]) {
      for (const verb of ['restart', 'close']) {
        const req = badConfirm === undefined ? { verb, pane: 'w1:p2' } : { verb, pane: 'w1:p2', confirm: badConfirm }
        const res = await transport.act(req)
        assert.equal(res.ok, false)
        assert.equal(res.reason, 'confirm-required', `${verb} with confirm=${String(badConfirm)}`)
      }
    }

    const restartOk = await transport.act({ verb: 'restart', pane: 'w1:p2', confirm: true })
    assert.equal(restartOk.ok, true)

    const closeOk = await transport.act({ verb: 'close', pane: 'w1:p2', confirm: true })
    assert.equal(closeOk.ok, true)
    assert.equal(closeOk.revision, null)
    const afterClose = await transport.getState()
    assert.equal(afterClose.panes.some((p) => p.id === 'w1:p2'), false)
  })

  it('enforces state-dependent refusals: unknown-pane, not-an-agent, agent-blocked, not-blocked, herdr-offline', async () => {
    const transport = new FixtureTransport({ scenario: 'busy', fixtures, delta: 0 })

    const unknownRes = await transport.act({ verb: 'interrupt', pane: 'w9:p9' })
    assert.equal(unknownRes.reason, 'unknown-pane')

    const shellRes = await transport.act({ verb: 'interrupt', pane: 'w1:p4' })
    assert.equal(shellRes.reason, 'not-an-agent')

    const blockedPrompt = await transport.act({ verb: 'prompt', pane: 'w1:p1', text: 'hi' })
    assert.equal(blockedPrompt.reason, 'agent-blocked')
    assert.equal(blockedPrompt.detail.status, 'blocked')

    const notBlockedAnswer = await transport.act({ verb: 'answer', pane: 'w1:p2', text: 'hi', enter: true, expectRevision: 903 })
    assert.equal(notBlockedAnswer.reason, 'not-blocked')

    const staleTransport = new FixtureTransport({ scenario: 'stale', fixtures, delta: 0 })
    const offlineAct = await staleTransport.act({ verb: 'interrupt', pane: 'w1:p3' })
    assert.equal(offlineAct.reason, 'herdr-offline')
    const offlineScreen = await staleTransport.getScreen('w1:p3')
    assert.equal(offlineScreen.ok, false)
    assert.equal(offlineScreen.reason, 'herdr-offline')
  })

  it('notifies subscribers on valid prompt, rename, and interrupt mutations', async () => {
    const transport = new FixtureTransport({ scenario: 'busy', fixtures, delta: 0 })
    const snapshots = []
    const unsub = transport.subscribe((s) => snapshots.push(s))
    assert.equal(snapshots.length, 1)

    const promptRes = await transport.act({ verb: 'prompt', pane: 'w1:p2', text: 'run build' })
    assert.equal(promptRes.ok, true)

    const renameRes = await transport.act({ verb: 'rename', pane: 'w1:p2', name: 'dsh-builder' })
    assert.equal(renameRes.ok, true)

    const intRes = await transport.act({ verb: 'interrupt', pane: 'w1:p2' })
    assert.equal(intRes.ok, true)

    unsub()
    assert.equal(snapshots.length, 4)
    const latest = snapshots[snapshots.length - 1].panes.find((p) => p.id === 'w1:p2')
    assert.equal(latest.agent.name, 'dsh-builder')
    assert.equal(latest.status, 'idle')
  })

  it('setPolicy() updates policy.write and pane writability, preserves not-an-agent on shells, and rejects invalid policies', async () => {
    const transport = new FixtureTransport({ scenario: 'busy', delta: 0 })
    const snapshots = []
    const unsub = transport.subscribe((s) => snapshots.push(s))
    const revBefore = snapshots[0].revision

    // Invalid policy is rejected without mutating state or notifying subscribers
    const badRes = await transport.setPolicy('sudo-all')
    assert.equal(badRes.ok, false)
    assert.equal(badRes.reason, 'invalid-request')
    assert.equal(snapshots.length, 1)

    // Switch to read-only: agents become policy-read-only, shell preserves not-an-agent
    const roRes = await transport.setPolicy('read-only')
    assert.equal(roRes.ok, true)
    assert.equal(snapshots.length, 2)
    const roState = snapshots[1]
    assert.equal(roState.policy.write, 'read-only')
    assert.equal(roState.revision, revBefore + 1)
    const roAgent = roState.panes.find((p) => p.id === 'w1:p1')
    assert.equal(roAgent.writable, false)
    assert.equal(roAgent.writableReason, 'policy-read-only')
    const roShell = roState.panes.find((p) => p.agent === null)
    assert.ok(roShell, 'busy scenario must include a shell pane')
    assert.equal(roShell.writable, false)
    assert.equal(roShell.writableReason, 'not-an-agent')

    // Switch to dsh-only: dsh-* agents stay writable, non-dsh agent becomes policy-dsh-only, shell stays not-an-agent
    const dshRes = await transport.setPolicy('dsh-only')
    assert.equal(dshRes.ok, true)
    const dshState = snapshots[2]
    assert.equal(dshState.policy.write, 'dsh-only')
    const dshAgent = dshState.panes.find((p) => p.id === 'w1:p1')
    assert.equal(dshAgent.writable, true)
    assert.equal(dshAgent.writableReason, null)
    const externalAgent = dshState.panes.find((p) => p.id === 'w1:p4')
    assert.equal(externalAgent.writable, false)
    assert.equal(externalAgent.writableReason, 'policy-dsh-only')
    const dshShell = dshState.panes.find((p) => p.agent === null)
    assert.equal(dshShell.writable, false)
    assert.equal(dshShell.writableReason, 'not-an-agent')

    // Switch back to all: all agents writable again, shell still not-an-agent
    const allRes = await transport.setPolicy('all')
    assert.equal(allRes.ok, true)
    const allState = snapshots[3]
    assert.equal(allState.policy.write, 'all')
    assert.equal(allState.panes.find((p) => p.id === 'w1:p4').writable, true)
    assert.equal(allState.panes.find((p) => p.agent === null).writableReason, 'not-an-agent')

    unsub()
  })

  it('registerBot() creates a bot:* pane, updates counts/workspaces, respects policy, and notifies subscribers', async () => {
    const transport = new FixtureTransport({ scenario: 'busy', delta: 0 })
    const snapshots = []
    const unsub = transport.subscribe((s) => snapshots.push(s))
    const initialCount = snapshots[0].panes.length

    // Rejects missing/empty id
    const badRes = await transport.registerBot({ id: '   ', name: 'empty' })
    assert.equal(badRes.ok, false)
    assert.equal(badRes.reason, 'invalid-request')
    assert.equal(snapshots.length, 1)

    // Registers valid external bot
    const okRes = await transport.registerBot({
      id: 'ops-bot',
      name: 'ops-bot',
      kind: 'webhook',
      summary: '监听部署告警',
    })
    assert.equal(okRes.ok, true)
    assert.equal(okRes.pane.id, 'bot:ops-bot')
    assert.equal(okRes.pane.workspaceId, 'bots')
    assert.equal(okRes.pane.agent.kind, 'webhook')
    assert.equal(okRes.pane.summary, '监听部署告警')
    assert.equal(okRes.pane.writable, true)
    assert.equal(snapshots.length, 2)
    assert.equal(snapshots[1].panes.length, initialCount + 1)
    assert.ok(snapshots[1].workspaces.some((w) => w.id === 'bots'))

    // Handing off a prompt to the newly registered bot works via act()
    const handoffRes = await transport.act({
      verb: 'prompt',
      pane: 'bot:ops-bot',
      text: '<来自 @dsh-reviewer 的交接>\n请跟进部署\n</来自 @dsh-reviewer 的交接>',
    })
    assert.equal(handoffRes.ok, true)
    const updatedBot = snapshots[snapshots.length - 1].panes.find((p) => p.id === 'bot:ops-bot')
    assert.equal(updatedBot.status, 'working')

    unsub()
  })

  it('spawn() creates working panes with & without worktree, updates counts/workspaces/revision, and enforces policy/offline/validation refusals', async () => {
    const transport = new FixtureTransport({ scenario: 'busy', delta: 0 })
    const snapshots = []
    const unsub = transport.subscribe((s) => snapshots.push(s))
    const initialPanes = snapshots[0].panes.length
    const initialWorking = snapshots[0].counts.working
    const initialRev = snapshots[0].revision

    // 1. Invalid kind & empty cwd refusals
    const badKind = await transport.spawn({ kind: 'unknown-cli', cwd: '~/workspace/app' })
    assert.equal(badKind.ok, false)
    assert.equal(badKind.status, 400)
    assert.equal(badKind.reason, 'invalid-request')

    const emptyCwd = await transport.spawn({ kind: 'claude', cwd: '   ' })
    assert.equal(emptyCwd.ok, false)
    assert.equal(emptyCwd.status, 400)
    assert.equal(emptyCwd.reason, 'invalid-request')
    assert.equal(snapshots.length, 1)

    // 2. Happy path without worktree
    const plainRes = await transport.spawn({
      kind: 'claude',
      cwd: '~/workspace/app',
      name: 'feat-ui',
      prompt: '实现快捷键提示栏',
    })
    assert.equal(plainRes.ok, true)
    assert.equal(plainRes.kind, 'claude')
    assert.equal(plainRes.name, 'feat-ui')
    assert.equal(plainRes.cwd, '~/workspace/app')
    assert.equal(plainRes.worktree, null)
    assert.equal(plainRes.pane.status, 'working')
    assert.equal(plainRes.pane.cwd, '~/workspace/app')
    assert.equal(plainRes.pane.agent.kind, 'claude')
    assert.equal(plainRes.pane.agent.name, 'feat-ui')
    assert.equal(plainRes.pane.writable, true)
    assert.equal(snapshots.length, 2)
    assert.equal(snapshots[1].panes.length, initialPanes + 1)
    assert.equal(snapshots[1].counts.working, initialWorking + 1)
    assert.equal(snapshots[1].revision, initialRev + 1)

    const spawnedFrames = await transport.getFrames(plainRes.pane.id)
    assert.equal(spawnedFrames.ok, true)
    assert.ok(spawnedFrames.frames.some((f) => f.kind === 'text' && f.text === '实现快捷键提示栏'))

    // 3. Happy path with worktree: true
    const wtRes = await transport.spawn({
      kind: 'codex',
      cwd: '~/workspace/app/',
      name: 'wt-fix',
      worktree: true,
    })
    assert.equal(wtRes.ok, true)
    assert.equal(wtRes.kind, 'codex')
    assert.equal(wtRes.name, 'wt-fix')
    assert.equal(wtRes.cwd, '~/workspace/app/.worktrees/wt-fix')
    assert.equal(wtRes.pane.cwd, '~/workspace/app/.worktrees/wt-fix')
    assert.equal(wtRes.worktree, 'fleet/wt-fix')
    assert.equal(wtRes.pane.status, 'working')
    assert.equal(snapshots.length, 3)
    assert.equal(snapshots[2].panes.length, initialPanes + 2)
    assert.equal(snapshots[2].counts.working, initialWorking + 2)
    assert.equal(snapshots[2].revision, initialRev + 2)
    assert.ok(snapshots[2].workspaces.some((w) => w.id === wtRes.pane.workspaceId && w.paneCount >= 2))

    // 4. Read-only policy refusal
    await transport.setPolicy('read-only')
    const countBeforeRo = snapshots.length
    const roRes = await transport.spawn({ kind: 'pi', cwd: '~/workspace/app' })
    assert.equal(roRes.ok, false)
    assert.equal(roRes.status, 403)
    assert.equal(roRes.reason, 'policy-denied')
    assert.equal(snapshots.length, countBeforeRo)

    unsub()

    // 5. Offline refusal
    const offlineTransport = new FixtureTransport({ scenario: 'offline', delta: 0 })
    const offlineRes = await offlineTransport.spawn({ kind: 'opencode', cwd: '~/workspace/app' })
    assert.equal(offlineRes.ok, false)
    assert.equal(offlineRes.status, 503)
    assert.equal(offlineRes.reason, 'herdr-offline')
  })
})
