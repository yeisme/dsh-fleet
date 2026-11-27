/**
 * index.js — the load-time contract of the plugin bundle.
 *
 * The one promise worth a test here is negative: a machine where the Fleet half cannot start must still get the rest of
 * the plugin. The thread routes do not need herdr, so a Fleet failure has to be caught and logged, never thrown at the
 * host — otherwise a missing socket or an unusable ~/.dsh would take the whole bundle down and the user would lose
 * features that have nothing to do with Fleet.
 *
 * The second test is the positive twin: with a healthy host context the Fleet routes ARE registered, so the guard is
 * not silently swallowing a real wiring bug.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** The minimum host context `apply()` touches. */
function fakeCtx({ registerThrows = null, registered = [] } = {}) {
  const cleanups = []
  const warnings = []
  return {
    registered,
    cleanups,
    warnings,
    /** Stop whatever apply() started (the Fleet poller keeps the event loop alive otherwise). */
    dispose() {
      for (const cleanup of cleanups.reverse()) {
        try { cleanup() } catch { /* already gone */ }
      }
    },
    connection: { requestRejection: () => undefined },
    webServer: {
      register: (entry) => {
        if (registerThrows !== null) throw new Error(registerThrows)
        registered.push(entry.path)
        return () => {}
      },
    },
    commands: { register: () => () => {} },
    // Run the effect body like the host does, but remember its cleanup so the test can stop it again.
    effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return () => {} },
    logger: {
      warn: (...args) => warnings.push(args),
      info: () => {},
      debug: () => {},
    },
  }
}

describe('plugin bundle: apply()', () => {
  it('registers the /plugin/fleet/* routes when the host is healthy', () => {
    const ctx = fakeCtx()
    try {
      apply(ctx)
      const fleet = ctx.registered.filter((path) => path.startsWith('/plugin/fleet/'))
      assert.ok(fleet.length >= 5, `expected the five fleet routes, got ${JSON.stringify(ctx.registered)}`)
      for (const path of ['/plugin/fleet/state', '/plugin/fleet/stream', '/plugin/fleet/frames', '/plugin/fleet/screen', '/plugin/fleet/act']) {
        assert.ok(fleet.includes(path), `missing ${path}`)
      }
    } finally {
      ctx.dispose()
    }
  })

  it('a registration failure does not throw out of apply(), and says so in the log', () => {
    // The thread routes register first and must still be there: this is the whole point of the guard.
    const ctx = fakeCtx({ registerThrows: 'boom from webServer' })
    try {
      assert.doesNotThrow(() => apply(ctx))
      assert.ok(ctx.warnings.length > 0, `expected a warning, got ${JSON.stringify(ctx.warnings)}`)
    } finally {
      ctx.dispose()
    }
  })
})
