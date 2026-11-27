import assert from 'node:assert/strict'
import { it } from 'node:test'
import { runGate } from '../lib/fleet/gate.js'
import { buildState } from '../lib/fleet/model.js'
import { loadContract, validateDef } from '../lib/fleet/schema.js'

const contract = loadContract()
const cwd = '/demo/work'
const start = 1_800_000_000_000
const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const step = (name, timeoutMs) => ({ name, cmd: 'npm', args: ['run', name], timeoutMs })

function setup({ steps = [step('lint'), step('test')], continueOnError, revisions = [base, base], replies = [] } = {}) {
  let time = start
  const reads = []
  const launches = []
  const options = {
    cwd,
    config: { steps, continueOnError },
    now: () => time,
    readHead: async (dir) => {
      reads.push(dir)
      time += 2
      const revision = revisions[reads.length - 1]
      if (revision instanceof Error) throw revision
      return revision
    },
    spawn: async (cmd, args, opts) => {
      launches.push({ cmd, args, opts })
      time += 25
      const result = replies[launches.length - 1]
      if (result instanceof Error) throw result
      return result ?? { code: 0, stdout: '', stderr: '' }
    },
  }
  return { options, reads, launches }
}

async function checked(options) {
  const result = await runGate(options)
  assert.deepEqual(validateDef(contract, 'Checks', result).errors, [])
  return result
}

it('returns none and empty details when there are no steps', async () => {
  const { options, reads, launches } = setup({ steps: [] })
  assert.deepEqual(await checked(options), {
    gate: 'none', startedAt: null, durationMs: null, baseRevision: null, headRevision: null, steps: [], failure: null,
  })
  assert.deepEqual(reads, [cwd])
  assert.deepEqual(launches, [])
})

it('returns passed with timed steps and publishes the result through buildState', async () => {
  const { options, reads, launches } = setup({
    steps: [step('lint'), step('test', 900_000)],
    replies: [{ code: 0, stdout: 'start\nlint ok\n' }, { code: 0, stdout: 'stdout', stderr: 'start\r\ntest ok\r\n' }],
  })
  const result = await checked(options)
  assert.deepEqual(result, {
    gate: 'passed', startedAt: start + 2, durationMs: 52, baseRevision: base, headRevision: base,
    steps: [
      { name: 'lint', status: 'passed', durationMs: 25, summary: 'lint ok' },
      { name: 'test', status: 'passed', durationMs: 25, summary: 'test ok' },
    ],
    failure: null,
  })
  assert.deepEqual(reads, [cwd, cwd])
  assert.deepEqual(launches.map(({ cmd, args, opts }) => [cmd, args, opts.cwd, opts.timeoutMs, opts.shell]), [
    ['npm', ['run', 'lint'], cwd, 120_000, false],
    ['npm', ['run', 'test'], cwd, 600_000, false],
  ])
  const id = 'w1:p1'
  const state = buildState({
    snapshot: { panes: [{ id, workspaceId: 'w1', tabId: 'w1:t1' }] },
    now: start,
    gates: new Map([[id, result]]),
  })
  assert.deepEqual(validateDef(contract, 'State', state).errors, [])
  assert.deepEqual(state.panes[0].checks, result)
})

it('stops after the first failure and marks the remaining steps skipped', async () => {
  const { options, launches } = setup({
    steps: [step('lint'), step('test'), step('build')],
    replies: [{ code: 2, stdout: 'ordinary output', stderr: 'problem\ntry again\n' }],
  })
  const result = await checked(options)
  assert.equal(result.gate, 'failed')
  assert.deepEqual(result.failure, { step: 'lint', reason: 'exit 2', excerpt: 'problem\ntry again\n' })
  assert.deepEqual(result.steps, [
    { name: 'lint', status: 'failed', durationMs: 25, summary: 'try again' },
    { name: 'test', status: 'skipped', durationMs: 0, summary: '' },
    { name: 'build', status: 'skipped', durationMs: 0, summary: '' },
  ])
  assert.deepEqual(launches.map(({ args }) => args[1]), ['lint'])
})

