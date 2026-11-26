/** Runs scripts/build.mjs (bun) into a temp file so tests never touch dist/ or the live client.js. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0

/**
 * @param {string[]} [extraArgs] extra build.mjs arguments (e.g. ['--entry', file, '--no-legacy'])
 * @param {{ cwd?: string }} [options] cwd lets a test prove the output does not depend on it
 * @returns {{ status: number, code: string | null, stderr: string }}
 */
export function build(extraArgs = [], { cwd = ROOT } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-threads-build-'))
  const out = join(dir, 'client.js')
  try {
    const run = spawnSync('bun', [join(ROOT, 'scripts/build.mjs'), '--out', out, ...extraArgs], { cwd, encoding: 'utf8' })
    return { status: run.status ?? -1, code: run.status === 0 ? readFileSync(out, 'utf8') : null, stderr: run.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
