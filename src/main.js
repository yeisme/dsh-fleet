/**
 * @local/dsh-threads — client entry. scripts/build.mjs bundles this file (plus the legacy prelude) into
 * ./client.js; the host loads that file, never this one.
 *
 * HARD RULES (adopted by the user 2026-11-27 from the S0 spike report; each has an automated guard):
 *  1. Build with JSX `development:false`. The dev runtime import is not among the host's require seed words,
 *     so it would crash at load (hard-rule-ignore).
 *     Guards: scripts/build.mjs assertBundleSane(), test/build.test.mjs, test/hard-rules.test.mjs.
 *  2. Never use the `state-done` color tokens (hard-rule-ignore). "Done" is `--dsw-alias-state-success-*`:
 *     in the user's Quartz dark theme the done token is #0A84FF, identical to "working".
 *     Guard: test/hard-rules.test.mjs.
 *  3. Key chords are plus-separated, e.g. `ctrl+c` (herdr socket-api docs). Never the hyphen form that
 *     herdr-orchestrator's interrupt used (hard-rule-ignore). Guard: test/hard-rules.test.mjs.
 *
 * Composition at this stage (P0): only the legacy plugin. Fleet features are added here later, each
 * registered inside its own try/catch so a Fleet failure can never take the legacy panes down; the
 * legacy `apply` is deliberately NOT wrapped, so its errors surface to the host exactly as before.
 */

/* global createLegacyPlugin -- defined by the classic prelude that scripts/build.mjs inlines
   (src/legacy/threads-btw.classic.js + glue), not imported. */
const legacy = createLegacyPlugin()

export const inject = legacy.inject

export function apply(ctx, config) {
  return legacy.apply(ctx, config)
}
