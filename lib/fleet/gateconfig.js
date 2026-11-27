import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const GATE_STEP_NAME = /^[a-z][a-z0-9-]{0,39}$/
export const MAX_GATE_STEPS = 8

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export class GateConfigError extends Error {
  constructor(source, message, options) {
    super(`${source}: ${message}`, options)
    this.name = 'GateConfigError'
    this.source = source
  }
}

export function gateTimeoutMs(value = DEFAULT_TIMEOUT_MS) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError('timeoutMs must be a positive integer')
  return Math.min(value, MAX_TIMEOUT_MS)
}

async function readDocument(cwd, file) {
  let contents
  try {
    contents = await readFile(join(cwd, file), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new GateConfigError(file, 'could not read configuration', { cause: error })
  }
  let document
  try {
    document = JSON.parse(contents)
  } catch (error) {
    throw new GateConfigError(file, 'invalid JSON', { cause: error })
  }
  if (!isObject(document)) throw new GateConfigError(file, 'expected a JSON object')
  return document
}

function readSteps(gate, source) {
  if (!isObject(gate)) throw new GateConfigError(source, 'expected an object')
  if (!Array.isArray(gate.steps)) throw new GateConfigError(source, 'steps must be an array')
  if (gate.steps.length > MAX_GATE_STEPS) throw new GateConfigError(source, `at most ${MAX_GATE_STEPS} steps are allowed`)
  const { continueOnError = false } = gate
  if (typeof continueOnError !== 'boolean') throw new GateConfigError(source, 'continueOnError must be a boolean')

  const steps = gate.steps.map((step, index) => {
    const field = `steps[${index}]`
    if (!isObject(step)) throw new GateConfigError(source, `${field} must be an object`)
    const { name, cmd, args = [], timeoutMs } = step
    if (typeof name !== 'string' || !GATE_STEP_NAME.test(name)) {
      throw new GateConfigError(source, `${field}.name must match ${GATE_STEP_NAME}`)
    }
    if (typeof cmd !== 'string' || cmd.trim() === '' || cmd.includes('\0')) {
      throw new GateConfigError(source, `${field}.cmd must be a non-empty command`)
    }
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) {
      throw new GateConfigError(source, `${field}.args must be an array of strings`)
    }
    try {
      return { name, cmd, args, timeoutMs: gateTimeoutMs(timeoutMs) }
    } catch (error) {
      throw new GateConfigError(source, `${field}.${error.message}`, { cause: error })
    }
  })
  return { steps, continueOnError }
}

/** A gate is selected as a whole. A present, invalid gate prevents fallback to another set of commands. */
export async function readGateConfig(cwd) {
  if (typeof cwd !== 'string' || cwd === '') throw new GateConfigError('cwd', 'expected a project directory')
  const fleet = await readDocument(cwd, '.dsh/fleet.json')
  if (fleet && Object.hasOwn(fleet, 'gate')) return readSteps(fleet.gate, '.dsh/fleet.json gate')

  const pkg = await readDocument(cwd, 'package.json')
  if (pkg && Object.hasOwn(pkg, 'dshFleet')) {
    if (!isObject(pkg.dshFleet)) throw new GateConfigError('package.json dshFleet', 'expected an object')
    if (Object.hasOwn(pkg.dshFleet, 'gate')) return readSteps(pkg.dshFleet.gate, 'package.json dshFleet.gate')
  }
  return { steps: [] }
}
