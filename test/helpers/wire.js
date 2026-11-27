/**
 * A small mutable model of a herdr session, rendered in herdr's own snake_case wire shapes, for tests.
 *
 * Shapes follow `herdr api schema` (herdr 0.9.5, protocol 22) and a key-level look at a live `session.snapshot`
 * (key names and types only; no values were copied). Tests build a world, give it to the fake herdr server
 * (./fake-herdr.js) and mutate it to simulate agents doing things; `snapshot()` is exactly what
 * `session.snapshot` returns inside `{ type: 'session_snapshot', snapshot }`.
 *
 * Deliberately NOT modelled (the host does not read them): layout geometry beyond a stub, scroll, plugins,
 * worktrees. `completion_seq` bumps when work finishes (working/blocked -> done/idle): an approximation of herdr's
 * "the current idle transition completed work", enough for monotonicity assertions, not a spec.
 */

const AGGREGATE_ORDER = ['blocked', 'working', 'done', 'idle', 'unknown']
const WORKING_LIKE = new Set(['working', 'blocked'])
const FINISHED = new Set(['done', 'idle'])

const aggregate = (statuses) => AGGREGATE_ORDER.find((status) => statuses.includes(status)) ?? 'unknown'

/**
 * @typedef {object} AgentSpec
 * @property {string} kind                 e.g. 'claude', 'codex', 'pi', 'grok'
 * @property {string | null} [name]        herdr agent name (the `name` field of the agent entry)
 * @property {string} [status]             working | blocked | done | idle | unknown
 * @property {string} [display]            display_agent, defaults to "<kind> · <title>"
 * @property {{ kind: string, source: string, value: string } | null} [session]   becomes agent_session (+ agent)
 * @property {boolean} [interactiveReady]
 * @property {boolean} [launchPending]
 * @property {number} [completionSeq]
 * @property {number} [stateChangeSeq]
 */

