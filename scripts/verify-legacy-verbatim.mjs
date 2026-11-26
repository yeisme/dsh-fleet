#!/usr/bin/env node
/**
 * Proves src/legacy/threads-btw.classic.js is the pre-Fleet client body LINE FOR LINE:
 * the only thing removed from `client.js` is the outer plugin wrapper.
 *
 *   node scripts/verify-legacy-verbatim.mjs [rev]      (default rev: e9eb28b, the last pre-Fleet commit)
 *
 * Meaningful only until the first intentional legacy edit (P0-4); after that the registration-manifest
 * test (test/legacy-manifest.test.mjs) is the guard and this script is expected to report differences.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rev = process.argv[2] ?? 'e9eb28b'

const original = execFileSync('git', ['-C', ROOT, 'show', `${rev}:client.js`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')
const factoryStart = original.indexOf('  factory(require) {')
const factoryEnd = original.lastIndexOf('  },')
if (factoryStart < 0 || factoryEnd < 0 || factoryEnd <= factoryStart) {
  console.error(`cannot locate the factory wrapper in ${rev}:client.js`)
  process.exit(2)
}
const expected = original.slice(factoryStart + 1, factoryEnd)

const legacy = readFileSync(resolve(ROOT, 'src/legacy/threads-btw.classic.js'), 'utf8').split('\n')
const open = legacy.indexOf('function createLegacy(require) {')
const close = legacy.lastIndexOf('}')
if (open < 0 || close <= open) {
  console.error('cannot locate createLegacy() in the classic fragment')
  process.exit(2)
}
const actual = legacy.slice(open + 1, close)

let firstDiff = -1
for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
  if (expected[i] !== actual[i]) { firstDiff = i; break }
}
if (firstDiff === -1) {
  console.log(`verbatim: ${actual.length} body lines identical to ${rev}:client.js (only the plugin wrapper was removed)`)
} else {
  console.error(`DIFFERS at body line ${firstDiff + 1}:\n  expected: ${JSON.stringify(expected[firstDiff])}\n  actual:   ${JSON.stringify(actual[firstDiff])}`)
  process.exit(1)
}
