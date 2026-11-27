import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { POLICIES, writability } from '../lib/fleet/writability.js'
import { loadContract } from '../lib/fleet/schema.js'

const agent = { id: 'w1:p1', isAgent: true }
const shell = { id: 'w1:p4', isAgent: false }
const online = { connected: true, stale: false }
const offline = { connected: false, stale: true }

describe('writability', () => {
  it('under policy "all" an agent pane is writable while herdr is up', () => {
    assert.deepEqual(writability(agent, { policy: 'all', ...online }), { writable: true, reason: null })
    assert.deepEqual(writability(agent), { writable: true, reason: null }, 'defaults: all, connected')
  })

  it('a plain shell is never writable, whatever the policy and connection', () => {
    for (const policy of POLICIES) {
      for (const state of [online, offline]) {
        assert.deepEqual(writability(shell, { policy, dshPanes: new Set([shell.id]), ...state }), { writable: false, reason: 'not-an-agent' }, `${policy} ${JSON.stringify(state)}`)
      }
    }
  })

  it('read-only refuses every agent', () => {
    assert.deepEqual(writability(agent, { policy: 'read-only', ...online }), { writable: false, reason: 'policy-read-only' })
  })

  it('dsh-only allows exactly the panes DSH created', () => {
    const dshPanes = new Set(['w1:p1'])
    assert.deepEqual(writability(agent, { policy: 'dsh-only', dshPanes, ...online }), { writable: true, reason: null })
    assert.deepEqual(writability({ id: 'w1:p2', isAgent: true }, { policy: 'dsh-only', dshPanes, ...online }), { writable: false, reason: 'policy-dsh-only' })
    assert.deepEqual(writability(agent, { policy: 'dsh-only', ...online }), { writable: false, reason: 'policy-dsh-only' }, 'no registry means nothing is DSH-created')
  })

  it('an outage makes agents read-only with the transient reason, either flag is enough', () => {
    assert.deepEqual(writability(agent, { policy: 'all', connected: false, stale: false }), { writable: false, reason: 'offline' })
    assert.deepEqual(writability(agent, { policy: 'all', connected: true, stale: true }), { writable: false, reason: 'offline' })
  })

  it('intrinsic reasons outrank the outage: policy is not hidden by it', () => {
    assert.deepEqual(writability(agent, { policy: 'read-only', ...offline }), { writable: false, reason: 'policy-read-only' })
    assert.deepEqual(writability(agent, { policy: 'dsh-only', ...offline }), { writable: false, reason: 'policy-dsh-only' })
  })

  it('fails closed on a policy it does not know', () => {
    for (const policy of ['ALL', 'write', '', null, false, 3]) {
      assert.deepEqual(writability(agent, { policy, ...online }), { writable: false, reason: 'policy-read-only' }, String(policy))
    }
  })

  it('every reason it can give, and the policy list, are in the contract', () => {
    const contract = loadContract()
    const reasons = contract.$defs.Pane.properties.writableReason.enum
    const given = new Set([
      writability(shell).reason,
      writability(agent, { policy: 'read-only' }).reason,
      writability(agent, { policy: 'dsh-only' }).reason,
      writability(agent, { connected: false }).reason,
      writability(agent).reason,
    ])
    for (const reason of given) assert.ok(reasons.includes(reason), String(reason))
    assert.deepEqual([...POLICIES].sort(), [...contract.$defs.Policy.properties.write.enum].sort())
  })
})
