/**
 * The host's client-module "seed words": the ONLY specifiers a plugin bundle may leave as
 * `require("…")` in its output.
 *
 * Source of truth: the host web frontend registers exactly this object as `staticModules`
 * (DSH 0.2.2-rc.3, @deepseek-ai/dsh-web-frontend/dist/assets/index-*.js, function `qJ()`).
 * `require(spec)` resolves seed words first; anything else must be a registered package factory,
 * otherwise the loader throws "require(...) missed the module table"
 * (@deepseek-ai/dsh-client-modules/src/client/system.ts:328-339).
 *
 * Deliberately absent: the JSX dev runtime, react/jsx-dev-runtime (hard-rule-ignore). It is NOT a seed word,
 * so a development-mode JSX build would crash at load time. This is HARD RULE 1 in scripts/build.mjs.
 *
 * Policy (S0 spike 3, 2026-11-27): the four `@deepseek-ai/dsh-client-*` words below are resolvable, but they
 * ship no types or docs in the install and may drift between rc.3 and rc.5. We keep our own UI
 * primitives and do not import them. `@tanstack/react-virtual` and `zod` are fair game.
 */
export const SEEDS = Object.freeze([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])
