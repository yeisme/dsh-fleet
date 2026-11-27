/**
 * The host wiring: build the live Fleet stack and register its routes.
 *
 * Everything here can fail for an ordinary reason — herdr is not installed, the socket is elsewhere, the settings file
 * is unreadable — and NONE of it may stop the plugin from loading. The BTW/thread routes work without herdr at all, so
 * a machine with no herdr must still get a working plugin with a Fleet page that honestly says "disconnected".
 *
 * That is why the whole body is one guarded construction: `buildFleetHost` returns a host object or throws, and the
 * caller (index.js) only logs the throw. A Fleet that cannot start is a degraded Fleet, not a broken plugin.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { HerdrClient } from '../herdr/protocol.js'
import { HerdrState } from '../herdr/state.js'
import { discoverSocket } from '../herdr/discover.js'
import { FleetStore } from './store.js'
import { createFleetService } from './service.js'
import { readGateConfig, GateConfigError } from './gateconfig.js'
import { installFleetRoutes } from '../http.js'

/** Where Fleet keeps its own settings (the write policy and the panes DSH created). */
export function defaultSettingsFile(home = homedir()) {
  return join(home, '.dsh', 'fleet', 'settings.json')
}

/**
 * The socket to talk to: an explicit config value, then the env override, then discovery.
 * Discovery is what makes this work on a machine where herdr was installed the usual way.
 */
export function resolveSocketPath({ socketPath, env = process.env, home = homedir(), platform = process.platform } = {}) {
  const explicit = typeof socketPath === 'string' && socketPath !== '' ? socketPath : env.DSH_FLEET_HERDR_SOCKET ?? env.HERDR_SOCKET
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const found = discoverSocket(undefined, { env, home, platform })
  // discovery reports existence too; the client only needs the path, and a missing socket is a health problem later.
  return found.socketPath ?? join(home, '.config', 'herdr', 'herdr.sock')
}

/**
 * `git rev-parse HEAD` in `cwd`, or null when this is not a git work tree (or git is missing).
 *
 * Null is a real answer, not a failure: a project without git can still have a gate, it just cannot be "stale".
 * A failing read never throws — the gate runner turns a null baseRevision into "no revision to compare".
 */
export function createReadHead({ spawn = nodeSpawn, timeoutMs = 5000 } = {}) {
  return function readHead(cwd) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs })
      } catch {
        resolve(null)
        return
      }
      let out = ''
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      child.stdout?.on('data', (chunk) => { out += String(chunk) })
      child.on?.('error', () => done(null))
      child.on?.('close', (code) => done(code === 0 ? out.trim() || null : null))
    })
  }
}

/**
 * The gate step runner: start the configured command and collect its exit code and output.
 *
 * Deliberately dumb — no shell, so `cmd`/`args` cannot be smuggled into one; a timeout kills the child and reports it
 * as a timeout instead of hanging the gate forever. Output is capped so one runaway test cannot eat the host's memory.
 */
export function createSpawn({ spawn = nodeSpawn, maxBytes = 64 * 1024 } = {}) {
  return function run(cmd, args, { cwd, timeoutMs } = {}) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(cmd, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs })
      } catch (error) {
        resolve({ code: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false })
        return
      }
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const cap = (text, chunk) => (text.length >= maxBytes ? text : (text + String(chunk)).slice(0, maxBytes))
      child.stdout?.on('data', (chunk) => { stdout = cap(stdout, chunk) })
      child.stderr?.on('data', (chunk) => { stderr = cap(stderr, chunk) })
      const timer = timeoutMs === undefined ? null : setTimeout(() => {
        timedOut = true
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, timeoutMs)
      if (timer !== null) timer.unref?.()
      child.on?.('error', (error) => {
        if (timer !== null) clearTimeout(timer)
        resolve({ code: null, stdout, stderr: stderr || String(error?.message ?? error), timedOut })
      })
      child.on?.('close', (code) => {
        if (timer !== null) clearTimeout(timer)
        resolve({ code, stdout, stderr, timedOut })
      })
    })
  }
}

/**
 * Build the live Fleet stack: herdr connection, its state cache, the durable settings and the service that glues them.
 * Returns `{ service, herdr, client, store, socketPath }`; every one of them is disposed by `stop()`.
 *
 * `start()` is separate: the caller decides whether to begin polling now (index.js does, inside ctx.effect).
 */
export function buildFleetHost({ socketPath, settingsFile, home = homedir(), now, spawn, readHead, logger } = {}) {
  const socket = resolveSocketPath({ socketPath, home })
  const file = settingsFile ?? defaultSettingsFile(home)
  mkdirSync(join(file, '..'), { recursive: true })

  const client = new HerdrClient({ socketPath: socket })
  const herdr = new HerdrState(client)
  const store = new FleetStore({ file })

  const service = createFleetService({
    client,
    herdr,
    store,
    ...(now === undefined ? {} : { now }),
    spawn: spawn ?? createSpawn(),
    readHead: readHead ?? createReadHead(),
    readGateConfig: async (cwd) => {
      try {
        return await readGateConfig(cwd)
      } catch (error) {
        // A broken gate config must not take the pane down: no steps means "no gate", and the reason is logged once.
        if (error instanceof GateConfigError) {
          logger?.warn?.('fleet: ignoring unusable gate config in %s: %s', cwd, error.message)
          return { steps: [] }
        }
        throw error
      }
    },
    home,
  })

  return {
    service,
    herdr,
    client,
    store,
    socketPath: socket,
    settingsFile: file,
    async start() {
      // HerdrState.start() never throws for an unreachable socket: health goes down and polling continues, which is
      // exactly what the Fleet page needs to show ("disconnected, retrying").
      await herdr.start()
      return this
    },
    stop() {
      try { service.stop() } catch { /* already stopped */ }
      try { herdr.stop() } catch { /* already stopped */ }
      try { client.close() } catch { /* already closed */ }
    },
  }
}

/**
 * Register the Fleet routes and start the connection.
 *
 * @param ctx host root context (needs `webServer`, `connection`, `effect`, `logger`)
 * @param options see buildFleetHost
 * @returns the host object, so tests can drive it
 */
export function applyFleetHost(ctx, options = {}) {
  const host = buildFleetHost({ logger: ctx.logger, ...options })
  ctx.effect(() => {
    host.start().catch((error) => ctx.logger?.warn?.('fleet: herdr did not start: %s', String(error?.message ?? error)))
    return () => host.stop()
  }, 'fleet: herdr connection')
  installFleetRoutes(ctx, { service: host.service })
  return host
}
