#!/usr/bin/env node
/**
 * Record / refresh the legacy registration manifest (test/fixtures/legacy-manifest.json).
 *
 *   node scripts/record-legacy-manifest.mjs --from-git [rev]   record from `git show <rev>:client.js`
 *                                                              (default rev e9eb28b: the original, pre-bundler client)
 *   node scripts/record-legacy-manifest.mjs --update           record from a fresh build of src/ (needs bun)
 *                                                              — use after an INTENDED change to what the legacy
 *                                                              client registers or injects, and say so in the commit
 *   node scripts/record-legacy-manifest.mjs --compare <file>   print whether <file> yields the golden manifest
 *
 * The manifest is produced by test/helpers/fake-host.mjs; see that file for what it captures.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { recordManifest } from '../test/helpers/fake-host.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GOLDEN = resolve(ROOT, 'test/fixtures/legacy-manifest.json')
const args = process.argv.slice(2)
const flag = (name) => args.indexOf(name)

function buildToTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-threads-manifest-'))
  const out = join(dir, 'client.js')
  const run = spawnSync('bun', [resolve(ROOT, 'scripts/build.mjs'), '--out', out], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`bun build failed:\n${run.stderr || run.stdout}`)
  const text = readFileSync(out, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return text
}

const normalize = (manifest) => JSON.parse(JSON.stringify(manifest))

if (flag('--from-git') >= 0 || flag('--update') >= 0) {
  let code
  let source
  if (flag('--from-git') >= 0) {
    const rev = args[flag('--from-git') + 1]?.startsWith('--') ? undefined : args[flag('--from-git') + 1]
    const ref = rev ?? 'e9eb28b'
    code = execFileSync('git', ['-C', ROOT, 'show', `${ref}:client.js`], { encoding: 'utf8', maxBuffer: 1 << 26 })
    source = `git ${ref}:client.js`
  } else {
    code = buildToTemp()
    source = 'build of src/ (scripts/build.mjs)'
  }
  const manifest = normalize(await recordManifest(code, { fileName: source }))
  writeFileSync(GOLDEN, `${JSON.stringify({ meta: { recordedFrom: source, harness: 1 }, manifest }, null, 2)}\n`)
  console.log(`wrote ${GOLDEN.replace(`${ROOT}/`, '')} from ${source}: ${manifest.calls.length} recorded calls`)
} else if (flag('--compare') >= 0) {
  const file = args[flag('--compare') + 1]
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
  const manifest = normalize(await recordManifest(readFileSync(resolve(process.cwd(), file), 'utf8'), { fileName: file }))
  try {
    assert.deepStrictEqual(manifest, golden.manifest)
    console.log(`IDENTICAL: ${file} registers exactly what the golden manifest (${golden.meta.recordedFrom}) records: ${manifest.calls.length} calls`)
  } catch (error) {
    console.error(`DIFFERENT: ${error.message.split('\n').slice(0, 30).join('\n')}`)
    process.exit(1)
  }
} else {
  console.error('usage: record-legacy-manifest.mjs --from-git [rev] | --update | --compare <file>')
  process.exit(2)
}
