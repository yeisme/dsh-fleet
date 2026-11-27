/**
 * Locate the running herdr binary and its API socket.
 *
 * Copied from herdr-orchestrator/lib/discover.js (code reuse only), made testable: every input (environment, home,
 * platform, filesystem probes) can be injected.
 *
 * `herdr` is commonly installed into a user bin directory that a non-login shell does not carry, so PATH alone is
 * not enough; the socket is the primary liveness signal and the binary is only needed for CLI-only surfaces.
 */
import os from 'node:os'
import path from 'node:path'
import { existsSync, accessSync, constants } from 'node:fs'

const isExecutable = (candidate) => {
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const defaults = () => ({ env: process.env, home: os.homedir(), platform: process.platform, exists: existsSync, executable: isExecutable })

export function binaryCandidates({ env, home, platform } = defaults()) {
  const list = []
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    if (localAppData) list.push(path.join(localAppData, 'herdr', 'herdr.exe'), path.join(localAppData, 'Programs', 'herdr', 'herdr.exe'))
    list.push('herdr.exe')
    return list
  }
  list.push(path.join(home, '.local', 'bin', 'herdr'), path.join(home, '.cargo', 'bin', 'herdr'), '/opt/homebrew/bin/herdr', '/usr/local/bin/herdr', '/usr/bin/herdr')
  if (env.HERDR_BIN_PATH) list.unshift(env.HERDR_BIN_PATH)
  list.push('herdr')
  return list
}

export function socketCandidates({ env, home, platform } = defaults()) {
  const list = []
  if (env.HERDR_SOCKET_PATH) list.push(env.HERDR_SOCKET_PATH)
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config')
  if (env.HERDR_SESSION) list.push(path.join(configHome, 'herdr', 'sessions', env.HERDR_SESSION, 'herdr.sock'))
  list.push(path.join(configHome, 'herdr', 'herdr.sock'), path.join(home, '.config', 'herdr', 'herdr.sock'))
  if (platform === 'win32' && env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'herdr', 'herdr.sock'))
  return list
}

function whichSync(name, { env, executable }) {
  if (!env.PATH) return null
  for (const dir of env.PATH.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (executable(candidate)) return candidate
  }
  return null
}

/** @returns {{ binaryPath: string | null, binarySource: 'config' | 'candidate' | 'PATH' | null }} */
export function discoverBinary(configured, context = {}) {
  const ctx = { ...defaults(), ...context }
  if (configured) return { binaryPath: configured, binarySource: 'config' }
  for (const candidate of binaryCandidates(ctx)) {
    if (candidate === 'herdr' || candidate === 'herdr.exe') {
      const fromPath = whichSync(candidate, ctx)
      if (fromPath) return { binaryPath: fromPath, binarySource: 'PATH' }
      continue
    }
    if (ctx.executable(candidate)) return { binaryPath: candidate, binarySource: 'candidate' }
  }
  return { binaryPath: null, binarySource: null }
}

/**
 * The first candidate that exists wins; if none does, the first candidate is returned (not-yet-existing) so the
 * caller can show where it looked.
 * @returns {{ socketPath: string | null, socketExists: boolean }}
 */
export function discoverSocket(configured, context = {}) {
  const ctx = { ...defaults(), ...context }
  if (configured) return { socketPath: configured, socketExists: ctx.exists(configured) }
  const candidates = socketCandidates(ctx)
  for (const candidate of candidates) {
    if (ctx.exists(candidate)) return { socketPath: candidate, socketExists: true }
  }
  return { socketPath: candidates[0] ?? null, socketExists: false }
}
