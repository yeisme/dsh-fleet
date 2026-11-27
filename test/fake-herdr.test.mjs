import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { HerdrClient } from '../lib/herdr/protocol.js'
import { startFakeHerdr, isValidKey, WRITE_METHODS } from './helpers/fake-herdr.js'
import { createWorld } from './helpers/wire.js'

const sessionOf = (value) => ({ kind: 'path', source: 'herdr:pi', value })

const demoWorld = () => createWorld({
  workspaces: [
    {
      id: 'w1',
      label: 'dsh-threads-dev',
      tabs: [
        {
          id: 'w1:t1',
          label: 'main',
          panes: [
            { id: 'w1:p1', title: 'reviewer', focused: true, label: 'rev', agent: { kind: 'claude', name: 'dsh-reviewer', status: 'working', session: sessionOf('/Users/demo/s1.jsonl') } },
            { id: 'w1:p2', title: 'tester', agent: { kind: 'codex', status: 'idle' } },
            { id: 'w1:p3', title: 'zsh' },
          ],
        },
      ],
    },
    { id: 'w2', label: 'docs', tabs: [{ id: 'w2:t1', label: 'notes', panes: [{ id: 'w2:p1', title: 'writer', agent: { kind: 'pi', status: 'blocked' } }] }] },
  ],
})

const keysOf = (object) => Object.keys(object).sort()

describe('key grammar the fake enforces (assumed plus-chords; see the fake\'s header)', () => {
  it('accepts plus-separated chords and plain keys', () => {
    for (const key of ['enter', 'esc', 'tab', 'shift+tab', 'up', 'down', 'space', 'backspace', 'ctrl+c', 'ctrl+d', 'y', 'n', '1', '4', 'f5', 'ctrl+shift+a']) {
      assert.equal(isValidKey(key), true, key)
    }
  })

  it('refuses the hyphen form and anything else outside the grammar', () => {
    const hyphen = ['ctrl', 'c'].join('-')
    for (const key of [hyphen, 'Ctrl+C', 'ctrl+', '', ' ', 'ctrl+ctrl', 'hyper+c', 'enter enter', 'ab', null, 3]) {
      assert.equal(isValidKey(key), false, String(key))
    }
  })
})

