import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { GateConfigError, readGateConfig } from '../lib/fleet/gateconfig.js'

const step = (name = 'lint') => ({ name, cmd: 'npm', args: ['run', name], timeoutMs: 120_000 })
const gate = (name) => ({ steps: [step(name)], continueOnError: false })

async function project(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'fleet-gate-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, '.dsh'))
  return {
    cwd,
    fleet: (value) => writeFile(join(cwd, '.dsh', 'fleet.json'), JSON.stringify(value)),
    pkg: (value) => writeFile(join(cwd, 'package.json'), JSON.stringify(value)),
  }
}

it('prefers the Fleet file gate to the package gate, even with zero steps', async (t) => {
  const { cwd, fleet, pkg } = await project(t)
  await pkg({ dshFleet: { gate: gate('test') } })
  await fleet({ gate: gate('lint') })
  assert.deepEqual(await readGateConfig(cwd), gate('lint'))
  await fleet({ gate: { steps: [] } })
  assert.deepEqual(await readGateConfig(cwd), { steps: [], continueOnError: false })
})

it('uses package.json when the Fleet file or its gate field is absent', async (t) => {
  const { cwd, fleet, pkg } = await project(t)
  const configured = { ...gate('test'), continueOnError: true }
  await pkg({ dshFleet: { gate: configured } })
  assert.deepEqual(await readGateConfig(cwd), configured)
  await fleet({ other: true })
  assert.deepEqual(await readGateConfig(cwd), configured)
})

it('returns empty steps when both files are missing', async (t) => {
  const { cwd } = await project(t)
  assert.deepEqual(await readGateConfig(cwd), { steps: [] })
})

it('returns empty steps when package.json has no dshFleet field or gate', async (t) => {
  const { cwd, fleet, pkg } = await project(t)
  await fleet({})
  await pkg({ name: 'demo' })
  assert.deepEqual(await readGateConfig(cwd), { steps: [] })
  await pkg({ dshFleet: {} })
  assert.deepEqual(await readGateConfig(cwd), { steps: [] })
})

it('reads commands only from disk', async (t) => {
  const { cwd, fleet } = await project(t)
  await fleet({ gate: gate('lint') })
  assert.deepEqual(await readGateConfig(cwd, gate('override')), gate('lint'))
  await assert.rejects(readGateConfig({ cwd, ...gate('override') }), GateConfigError)
})

it('rejects the entire gate when a step name is invalid', async (t) => {
  const { cwd, fleet, pkg } = await project(t)
  await pkg({ dshFleet: { gate: gate('test') } })
  for (const name of ['Lint', '0lint', 'lint_check', 'a'.repeat(41), 'lint\n']) {
    await fleet({ gate: { steps: [step(), step(name)] } })
    await assert.rejects(readGateConfig(cwd), { name: 'GateConfigError', message: /steps\[1\]\.name must match/ })
  }
})

it('allows eight steps and rejects nine', async (t) => {
  const { cwd, fleet } = await project(t)
  const steps = Array.from({ length: 8 }, (_, i) => step(`check-${i}`))
  await fleet({ gate: { steps } })
  assert.deepEqual((await readGateConfig(cwd)).steps, steps)
  await fleet({ gate: { steps: [...steps, step('extra')] } })
  await assert.rejects(readGateConfig(cwd), { name: 'GateConfigError', message: /at most 8 steps/ })
})

it('rejects arrays where a config object or gate object is expected', async (t) => {
  const { cwd, fleet, pkg } = await project(t)
  await pkg({ dshFleet: { gate: [] } })
  await assert.rejects(readGateConfig(cwd), { name: 'GateConfigError', message: /^package\.json dshFleet\.gate: expected an object/ })
  await fleet({ gate: [] })
  await assert.rejects(readGateConfig(cwd), { name: 'GateConfigError', message: /^\.dsh\/fleet\.json gate: expected an object/ })
  await fleet([])
  await assert.rejects(readGateConfig(cwd), { name: 'GateConfigError', message: /expected a JSON object/ })
})

it('applies timeout defaults and caps and reports invalid config fields', async (t) => {
  const { cwd, fleet } = await project(t)
  await fleet({ gate: { steps: [{ name: 'lint', cmd: 'npm' }, { ...step('test'), timeoutMs: 900_000 }] } })
  assert.deepEqual(await readGateConfig(cwd), {
    steps: [{ name: 'lint', cmd: 'npm', args: [], timeoutMs: 120_000 }, { ...step('test'), timeoutMs: 600_000 }],
    continueOnError: false,
  })
  for (const [patch, error] of [[{ cmd: '' }, /steps\[0\]\.cmd/], [{ args: [1] }, /steps\[0\]\.args/], [{ timeoutMs: 0 }, /steps\[0\]\.timeoutMs/]]) {
    await fleet({ gate: { steps: [{ ...step(), ...patch }] } })
    await assert.rejects(readGateConfig(cwd), { name: 'GateConfigError', message: error })
  }
})

it('reports malformed JSON without falling back to package.json', async (t) => {
  const { cwd, pkg } = await project(t)
  await pkg({ dshFleet: { gate: gate('test') } })
  await writeFile(join(cwd, '.dsh', 'fleet.json'), '{')
  await assert.rejects(readGateConfig(cwd), { name: 'GateConfigError', message: /^\.dsh\/fleet\.json: invalid JSON/ })
})
