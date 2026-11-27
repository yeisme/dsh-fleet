#!/usr/bin/env node
/**
 * Manual, READ-ONLY parity check: does what this host reads over the herdr socket agree with what herdr's own CLI prints?
 *
 *   node scripts/parity.mjs [--json] [--cli-json <file>]
 *
 * It sends exactly two requests through HerdrClient, `ping` and `session.snapshot`. Nothing that types into, changes or
 * closes a pane is ever called. The socket comes from discoverSocket() (HERDR_SOCKET_PATH, HERDR_SESSION, then the default
 * location). The other side is the output of `herdr api snapshot`, which this script runs itself unless `--cli-json <file>`
 * supplies that output (the tests do, so they never reach a real herdr).
 *
 * Both sides go through normalizeSnapshot, then each pane is compared on: presence, agent status, revision, title and agent
 * name. The report carries pane ids, statuses and revisions only: titles and agent names are compared but never printed, and
 * no cwd or other text is read into the report at all.
 *
 * The two reads are a moment apart, so on a busy session a pane can legitimately differ in revision (or a pane that just
 * changed state in status). Run it again before reading anything into a lone mismatch.
 *
 * Exit status: 0 everything agrees, 1 there are mismatches, 2 it could not compare (herdr unreachable, CLI failed, unreadable
 * input, bad usage).
 */
import { execFile } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { discoverBinary, discoverSocket } from '../lib/herdr/discover.js'
import { HerdrClient, isOfflineError, probe } from '../lib/herdr/protocol.js'
import { normalizeSnapshot } from '../lib/herdr/normalize.js'

const USAGE = `usage: node scripts/parity.mjs [--json] [--cli-json <file>]

  --json              print one JSON document instead of the table
  --cli-json <file>   read the output of \`herdr api snapshot\` from a file instead of running it
`

/** Fields whose values are safe to print (an enum and a counter). */
const SCALAR_FIELDS = ['agentStatus', 'revision']
/** Free text: compared, never printed. */
const TEXT_FIELDS = ['title', 'agentName']

class ParityError extends Error {}

const firstLine = (error) => String(error?.message ?? error).split('\n')[0].trim().slice(0, 200)

/**
 * The snapshot inside whatever shape carries it: the RPC result (`{ result: { snapshot } }`, `{ snapshot }`) or the
 * snapshot itself. Returns null when nothing in `value` looks like one.
 */
export function extractSnapshot(value) {
  const candidates = [value?.result?.snapshot, value?.snapshot, value?.result, value]
  return candidates.find((candidate) => candidate !== null && typeof candidate === 'object' && Array.isArray(candidate.panes)) ?? null
}

/**
 * @param {{ panes: object[] }} api normalized snapshot read over the socket
 * @param {{ panes: object[] }} cli normalized snapshot printed by the CLI
 * @returns {{ pane: string, field: string, api: string | number | null, cli: string | number | null, redacted: boolean }[]}
 */
export function compareSnapshots(api, cli) {
  const mine = new Map(api.panes.map((pane) => [pane.id, pane]))
  const theirs = new Map(cli.panes.map((pane) => [pane.id, pane]))
  const ids = [...new Set([...mine.keys(), ...theirs.keys()])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const mismatches = []
  for (const id of ids) {
    const a = mine.get(id)
    const c = theirs.get(id)
    if (!a || !c) {
      mismatches.push({ pane: id, field: 'pane', api: a ? 'present' : 'missing', cli: c ? 'present' : 'missing', redacted: false })
      continue
    }
    for (const field of SCALAR_FIELDS) {
      if (a[field] !== c[field]) mismatches.push({ pane: id, field, api: a[field], cli: c[field], redacted: false })
    }
    for (const field of TEXT_FIELDS) {
      if (a[field] !== c[field]) mismatches.push({ pane: id, field, api: null, cli: null, redacted: true })
    }
  }
  return mismatches
}

function parseArgs(argv) {
  const options = { json: false, cliJson: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--cli-json') {
      index += 1
      if (!argv[index]) throw new ParityError('--cli-json needs a file')
      options.cliJson = argv[index]
    } else if (arg.startsWith('--cli-json=')) options.cliJson = arg.slice('--cli-json='.length)
    else throw new ParityError(`unknown argument ${arg}`)
  }
  return options
}