describe('the world renders herdr\'s wire shapes', () => {
  const snapshot = demoWorld().snapshot()

  it('workspaces, tabs, panes and agents carry the same keys a live session.snapshot carries', () => {
    assert.deepEqual(keysOf(snapshot.workspaces[0]), ['active_tab_id', 'agent_status', 'focused', 'label', 'number', 'pane_count', 'tab_count', 'workspace_id'])
    assert.deepEqual(keysOf(snapshot.tabs[0]), ['agent_status', 'focused', 'label', 'number', 'pane_count', 'tab_id', 'workspace_id'])
    const liveAgentPaneKeys = ['agent', 'agent_session', 'agent_status', 'cwd', 'display_agent', 'focused', 'foreground_cwd', 'label', 'pane_id', 'revision', 'scroll', 'tab_id', 'terminal_id', 'terminal_title', 'terminal_title_stripped', 'workspace_id']
    assert.deepEqual(keysOf(snapshot.panes[0]), liveAgentPaneKeys, 'an agent pane with a label and a session')
    assert.deepEqual(keysOf(snapshot.panes[2]), liveAgentPaneKeys.filter((key) => !['agent', 'agent_session', 'display_agent', 'label'].includes(key)), 'a plain shell pane has no agent keys')
    assert.deepEqual(keysOf(snapshot.agents[0]), ['agent', 'agent_session', 'agent_status', 'completion_seq', 'cwd', 'display_agent', 'focused', 'foreground_cwd', 'interactive_ready', 'name', 'pane_id', 'revision', 'screen_detection_skipped', 'state_change_seq', 'tab_id', 'terminal_id', 'terminal_title', 'terminal_title_stripped', 'workspace_id'])
    assert.deepEqual(keysOf(snapshot.layouts[0]), ['area', 'focused_pane_id', 'panes', 'splits', 'tab_id', 'workspace_id', 'zoomed'])
  })

  it('agent_session is {agent, kind, source, value}; ids look like herdr\'s; shells are not agents', () => {
    assert.deepEqual(snapshot.agents[0].agent_session, { agent: 'claude', kind: 'path', source: 'herdr:pi', value: '/Users/demo/s1.jsonl' })
    assert.deepEqual(snapshot.panes.map((pane) => pane.pane_id), ['w1:p1', 'w1:p2', 'w1:p3', 'w2:p1'])
    assert.deepEqual(snapshot.agents.map((agent) => agent.pane_id), ['w1:p1', 'w1:p2', 'w2:p1'])
    assert.equal(snapshot.panes[2].agent_status, 'unknown')
  })

  it('counts, focus and aggregate status are derived from the panes', () => {
    assert.equal(snapshot.focused_pane_id, 'w1:p1')
    assert.equal(snapshot.focused_workspace_id, 'w1')
    assert.deepEqual(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace.pane_count, workspace.tab_count, workspace.focused, workspace.agent_status]),
      [['w1', 3, 1, true, 'working'], ['w2', 1, 1, false, 'blocked']])
  })

  it('update() moves revision, state_change_seq and completion_seq the way a live session does', () => {
    const world = demoWorld()
    const before = world.agentInfo('w1:p1')
    world.update('w1:p1', { title: 'renamed' })
    assert.equal(world.agentInfo('w1:p1').revision, before.revision + 1, 'any visible change bumps revision')
    assert.equal(world.agentInfo('w1:p1').state_change_seq, before.state_change_seq, '...but not the state sequence')
    world.update('w1:p1', { status: 'done' })
    const done = world.agentInfo('w1:p1')
    assert.equal(done.state_change_seq, before.state_change_seq + 1)
    assert.equal(done.completion_seq, before.completion_seq + 1, 'finishing work bumps completion_seq')
    world.update('w1:p1', { status: 'idle' })
    assert.equal(world.agentInfo('w1:p1').completion_seq, done.completion_seq, 'done -> idle is not new work finishing')
    world.touch('w1:p2')
    assert.equal(world.paneInfo('w1:p2').revision, 2)
  })

  it('focus is exclusive; closing a pane removes it from every list; agent targets resolve by pane id or name', () => {
    const world = demoWorld()
    world.focus('w2:p1')
    assert.deepEqual(world.snapshot().panes.filter((pane) => pane.focused).map((pane) => pane.pane_id), ['w2:p1'])
    assert.equal(world.resolve('dsh-reviewer').id, 'w1:p1')
    assert.equal(world.resolve('w1:p2').id, 'w1:p2')
    assert.equal(world.resolve('nobody'), null)
    world.closePane('w1:p2')
    assert.equal(world.snapshot().panes.some((pane) => pane.pane_id === 'w1:p2'), false)
    assert.equal(world.snapshot().agents.some((agent) => agent.pane_id === 'w1:p2'), false)
  })
})