export function createWorld({ workspaces = [], version = '0.9.5', protocol = 22 } = {}) {
  const workspaceList = []
  const tabList = []
  const panes = new Map()
  let terminalSeq = 0

  const world = {
    version,
    protocol,

    addWorkspace({ id, label = id, tabs = [] }) {
      workspaceList.push({ id, label, number: workspaceList.length + 1 })
      for (const tab of tabs) world.addTab(id, tab)
      return world
    },

    addTab(workspaceId, { id, label = 'tab', panes: paneSpecs = [] }) {
      tabList.push({ id, workspaceId, label, number: tabList.filter((tab) => tab.workspaceId === workspaceId).length + 1 })
      for (const spec of paneSpecs) world.addPane(id, spec)
      return world
    },

    /** @param {{ id: string, title?: string, cwd?: string, focused?: boolean, label?: string | null, revision?: number, screen?: string, agent?: AgentSpec | null }} spec */
    addPane(tabId, spec) {
      const tab = tabList.find((candidate) => candidate.id === tabId)
      if (!tab) throw new Error(`unknown tab ${tabId}`)
      const title = spec.title ?? ''
      const agent = spec.agent
        ? {
          kind: spec.agent.kind,
          name: spec.agent.name ?? null,
          status: spec.agent.status ?? 'idle',
          display: spec.agent.display ?? null,
          session: spec.agent.session ?? null,
          interactiveReady: spec.agent.interactiveReady ?? true,
          launchPending: spec.agent.launchPending ?? false,
          completionSeq: spec.agent.completionSeq ?? 0,
          stateChangeSeq: spec.agent.stateChangeSeq ?? 1,
        }
        : null
      terminalSeq += 1
      panes.set(spec.id, {
        id: spec.id,
        workspaceId: tab.workspaceId,
        tabId,
        terminalId: `term_${String(terminalSeq).padStart(8, '0')}`,
        title,
        rawTitle: spec.rawTitle ?? title,
        cwd: spec.cwd ?? '/Users/demo/work',
        label: spec.label ?? null,
        focused: spec.focused === true,
        revision: spec.revision ?? 1,
        screen: spec.screen ?? '',
        agent,
      })
      return world
    },

    pane(id) { return panes.get(id) ?? null },
    paneIds() { return [...panes.keys()] },

    /** Resolve an `agent.*` target: a pane id, or an agent name. */
    resolve(target) {
      if (panes.has(target)) return panes.get(target)
      return [...panes.values()].find((record) => record.agent?.name === target) ?? null
    },

    /**
     * Change a pane the way a live session would: any visible change bumps `revision`; a status change bumps
     * `state_change_seq`; finishing work bumps `completion_seq`.
     * @param {string} id
     * @param {{ status?: string, title?: string, cwd?: string, name?: string | null, display?: string, session?: object | null, interactiveReady?: boolean, focused?: boolean }} patch
     */
    update(id, patch) {
      const record = panes.get(id)
      if (!record) throw new Error(`unknown pane ${id}`)
      if (patch.title !== undefined) { record.title = patch.title; record.rawTitle = patch.title }
      if (patch.cwd !== undefined) record.cwd = patch.cwd
      if (patch.focused === true) world.focus(id)
      if (record.agent) {
        const agent = record.agent
        if (patch.name !== undefined) agent.name = patch.name
        if (patch.display !== undefined) agent.display = patch.display
        if (patch.session !== undefined) agent.session = patch.session
        if (patch.interactiveReady !== undefined) agent.interactiveReady = patch.interactiveReady
        if (patch.status !== undefined && patch.status !== agent.status) {
          if (WORKING_LIKE.has(agent.status) && FINISHED.has(patch.status)) agent.completionSeq += 1
          agent.status = patch.status
          agent.stateChangeSeq += 1
        }
      }
      record.revision += 1
      return world
    },

    /** Output moved without any other visible change. */
    touch(id) {
      const record = panes.get(id)
      if (!record) throw new Error(`unknown pane ${id}`)
      record.revision += 1
      return world
    },

    setScreen(id, text) {
      const record = panes.get(id)
      if (!record) throw new Error(`unknown pane ${id}`)
      record.screen = text
      record.revision += 1
      return world
    },

    focus(id) {
      for (const record of panes.values()) record.focused = record.id === id
      return world
    },

    closePane(id) {
      return panes.delete(id)
    },

    /** The `snapshot` object of `session.snapshot`. */
    snapshot() {
      const records = [...panes.values()]
      const focusedPane = records.find((record) => record.focused) ?? null
      const statusOf = (record) => (record.agent ? record.agent.status : 'unknown')
      return {
        version,
        protocol,
        focused_workspace_id: focusedPane?.workspaceId ?? workspaceList[0]?.id ?? null,
        focused_tab_id: focusedPane?.tabId ?? tabList[0]?.id ?? null,
        focused_pane_id: focusedPane?.id ?? null,
        workspaces: workspaceList.map((workspace) => {
          const mine = records.filter((record) => record.workspaceId === workspace.id)
          const myTabs = tabList.filter((tab) => tab.workspaceId === workspace.id)
          return {
            workspace_id: workspace.id,
            label: workspace.label,
            number: workspace.number,
            focused: mine.some((record) => record.focused),
            pane_count: mine.length,
            tab_count: myTabs.length,
            active_tab_id: (mine.find((record) => record.focused)?.tabId ?? myTabs[0]?.id) ?? null,
            agent_status: aggregate(mine.map(statusOf)),
          }
        }),
        tabs: tabList.map((tab) => {
          const mine = records.filter((record) => record.tabId === tab.id)
          return {
            tab_id: tab.id,
            workspace_id: tab.workspaceId,
            label: tab.label,
            number: tab.number,
            focused: mine.some((record) => record.focused),
            pane_count: mine.length,
            agent_status: aggregate(mine.map(statusOf)),
          }
        }),
        panes: records.map(paneWire),
        agents: records.filter((record) => record.agent).map(agentWire),
        layouts: tabList.map((tab) => {
          const mine = records.filter((record) => record.tabId === tab.id)
          return {
            workspace_id: tab.workspaceId,
            tab_id: tab.id,
            zoomed: false,
            focused_pane_id: mine.find((record) => record.focused)?.id ?? null,
            area: { x: 0, y: 0, width: 200, height: 50 },
            panes: mine.map((record, index) => ({ pane_id: record.id, focused: record.focused, rect: { x: index * 40, y: 0, width: 40, height: 50 } })),
            splits: [],
          }
        }),
      }
    },

    /** PaneInfo, as `pane.get` returns it inside `{ type: 'pane_info', pane }`. */
    paneInfo(id) {
      const record = panes.get(id)
      return record ? paneWire(record) : null
    },

    /** AgentInfo, as `agent.get` returns it inside `{ type: 'agent_info', agent }`; null for shells. */
    agentInfo(id) {
      const record = panes.get(id)
      return record?.agent ? agentWire(record) : null
    },
  }

  for (const workspace of workspaces) world.addWorkspace(workspace)
  return world
}

function agentSessionWire(agent) {
  return agent.session ? { agent: agent.kind, ...agent.session } : undefined
}

function paneWire(record) {
  const wire = {
    pane_id: record.id,
    workspace_id: record.workspaceId,
    tab_id: record.tabId,
    terminal_id: record.terminalId,
    cwd: record.cwd,
    foreground_cwd: record.cwd,
    terminal_title: record.rawTitle,
    terminal_title_stripped: record.title,
    focused: record.focused,
    revision: record.revision,
    agent_status: record.agent ? record.agent.status : 'unknown',
    scroll: {},
  }
  if (record.label) wire.label = record.label
  if (record.agent) {
    wire.agent = record.agent.kind
    wire.display_agent = record.agent.display ?? `${record.agent.kind} · ${record.title}`
    const session = agentSessionWire(record.agent)
    if (session) wire.agent_session = session
  }
  return wire
}

function agentWire(record) {
  const { agent } = record
  const wire = {
    agent: agent.kind,
    agent_status: agent.status,
    completion_seq: agent.completionSeq,
    cwd: record.cwd,
    display_agent: agent.display ?? `${agent.kind} · ${record.title}`,
    focused: record.focused,
    foreground_cwd: record.cwd,
    interactive_ready: agent.interactiveReady,
    pane_id: record.id,
    revision: record.revision,
    screen_detection_skipped: false,
    state_change_seq: agent.stateChangeSeq,
    tab_id: record.tabId,
    terminal_id: record.terminalId,
    terminal_title: record.rawTitle,
    terminal_title_stripped: record.title,
    workspace_id: record.workspaceId,
  }
  if (agent.name) wire.name = agent.name
  if (agent.launchPending) wire.launch_pending = true // absent while false in live data
  const session = agentSessionWire(agent)
  if (session) wire.agent_session = session
  return wire
}