it('runs all steps with continueOnError and preserves the first failure', async () => {
  const { options, launches } = setup({
    steps: [step('lint'), step('test'), step('build')], continueOnError: true,
    replies: [{ code: 1, stdout: 'lint failed' }, { code: 0 }, { code: 2, stderr: 'build failed' }],
  })
  const result = await checked(options)
  assert.equal(result.gate, 'failed')
  assert.deepEqual(result.failure, { step: 'lint', reason: 'exit 1', excerpt: 'lint failed' })
  assert.deepEqual(result.steps.map(({ status }) => status), ['failed', 'passed', 'failed'])
  assert.deepEqual(launches.map(({ args }) => args[1]), ['lint', 'test', 'build'])
})

it('aborts a step at its deadline and records a timeout', async () => {
  const { options } = setup({ steps: [step('lint', 5)] })
  let signal
  options.spawn = (_cmd, _args, opts) => {
    signal = opts.signal
    return new Promise(() => {})
  }
  const result = await checked(options)
  assert.equal(result.gate, 'failed')
  assert.deepEqual(result.failure, { step: 'lint', reason: 'timeout', excerpt: '' })
  assert.equal(result.steps[0].status, 'failed')
  assert.equal(signal.aborted, true)
})

it('records a timeout reported by the launcher with its captured output', async () => {
  const error = Object.assign(new Error('deadline'), { code: 'ETIMEDOUT', stderr: 'partial output' })
  const { options } = setup({ steps: [step('lint')], replies: [error] })
  const result = await checked(options)
  assert.equal(result.gate, 'failed')
  assert.deepEqual(result.failure, { step: 'lint', reason: 'timeout', excerpt: 'partial output' })
  assert.equal(result.steps[0].summary, 'partial output')
})

it('marks results stale when HEAD changes during the run', async () => {
  for (const code of [0, 1]) {
    const { options, reads } = setup({ steps: [step('lint')], replies: [{ code }] })
    let revision = base
    options.readHead = (dir) => { reads.push(dir); return revision }
    const spawn = options.spawn
    options.spawn = (...args) => { revision = head; return spawn(...args) }
    const result = await checked(options)
    assert.deepEqual(reads, [cwd, cwd])
    assert.equal(result.gate, 'stale')
    assert.equal(result.baseRevision, base)
    assert.equal(result.headRevision, head)
    assert.equal(result.steps[0].status, code === 0 ? 'passed' : 'failed')
    assert.equal(result.failure?.reason ?? null, code === 0 ? null : 'exit 1')
  }
})

it('runs outside a git repository with both revisions null', async () => {
  const { options } = setup({ revisions: [null, null] })
  const result = await checked(options)
  assert.equal(result.gate, 'passed')
  assert.equal(result.baseRevision, null)
  assert.equal(result.headRevision, null)
})

it('turns a synchronous spawn exception into a failed step', async () => {
  const { options } = setup()
  options.spawn = () => { throw new Error('launcher failed') }
  const result = await checked(options)
  assert.equal(result.gate, 'failed')
  assert.deepEqual(result.failure, { step: 'lint', reason: 'spawn error', excerpt: '' })
  assert.deepEqual(result.steps.map(({ status }) => status), ['failed', 'skipped'])
  assert.equal(result.headRevision, base)
})

it('returns a failed Checks result when either HEAD read throws', async () => {
  for (const [revisions, reason] of [
    [[new Error('base read failed')], 'could not read base HEAD'],
    [[base, new Error('final read failed')], 'could not read final HEAD'],
  ]) {
    const { options, launches } = setup({ revisions })
    const result = await checked(options)
    assert.equal(result.gate, 'failed')
    assert.deepEqual(result.failure, { step: '', reason, excerpt: '' })
    assert.equal(launches.length, revisions.length === 1 ? 0 : 2)
  }
})

it('clips output by code point and keeps the last 600 characters of a failure', async () => {
  const output = 'prefix\n' + '🌱'.repeat(700) + 'tail\n'
  const { options } = setup({ replies: [{ code: 1, stderr: output }] })
  const result = await checked(options)
  assert.equal(result.steps[0].summary, '🌱'.repeat(239) + '…')
  assert.equal(result.failure.excerpt, [...output].slice(-600).join(''))
})
