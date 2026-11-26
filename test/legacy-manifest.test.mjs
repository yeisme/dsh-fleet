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

    it('registers exactly what the original client.js registered (same calls, same order, same CSS)', async () => {
      const manifest = JSON.parse(JSON.stringify(await recordManifest(code, { fileName: 'build' })))
      assert.deepStrictEqual(manifest, golden.manifest)
    })
  })
})
