import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { scanText } from './helpers/hard-rules.mjs'
import { ROOT } from './helpers/bun-build.mjs'

const SCANNED = ['src', 'scripts', 'lib', 'index.js']
const EXTENSIONS = /\.(?:m?js|jsx|css)$/

function* walk(path) {
  let info
  try { info = statSync(path) } catch { return }
  if (info.isFile()) { if (EXTENSIONS.test(path)) yield path; return }
  for (const name of readdirSync(path)) yield* walk(join(path, name))
}

describe('hard rules', () => {
  it('the scanner really flags each rule (and honors the ignore marker)', () => {
    const devRuntime = ['react', 'jsx-dev-runtime'].join('/')
    const done = ['--dsw-alias-state', 'done', 'primary'].join('-')
    const chord = `'${['ctrl', 'c'].join('-')}'`
    assert.deepEqual(scanText(`import x from "${devRuntime}"`).map((h) => h.rule), [1])
    assert.deepEqual(scanText(`color: var(${done})`).map((h) => h.rule), [2])
    assert.deepEqual(scanText(`keys: [${chord}]`).map((h) => h.rule), [3])
    assert.deepEqual(scanText(`keys: ['ctrl+c', "alt+x", 'shift+tab']`), [])
    assert.deepEqual(scanText(`// ${devRuntime} hard-rule-ignore`), [])
  })

  it('src/, scripts/, lib/ and index.js contain no violations', () => {
    const offenders = []
    const scanned = []
    for (const entry of SCANNED) {
      for (const file of walk(join(ROOT, entry))) {
        scanned.push(relative(ROOT, file))
        for (const hit of scanText(readFileSync(file, 'utf8'))) offenders.push(`${relative(ROOT, file)}:${hit.line} [rule ${hit.rule}] ${hit.text}`)
      }
    }
    // A broken path or extension filter must fail loudly instead of "passing" an empty scan.
    for (const mustScan of ['src/main.js', 'src/legacy/threads-btw.classic.js', 'scripts/build.mjs', 'scripts/seeds.mjs', 'index.js']) {
      assert.ok(scanned.includes(mustScan), `the scan must cover ${mustScan} (covered: ${scanned.length} files)`)
    }
    assert.deepEqual(offenders, [], `hard-rule violations:\n${offenders.join('\n')}`)
  })
})