async function readSocket() {
  const { socketPath } = discoverSocket()
  if (!socketPath) throw new ParityError('no herdr socket location to try (set HERDR_SOCKET_PATH or HERDR_SESSION)')
  const client = new HerdrClient({ socketPath, timeoutMs: 8000 })
  try {
    const hello = await probe(client) // ping
    const result = await client.request('session.snapshot', {})
    const raw = extractSnapshot(result)
    if (!raw) throw new ParityError('herdr answered session.snapshot without a snapshot')
    return { hello, snapshot: normalizeSnapshot(raw) }
  } catch (error) {
    if (error instanceof ParityError) throw error
    throw new ParityError(isOfflineError(error) ? `herdr is not reachable at ${socketPath}` : `herdr request failed: ${firstLine(error)}`)
  } finally {
    client.close()
  }
}

function runCli() {
  const { binaryPath } = discoverBinary()
  if (!binaryPath) throw new ParityError('cannot find the herdr binary (set HERDR_BIN_PATH, or pass --cli-json <file>)')
  return new Promise((resolve, reject) => {
    execFile(binaryPath, ['api', 'snapshot'], { timeout: 15_000, maxBuffer: 64 * 1024 * 1024, env: process.env }, (error, stdout) => {
      if (error) reject(new ParityError(`\`herdr api snapshot\` failed (${error.killed ? 'timed out' : (error.code ?? error.signal)})`))
      else resolve(stdout)
    })
  })
}

async function readCli(file) {
  let text
  if (file) {
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      throw new ParityError(`cannot read ${file}`)
    }
  } else {
    text = await runCli()
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ParityError('the CLI output is not JSON')
  }
  const raw = extractSnapshot(parsed)
  if (!raw) throw new ParityError('the CLI output has no panes list')
  return normalizeSnapshot(raw)
}

function renderTable(report) {
  const { herdr, panes, mismatches } = report
  const lines = [`herdr ${herdr.version ?? '?'} · protocol ${herdr.protocol ?? '?'} · panes: api ${panes.api}, cli ${panes.cli}`]
  if (mismatches.length === 0) {
    lines.push('no mismatches')
    return `${lines.join('\n')}\n`
  }
  const rows = [['pane', 'field', 'api', 'cli'], ...mismatches.map((m) => [m.pane, m.field, m.redacted ? '(text, not shown)' : String(m.api), m.redacted ? '' : String(m.cli)])]
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))
  lines.push(`${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'}`)
  for (const row of rows) lines.push(row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd())
  return `${lines.join('\n')}\n`
}

/** @returns {Promise<number>} the exit status */
export async function main(argv = process.argv.slice(2), { out = (text) => process.stdout.write(text), err = (text) => process.stderr.write(text) } = {}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    err(`parity: ${error.message}\n${USAGE}`)
    return 2
  }
  if (options.help) {
    out(USAGE)
    return 0
  }
  try {
    const { hello, snapshot: api } = await readSocket()
    const cli = await readCli(options.cliJson)
    const mismatches = compareSnapshots(api, cli)
    const report = {
      ok: mismatches.length === 0,
      herdr: { version: hello.version, protocol: hello.protocol },
      panes: { api: api.panes.length, cli: cli.panes.length },
      mismatches,
    }
    out(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderTable(report))
    return report.ok ? 0 : 1
  } catch (error) {
    err(`parity: ${error instanceof ParityError ? error.message : `unexpected failure: ${firstLine(error)}`}\n`)
    return 2
  }
}

/** Run only when executed directly, so the tests can import compareSnapshots() without triggering a socket read. */
function isEntryPoint() {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isEntryPoint()) process.exitCode = await main()
