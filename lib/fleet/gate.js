import { GATE_STEP_NAME, MAX_GATE_STEPS, gateTimeoutMs } from './gateconfig.js'
import { clipText } from './model.js'

function clockMs(now) {
  const value = now()
  if (!Number.isFinite(value) || value < 0) throw new TypeError('expected epoch milliseconds')
  return Math.floor(value)
}

async function revisionAt(readHead, cwd) {
  const revision = await readHead(cwd)
  if (revision === null || (typeof revision === 'string' && [...revision].length <= 64)) return revision
  throw new TypeError('expected a git revision or null')
}

async function spawnStep(spawn, { cmd, args = [], timeoutMs: configuredTimeout }, cwd) {
  const timeoutMs = gateTimeoutMs(configuredTimeout)
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('gate step timed out'), { code: 'ETIMEDOUT' }))
      controller.abort()
    }, timeoutMs)
  })
  try {
    return await Promise.race([deadline, spawn(cmd, args, { cwd, timeoutMs, signal: controller.signal, shell: false })])
  } finally {
    clearTimeout(timer)
  }
}

function lastOutput({ stdout, stderr } = {}) {
  if (typeof stderr === 'string' && stderr.trimEnd() !== '') return stderr
  return typeof stdout === 'string' ? stdout : ''
}

async function runStep(step, spawn, cwd, now) {
  const startedAt = clockMs(now)
  let reason = null
  let output = ''
  try {
    const result = await spawnStep(spawn, step, cwd)
    output = lastOutput(result)
    if (!Number.isInteger(result.code)) reason = 'spawn error'
    else if (result.code !== 0) reason = `exit ${result.code}`
  } catch (error) {
    reason = error?.code === 'ETIMEDOUT' || error?.code === 'timeout' || error?.name === 'TimeoutError' ? 'timeout' : 'spawn error'
    output = lastOutput(error ?? undefined)
  }
  const text = output.trimEnd()
  const lastLine = text.slice(Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1)
  return {
    step: {
      name: step.name,
      status: reason === null ? 'passed' : 'failed',
      durationMs: Math.max(0, clockMs(now) - startedAt),
      summary: clipText(lastLine),
    },
    failure: reason === null ? null : { step: step.name, reason, excerpt: [...output.slice(-1200)].slice(-600).join('') },
  }
}

/**
 * Run the project's loaded gate config. The launcher owns the child process and must honor the abort signal.
 * A launcher that enforces its own timeout can also reject with ETIMEDOUT, timeout, or TimeoutError.
 */
export async function runGate(options) {
  const checks = { gate: 'none', startedAt: null, durationMs: null, baseRevision: null, headRevision: null, steps: [], failure: null }
  let failureReason = 'could not read base HEAD'
  try {
    const { cwd, config, spawn, now = Date.now, readHead } = options
    const baseRevision = await revisionAt(readHead, cwd)
    failureReason = 'invalid gate configuration'
    const { steps, continueOnError = false } = config
    if (!Array.isArray(steps) || steps.length > MAX_GATE_STEPS || typeof continueOnError !== 'boolean' ||
        steps.some((step) => typeof step?.name !== 'string' || !GATE_STEP_NAME.test(step.name))) {
      throw new TypeError('expected a loaded gate configuration')
    }
    if (steps.length === 0) return checks

    checks.baseRevision = baseRevision
    failureReason = 'gate runner error'
    checks.startedAt = clockMs(now)
    for (const step of steps) {
      if (checks.failure !== null && !continueOnError) {
        checks.steps.push({ name: step.name, status: 'skipped', durationMs: 0, summary: '' })
        continue
      }
      const result = await runStep(step, spawn, cwd, now)
      checks.steps.push(result.step)
      checks.failure ??= result.failure
    }

    failureReason = 'could not read final HEAD'
    checks.headRevision = await revisionAt(readHead, cwd)
    failureReason = 'gate runner error'
    checks.durationMs = Math.max(0, clockMs(now) - checks.startedAt)
    if (checks.baseRevision !== checks.headRevision) checks.gate = 'stale'
    else checks.gate = checks.failure === null ? 'passed' : 'failed'
  } catch {
    checks.gate = 'failed'
    checks.failure ??= { step: '', reason: failureReason, excerpt: '' }
  }
  return checks
}
