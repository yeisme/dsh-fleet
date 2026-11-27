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
 * Composition: `legacy.apply(ctx, config)` runs completely unwrapped so its errors surface to the host
 * exactly as before. Fleet Control Room registrations run inside an isolated try/catch so a Fleet error
 * can never break legacy panes.
 */
import React, { useEffect, useState } from 'react'
import { FleetView } from './fleet/fleet-view.jsx'

/* global createLegacyPlugin -- defined by the classic prelude that scripts/build.mjs inlines
   (src/legacy/threads-btw.classic.js + glue), not imported. */
const legacy = createLegacyPlugin()

export const inject = legacy.inject

const FLEET_TAB_ID = '@local/dsh-threads/fleet'
const FLEET_ADDRESS = 'dsh-resource://fleet/control-room'

function createJumpBus() {
  let seq = 0
  const listeners = new Set()
  return {
    trigger() {
      seq += 1
      for (const listener of listeners) {
        try { listener(seq) } catch { /* isolate */ }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    current() {
      return seq
    },
  }
}

function registerFleet(ctx) {
  const jumpBus = createJumpBus()

  const openFleet = (scope) => {
    try {
      scope?.sidebarRight?.openResource?.(FLEET_ADDRESS, { revealIfOpened: true })
    } catch { /* ignore if sidebarRight unavailable */ }
  }

  const handoffContinue = (scope) => async (pane, contextText) => {
    try {
      const id = await scope?.sessions?.create?.({ cwd: pane.cwd })
      if (typeof id === 'string' && id.length > 0) {
        if (scope?.conversation?.input?.for && scope?.sessions?.using) {
          await scope.sessions.using(id, { source: 'paneChat' }, (reference) => {
            scope.conversation.input.for(reference.binding.ctx).setDraft(contextText)
          }).catch(() => {})
        }
        scope?.sidebarRight?.openResource?.(`dsh-resource://panechat/session/${id}`, { revealIfOpened: true })
        return
      }
    } catch { /* fall back to clipboard */ }
    try {
      await globalThis.navigator?.clipboard?.writeText(contextText)
    } catch { /* ignore */ }
  }

  ctx.inject(['sidebarRightTabs', 'sidebarRight', 'slots'], (scope) => {
    scope.effect(() => scope.sidebarRightTabs.register({
      id: FLEET_TAB_ID,
      kind: 'fleet',
      patterns: ['dsh-resource://fleet/**'],
      priority: 'extension',
      canOpen: (addr) => typeof addr === 'string' && addr.startsWith('dsh-resource://fleet/'),
      title: () => 'Fleet 控制室',
      guide: [{
        id: 'fleet-control-room',
        order: 5,
        title: () => 'Fleet 控制室',
        description: () => '多 Agent 舰队面板：状态总览、审批快通、实时屏幕与门禁',
        run: () => openFleet(scope),
      }],
    }), 'fleet: register tab definition')

    function FleetTabBody() {
      const [jumpSignal, setJumpSignal] = useState(() => jumpBus.current())
      useEffect(() => jumpBus.subscribe(setJumpSignal), [])
      return React.createElement(FleetView, {
        jumpSignal,
        onHandoffContinue: handoffContinue(scope),
      })
    }

    function FleetTabTitle() {
      return React.createElement('span', { 'data-dsh-fleet-tab-title': '' }, 'Fleet 控制室')
    }

    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: FLEET_TAB_ID,
    }, FleetTabBody)), 'fleet: register tab body')

    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: FLEET_TAB_ID,
    }, FleetTabTitle)), 'fleet: register tab title')
  })

  ctx.inject(['commandUi', 'sidebarRight'], (scope) => {
    scope.effect(() => scope.commandUi.register({
      name: 'fleet',
      label: () => 'Fleet 控制室',
      description: () => '打开多 Agent 舰队控制室',
      available: () => true,
      ui: {
        kind: 'action',
        run: () => openFleet(scope),
      },
    }), 'fleet: register /fleet command')
  })

  ctx.inject(['shortcuts', 'sidebarRight'], (scope) => {
    scope.effect(() => {
      const shortcuts = scope.shortcuts
      const binding = { code: 'KeyA', modifiers: ['primary', 'alt'] }
      const { issue, conflicts } = shortcuts.describeBinding?.(binding) ?? { issue: null, conflicts: [] }
      if (issue !== null || (Array.isArray(conflicts) && conflicts.length > 0)) return undefined
      const defaults = {
        'desktop:macos': binding,
        'desktop:windows': binding,
        'desktop:linux': binding,
        'web:macos': binding,
        'web:windows': binding,
      }
      return shortcuts.register({
        id: 'fleet.attention',
        label: () => 'Fleet：跳到下一个待处理 Agent',
        aliases: ['fleet attention', 'next blocked agent'],
        defaults,
        regions: ['page', 'editable', 'terminal'],
        modals: [],
        resolve: () => ({
          status: 'handled',
          run: () => {
            openFleet(scope)
            jumpBus.trigger()
          },
        }),
      })
    }, 'fleet: register attention jump shortcut')
  })
}

export function apply(ctx, config) {
  // Legacy apply is intentionally UNWRAPPED so its errors surface to the host unchanged.
  const result = legacy.apply(ctx, config)
  try {
    registerFleet(ctx, config)
  } catch (error) {
    console.error('[dsh-fleet] failed to initialize Fleet UI:', error)
  }
  return result
}
