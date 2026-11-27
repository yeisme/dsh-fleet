import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_SNAPSHOT, normalizeSnapshot, snapshotSignature } from '../lib/herdr/normalize.js'
import { createWorld } from './helpers/wire.js'

const world = () => createWorld({
  workspaces: [
    {
      id: 'w1',
      label: 'dsh-threads-dev',
      tabs: [{
        id: 'w1:t1',
        label: 'main',
        panes: [
          { id: 'w1:p1', title: 'reviewer', rawTitle: '✳ reviewer', cwd: '/Users/demo/work/a', focused: true, label: 'rev',
            agent: { kind: 'claude', name: 'dsh-reviewer', status: 'working', display: 'claude · reviewer', completionSeq: 7, stateChangeSeq: 31, session: { kind: 'path', source: 'herdr:claude', value: '/Users/demo/s.jsonl' } } },
          { id: 'w1:p2', title: 'unnamed', agent: { kind: 'pi', status: 'idle', interactiveReady: false, launchPending: true } },
          { id: 'w1:p3', title: 'zsh' },
        ],
      }],
    },
  ],
})

describe('normalizeSnapshot', () => {
  const snapshot = normalizeSnapshot({ snapshot: world().snapshot() })
  const [reviewer, unnamed, shell] = snapshot.panes

  it('renames wire keys and normalizes workspaces, tabs and focus', () => {
    assert.equal(snapshot.version, '0.9.5')
    assert.equal(snapshot.protocol, 22)
    assert.deepEqual(snapshot.focused, { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    assert.deepEqual(snapshot.workspaces, [{ id: 'w1', number: 1, label: 'dsh-threads-dev', focused: true, paneCount: 3, tabCount: 1, activeTabId: 'w1:t1', agentStatus: 'working' }])
    assert.deepEqual(snapshot.tabs, [{ id: 'w1:t1', workspaceId: 'w1', number: 1, label: 'main', focused: true, paneCount: 3, agentStatus: 'working' }])
  })

  it('merges the agent entry onto its pane (name, sequences, readiness come only from agents[])', () => {
    assert.equal(reviewer.agent, 'claude')
    assert.equal(reviewer.agentName, 'dsh-reviewer')
    assert.equal(reviewer.agentStatus, 'working')
    assert.equal(reviewer.displayAgent, 'claude · reviewer')
    assert.equal(reviewer.completionSeq, 7)
    assert.equal(reviewer.stateChangeSeq, 31)
    assert.equal(reviewer.interactiveReady, true)
    assert.equal(reviewer.launchPending, false)
    assert.equal(reviewer.label, 'rev')
    assert.equal(unnamed.agentName, null, 'an agent without a name stays null')
    assert.equal(unnamed.interactiveReady, false)
    assert.equal(unnamed.launchPending, true)
  })

  it('uses the stripped title, keeps cwd and foreground cwd apart, and leaves the time fields for HerdrState', () => {
    assert.equal(reviewer.title, 'reviewer', 'terminal_title is "✳ reviewer"; the stripped one wins')
    assert.equal(reviewer.cwd, '/Users/demo/work/a')
    assert.equal(reviewer.foregroundCwd, '/Users/demo/work/a')
    assert.equal(reviewer.stateSince, null)
    assert.equal(reviewer.outputAt, null)
    assert.equal(snapshot.updatedAt, 0)
    assert.equal(snapshot.revision, 0)
  })

  it('keeps the agent session RAW (value is how transcripts are found)', () => {
    assert.deepEqual(reviewer.agentSession, { agent: 'claude', kind: 'path', source: 'herdr:claude', value: '/Users/demo/s.jsonl' })
    assert.equal(unnamed.agentSession, null)
  })

  it('a plain shell is a pane with no agent facts at all', () => {
    assert.equal(shell.agent, null)
    assert.equal(shell.agentName, null)
    assert.equal(shell.agentStatus, 'unknown')
    assert.equal(shell.agentSession, null)
    assert.equal(shell.interactiveReady, null, 'readiness is an agent fact: unknown for a shell, not false')
    assert.equal(shell.completionSeq, 0)
  })

  it('accepts either the RPC result or the bare snapshot', () => {
    assert.deepEqual(normalizeSnapshot(world().snapshot()), snapshot)
  })

  it('is defensive: junk in, a well-formed empty snapshot out; unknown statuses become "unknown"', () => {
    for (const junk of [undefined, null, {}, { snapshot: null }, { snapshot: { panes: 'nope', agents: 7, workspaces: [null, {}], tabs: [{}] } }]) {
      const result = normalizeSnapshot(junk)
      assert.deepEqual(result.panes, [])
      assert.deepEqual(result.workspaces, [])
      assert.deepEqual(result.tabs, [])
      assert.deepEqual(result.focused, { workspaceId: null, tabId: null, paneId: null })
    }
    const odd = normalizeSnapshot({ snapshot: { panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'thinking' }] } })
    assert.equal(odd.panes[0].agentStatus, 'unknown')
    assert.equal(odd.panes[0].revision, 0)
    assert.equal(odd.panes[0].title, null)
  })

  it('does not share state between calls and does not mutate the wire object', () => {
    const wire = world().snapshot()
    const frozen = structuredClone(wire)
    const a = normalizeSnapshot(wire)
    a.panes[0].title = 'mutated'
    assert.deepEqual(wire, frozen)
    assert.notEqual(normalizeSnapshot(wire).panes[0].title, 'mutated')
  })
})

describe('snapshotSignature', () => {
  const build = (mutate) => {
    const w = world()
    mutate?.(w)
    return snapshotSignature(normalizeSnapshot(w.snapshot()))
  }

  it('is stable for an unchanged world', () => {
    assert.equal(build(), build())
  })

  it('changes when anything a viewer can see changes', () => {
    const base = build()
    const changes = {
      status: (w) => w.update('w1:p1', { status: 'blocked' }),
      title: (w) => w.update('w1:p1', { title: 'renamed' }),
      output: (w) => w.touch('w1:p1'),
      name: (w) => w.update('w1:p1', { name: 'dsh-other' }),
      focus: (w) => w.focus('w1:p2'),
      closed: (w) => w.closePane('w1:p3'),
      ready: (w) => w.update('w1:p2', { interactiveReady: true }),
    }
    for (const [label, mutate] of Object.entries(changes)) assert.notEqual(build(mutate), base, label)
  })

  it('ignores the derived time fields', () => {
    const snapshot = normalizeSnapshot(world().snapshot())
    const timed = { ...snapshot, panes: snapshot.panes.map((pane) => ({ ...pane, stateSince: 123, outputAt: 456 })), updatedAt: 999, revision: 5 }
    assert.equal(snapshotSignature(timed), snapshotSignature(snapshot))
  })
})

describe('EMPTY_SNAPSHOT', () => {
  it('has the same shape as a normalized snapshot and cannot be mutated by accident', () => {
    assert.deepEqual(Object.keys(EMPTY_SNAPSHOT).sort(), Object.keys(normalizeSnapshot({})).sort())
    assert.throws(() => { 'use strict'; EMPTY_SNAPSHOT.panes.push({}) }, TypeError)
  })
})