describe('the fake herdr server', () => {
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

  it('answers session.snapshot with the world and tags results like herdr does', async () => {
    const result = await client.request('session.snapshot', {})
    assert.equal(result.type, 'session_snapshot')
    assert.equal(result.snapshot.panes.length, 4)
    assert.equal((await client.request('agent.get', { target: 'dsh-reviewer' })).agent.pane_id, 'w1:p1')
    assert.equal((await client.request('agent.list', {})).agents.length, 3)
  })

  it('pane.read honours the format: ansi keeps escapes, text strips them; the read carries the pane revision', async () => {
    fake.world.setScreen('w1:p1', '\u001b[1;36mhello\u001b[0m world')
    const ansi = (await client.request('pane.read', { pane_id: 'w1:p1', source: 'visible', format: 'ansi' })).read
    const text = (await client.request('pane.read', { pane_id: 'w1:p1', source: 'visible', format: 'text' })).read
    assert.equal(ansi.text, '\u001b[1;36mhello\u001b[0m world')
    assert.equal(text.text, 'hello world')
    assert.equal(ansi.revision, fake.world.paneInfo('w1:p1').revision)
  })

  it('refuses agent.prompt to a blocked agent with agent_blocked, like herdr', async () => {
    await assert.rejects(client.request('agent.prompt', { target: 'w2:p1', text: 'hi' }), (error) => error.code === 'agent_blocked' && /answer the question on screen first/.test(error.message))
    assert.deepEqual((await client.request('agent.prompt', { target: 'w1:p2', text: 'hi' })).type, 'agent_prompted')
  })

  it('refuses keys outside the grammar (ctrl-c) and accepts ctrl+c, on both key methods', async () => {
    const hyphen = ['ctrl', 'c'].join('-')
    await assert.rejects(client.request('pane.send_keys', { pane_id: 'w1:p1', keys: [hyphen] }), (error) => error.code === 'invalid_key')
    await assert.rejects(client.request('agent.send_keys', { target: 'w1:p1', keys: ['enter', hyphen] }), (error) => error.code === 'invalid_key')
    assert.equal((await client.request('pane.send_keys', { pane_id: 'w1:p1', keys: ['ctrl+c'] })).type, 'ok')
  })

  it('unknown panes and methods are refused; pane.close really removes the pane; rename sets the name', async () => {
    await assert.rejects(client.request('pane.get', { pane_id: 'w9:p9' }), (error) => /unknown agent or pane/.test(error.message))
    await assert.rejects(client.request('no.such.method', {}), (error) => error.code === 'unknown_method')
    await client.request('agent.rename', { target: 'w1:p2', name: 'dsh-tester' })
    assert.equal(fake.world.agentInfo('w1:p2').name, 'dsh-tester')
    await client.request('pane.close', { pane_id: 'w1:p3' })
    assert.equal(fake.world.pane('w1:p3'), null)
  })

  it('agent.start is refused on a pane that still runs an agent (assumed herdr behavior)', async () => {
    await assert.rejects(client.request('agent.start', { name: 'x', kind: 'claude', pane_id: 'w1:p1' }), (error) => error.code === 'agent_already_running')
    assert.equal((await client.request('agent.start', { name: 'x', kind: 'claude', pane_id: 'w1:p3' })).type, 'agent_started')
  })

  it('records every request; writeRequests() is exactly the typing/lifecycle methods, refused ones included', async () => {
    await client.request('session.snapshot', {})
    await client.request('pane.read', { pane_id: 'w1:p1', source: 'visible', format: 'text' })
    assert.deepEqual(fake.writeRequests(), [], 'reads are not writes')
    await client.request('agent.prompt', { target: 'w2:p1', text: 'hi' }).catch(() => {})
    await client.request('pane.send_text', { pane_id: 'w1:p1', text: 'x' })
    assert.deepEqual(fake.writeRequests().map((request) => request.method), ['agent.prompt', 'pane.send_text'], 'a refused write was still attempted, and that is what the safety tests must catch')
    for (const method of ['agent.prompt', 'agent.send_keys', 'agent.start', 'agent.rename', 'pane.send_text', 'pane.send_keys', 'pane.send_input', 'pane.close', 'pane.release_agent']) {
      assert.ok(WRITE_METHODS.has(method), method)
    }
    for (const method of ['ping', 'session.snapshot', 'pane.get', 'agent.get', 'agent.list', 'pane.read', 'events.subscribe']) {
      assert.equal(WRITE_METHODS.has(method), false, method)
    }
  })

  it('handle() overrides a method for every later request', async () => {
    fake.handle('ping', () => ({ type: 'pong', version: '9.9.9', protocol: 99, capabilities: { x: true } }))
    assert.equal((await client.request('ping')).version, '9.9.9')
    assert.equal((await client.request('ping')).version, '9.9.9')
  })

  it('stop() removes the socket file and start() puts it back at the same path', async () => {
    await fake.stop()
    assert.equal(fs.existsSync(fake.socketPath), false)
    await fake.start()
    assert.equal(fs.existsSync(fake.socketPath), true)
    assert.equal((await client.request('ping')).type, 'pong')
  })

  it('close() cleans up its temp directory', async () => {
    const own = await startFakeHerdr()
    const directory = own.socketPath.replace(/\/herdr\.sock$/, '')
    assert.equal(fs.existsSync(directory), true)
    await own.close()
    assert.equal(fs.existsSync(directory), false)
  })
})
