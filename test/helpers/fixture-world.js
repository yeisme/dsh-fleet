/**
 * Turns the public contract's golden data (fixtures/fleet.json) back into what the HOST sees: a herdr wire world
 * (snake_case, built with ./wire.js), the time fields HerdrState would have tracked, the summaries map, health, stale
 * and policy. Feeding those to buildState and getting the fixture back proves the model maps herdr's world onto the
 * contract exactly; it is the conformance test of the Fleet state model.
 *
 * Nothing here fixes up the model's side: a fixture that this wire model cannot express stays visible as a diff.
 */
import { normalizeSnapshot } from '../../lib/herdr/normalize.js'
import { createWorld } from './wire.js'

/** The raw session value a real herdr carries (a path). Made up and neutral; buildState must never let it out. */
export const RAW_SESSION_VALUE = (paneId) => `/Users/demo/.sessions/${paneId.replace(/\W+/g, '-')}.jsonl`

/**
 * A wire world whose session.snapshot describes `state` (a contract State): same pane ids and order, workspace and
 * tab labels, agent kinds/names/display/status/session kind+source, sequences and pane revisions, focus.
 * Workspaces are added in the order `state.workspaces` lists them; a workspace without panes cannot appear in a State.
 */
export function worldFromState(state) {
  const world = createWorld({ version: state.health.version ?? '0.9.5', protocol: state.health.protocol ?? 22 })
  for (const workspace of state.workspaces) world.addWorkspace({ id: workspace.id, label: workspace.label })
  const tabs = new Set()
  for (const pane of state.panes) {
    if (tabs.has(pane.tabId)) continue
    tabs.add(pane.tabId)
    world.addTab(pane.workspaceId, { id: pane.tabId, label: pane.tabLabel })
  }
  for (const pane of state.panes) {
    world.addPane(pane.tabId, {
      id: pane.id,
      title: pane.title,
      cwd: pane.cwd,
      focused: pane.focused,
      revision: pane.revision,
      agent: pane.agent === null ? null : {
        kind: pane.agent.kind,
        name: pane.agent.name,
        display: pane.agent.display,
        status: pane.status,
        interactiveReady: pane.agent.interactiveReady,
        completionSeq: pane.completionSeq,
        stateChangeSeq: pane.stateChangeSeq,
        session: pane.agent.session === null ? null : { ...pane.agent.session, value: RAW_SESSION_VALUE(pane.id) },
      },
    })
  }
  return world
}

/** What HerdrState derives by watching: `{ [paneId]: { stateSince, outputAt } }`. */
export function trackingFromState(state) {
  return Object.fromEntries(state.panes.map((pane) => [pane.id, { stateSince: pane.stateSince, outputAt: pane.outputAt }]))
}

/** `{ [paneId]: { text, source } }` for the panes that have a summary; the others are left out on purpose (missing = none). */
export function summariesFromState(state) {
  return Object.fromEntries(state.panes.filter((pane) => pane.summarySource !== 'none').map((pane) => [pane.id, { text: pane.summary, source: pane.summarySource }]))
}

/** The normalized snapshot HerdrState would hold for `world`: wire -> normalizeSnapshot -> tracked times applied. */
export function snapshotFromWorld(world, tracking = {}) {
  const snapshot = normalizeSnapshot(world.snapshot())
  return {
    ...snapshot,
    panes: snapshot.panes.map((pane) => ({ ...pane, stateSince: tracking[pane.id]?.stateSince ?? null, outputAt: tracking[pane.id]?.outputAt ?? null })),
  }
}

/** Everything buildState needs to reproduce `state`; `overrides` replaces any of it. */
export function inputsFromState(state, overrides = {}) {
  const world = worldFromState(state)
  return {
    snapshot: snapshotFromWorld(world, trackingFromState(state)),
    health: structuredClone(state.health),
    stale: state.stale,
    policy: { write: state.policy.write },
    summaries: summariesFromState(state),
    now: state.now,
    revision: state.revision,
    ...overrides,
  }
}
