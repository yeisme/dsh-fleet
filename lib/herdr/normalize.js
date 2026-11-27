/**
 * herdr's `session.snapshot` (snake_case, split across `panes[]` and `agents[]`) -> the camelCase Snapshot the rest of
 * the host uses (see docs/design/FLEET-HOST.md §2). Pure: no I/O, no clock.
 *
 * Adapted from herdr-orchestrator/lib/state.js (code reuse only). Differences: the agent entry is merged onto its pane
 * (`panes[]` carries no `name`, `completion_seq`, `state_change_seq` or `interactive_ready`; `agents[]` does), the
 * agent session is kept RAW (`value` is how transcripts are found; the browser contract strips it later), and unknown
 * statuses are normalized to 'unknown' so nothing downstream sees a value outside herdr's five.
 *
 * `stateSince` / `outputAt` are null here: they come from watching consecutive snapshots (HerdrState), not from herdr.
 */

const STATUSES = new Set(['working', 'blocked', 'done', 'idle', 'unknown'])

export const EMPTY_SNAPSHOT = Object.freeze({
  version: null,
  protocol: null,
  focused: Object.freeze({ workspaceId: null, tabId: null, paneId: null }),
  workspaces: Object.freeze([]),
  tabs: Object.freeze([]),
  panes: Object.freeze([]),
  updatedAt: 0,
  revision: 0,
})

const list = (value) => (Array.isArray(value) ? value : [])
const text = (value) => (typeof value === 'string' ? value : null)
const status = (value) => (STATUSES.has(value) ? value : 'unknown')
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0)

function normalizeSession(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return {
    agent: text(value.agent),
    kind: text(value.kind),
    source: text(value.source),
    value: text(value.value),
  }
}

function normalizeWorkspace(workspace) {
  return {
    id: workspace.workspace_id,
    number: Number.isInteger(workspace.number) ? workspace.number : null,
    label: text(workspace.label) ?? '',
    focused: workspace.focused === true,
    paneCount: count(workspace.pane_count),
    tabCount: count(workspace.tab_count),
    activeTabId: text(workspace.active_tab_id),
    agentStatus: status(workspace.agent_status),
  }
}

function normalizeTab(tab) {
  return {
    id: tab.tab_id,
    workspaceId: tab.workspace_id,
    number: Number.isInteger(tab.number) ? tab.number : null,
    label: text(tab.label) ?? '',
    focused: tab.focused === true,
    paneCount: count(tab.pane_count),
    agentStatus: status(tab.agent_status),
  }
}

function normalizePane(pane, agent) {
  return {
    id: pane.pane_id,
    workspaceId: pane.workspace_id,
    tabId: pane.tab_id,
    terminalId: text(pane.terminal_id),
    focused: pane.focused === true,
    cwd: text(pane.cwd),
    foregroundCwd: text(pane.foreground_cwd),
    // terminal_title_stripped has the leading status glyph removed; the UI draws its own state mark.
    title: text(pane.terminal_title_stripped) ?? text(pane.terminal_title),
    label: text(pane.label),
    agent: text(pane.agent) ?? text(agent?.agent),
    displayAgent: text(pane.display_agent) ?? text(agent?.display_agent),
    agentName: text(agent?.name),
    agentStatus: status(agent?.agent_status ?? pane.agent_status),
    agentSession: normalizeSession(pane.agent_session ?? agent?.agent_session),
    interactiveReady: typeof agent?.interactive_ready === 'boolean' ? agent.interactive_ready : null,
    launchPending: agent?.launch_pending === true,
    revision: count(pane.revision ?? agent?.revision),
    completionSeq: count(agent?.completion_seq),
    stateChangeSeq: count(agent?.state_change_seq),
    stateSince: null,
    outputAt: null,
  }
}

/** @param {object} result either `{ snapshot }` (the RPC result) or the snapshot itself */
export function normalizeSnapshot(result) {
  const snapshot = result?.snapshot ?? result ?? {}
  const agentsByPane = new Map(list(snapshot.agents).filter((agent) => agent && agent.pane_id).map((agent) => [agent.pane_id, agent]))
  return {
    version: text(snapshot.version),
    protocol: Number.isInteger(snapshot.protocol) ? snapshot.protocol : null,
    focused: {
      workspaceId: text(snapshot.focused_workspace_id),
      tabId: text(snapshot.focused_tab_id),
      paneId: text(snapshot.focused_pane_id),
    },
    workspaces: list(snapshot.workspaces).filter((workspace) => workspace?.workspace_id).map(normalizeWorkspace),
    tabs: list(snapshot.tabs).filter((tab) => tab?.tab_id).map(normalizeTab),
    panes: list(snapshot.panes).filter((pane) => pane?.pane_id).map((pane) => normalizePane(pane, agentsByPane.get(pane.pane_id))),
    updatedAt: 0,
    revision: 0,
  }
}

/**
 * Equality key for "did anything a viewer can see change". The time fields are excluded on purpose: they are derived
 * from watching and move on their own.
 */
export function snapshotSignature(snapshot) {
  return JSON.stringify([
    snapshot.focused,
    snapshot.workspaces.map((w) => [w.id, w.label, w.agentStatus, w.paneCount, w.tabCount, w.focused]),
    snapshot.tabs.map((t) => [t.id, t.label, t.agentStatus, t.paneCount, t.focused]),
    snapshot.panes.map((p) => [p.id, p.agent, p.agentName, p.displayAgent, p.agentStatus, p.title, p.focused, p.cwd, p.foregroundCwd, p.revision, p.completionSeq, p.stateChangeSeq, p.interactiveReady, p.launchPending]),
  ])
}
