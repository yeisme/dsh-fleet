import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { build, hasBun, ROOT } from './helpers/bun-build.mjs'
import { recordManifest } from './helpers/fake-host.mjs'

const golden = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/legacy-manifest.json'), 'utf8'))
const count = (calls, name) => calls.filter((c) => c.call === name).length

describe('legacy registration manifest', () => {
  it('the golden manifest is rich enough to mean something', () => {
    const { calls } = golden.manifest
    assert.equal(count(calls, 'ctx.sidebarRightTabs.register'), 3, 'thread, panechat, panechat-start tab types')
    assert.equal(count(calls, 'ctx.shortcuts.register'), 4, 'attention, fold, branch, new')
    assert.equal(count(calls, 'ctx.commandUi.register'), 3)
    assert.equal(count(calls, 'ctx.resources.register'), 1, 'panechat resource protocol')
    assert.ok(count(calls, 'ctx.slots.register') >= 8)
    assert.equal(calls.filter((c) => c.dom === 'head.appendChild').length, 2, 'the two injected style blocks')
    assert.deepEqual(golden.manifest.inject, ['slots', 'locale', 'sessions'])
  })

  describe('against a fresh build', { skip: !hasBun && 'bun is not installed' }, () => {
    let code
    before(() => {
      const result = build()
      assert.equal(result.status, 0, result.stderr)
      code = result.code
    })

    it('registers everything the original client.js registered in exact order, plus Fleet registrations', async () => {
      const manifest = JSON.parse(JSON.stringify(await recordManifest(code, { fileName: 'build' })))
      assert.equal(manifest.id, golden.manifest.id)
      assert.deepStrictEqual(manifest.exports, golden.manifest.exports)
      assert.deepStrictEqual(manifest.inject, golden.manifest.inject)
      for (const req of golden.manifest.requires) {
        assert.ok(manifest.requires.includes(req), `missing legacy require: ${req}`)
      }
      assert.deepStrictEqual(
        manifest.calls.slice(0, golden.manifest.calls.length),
        golden.manifest.calls,
        'legacy registrations must remain verbatim as the exact prefix',
      )
      const fleetCalls = manifest.calls.slice(golden.manifest.calls.length)
      assert.ok(fleetCalls.some((c) => c.call === 'ctx.sidebarRightTabs.register'), 'Fleet tab registered')
      assert.ok(fleetCalls.some((c) => c.call === 'ctx.commandUi.register'), 'Fleet command registered')
      assert.ok(fleetCalls.some((c) => c.call === 'ctx.shortcuts.register'), 'Fleet shortcut registered')
    })
  })
})
