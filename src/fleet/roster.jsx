/**
 * Attention-first left column (Roster) for the Fleet Control Room.
 * Groups panes by human-attention urgency using `lib/fleet/attention.js`.
 */
import { useMemo, useState } from 'react'
import {
  ATTENTION_GROUPS,
  attentionGroup,
  formatElapsed,
  isStalled,
  isUnread,
  sortByAttention,
} from '../../lib/fleet/attention.js'

export const POLICY_OPTIONS = [
  { value: 'all', label: '全部可写' },
  { value: 'dsh-only', label: '仅 DSH 创建' },
  { value: 'read-only', label: '只读锁定' },
]

const SOURCE_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'herdr', label: 'Herdr' },
  { key: 'bots', label: 'Bots' },
]

export function isBotPane(pane) {
  return Boolean(pane && (pane.id?.startsWith('bot:') || pane.workspaceId === 'bots'))
}

const GATE_LABELS = {
  running: '门禁运行中',
  passed: '门禁通过',
  failed: '门禁失败',
  stale: '门禁过期',
}

export function dotClassFor(pane, now) {
  if (!pane || pane.agent === null) return 'dsh-fleet-dot dsh-fleet-dot--idle'
  if (pane.status === 'blocked') return 'dsh-fleet-dot dsh-fleet-dot--blocked'
  if (pane.status === 'working') {
    return isStalled(pane, now)
      ? 'dsh-fleet-dot dsh-fleet-dot--stalled'
      : 'dsh-fleet-dot dsh-fleet-dot--working'
  }
  if (pane.status === 'done') return 'dsh-fleet-dot dsh-fleet-dot--done'
  if (pane.status === 'idle') return 'dsh-fleet-dot dsh-fleet-dot--idle'
  return 'dsh-fleet-dot dsh-fleet-dot--unknown'
}

export function statusLabelFor(pane, now, seen) {
  if (!pane || pane.agent === null) return '终端'
  if (pane.status === 'blocked') return '等你处理'
  if (pane.status === 'working') return isStalled(pane, now) ? '停滞 >3m' : '运行中'
  if (pane.status === 'done') return isUnread(pane, seen) ? '已完成 · 未读' : '已完成'
  if (pane.status === 'idle') return '空闲'
  return '未识别'
}

function PaneRow({ pane, selected, now, seen, onSelect }) {
  const title = pane.title || pane.agent?.display || pane.id
  const elapsed = formatElapsed(now - pane.stateSince)
  const gate = pane.checks?.gate
  const label = statusLabelFor(pane, now, seen)
  const rowClass = [
    'dsh-fleet-row',
    selected ? 'dsh-fleet-row--selected' : '',
    pane.status === 'blocked' ? 'dsh-fleet-row--blocked' : '',
  ].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      className={rowClass}
      onClick={() => onSelect(pane.id)}
      aria-current={selected ? 'true' : undefined}
      data-fleet-pane-id={pane.id}
    >
      <div className="dsh-fleet-row-top">
        <span className={dotClassFor(pane, now)} title={label} aria-label={label} />
        <span className="dsh-fleet-row-title" title={title}>{title}</span>
        <span className="dsh-fleet-row-time dsh-fleet-num">{elapsed}</span>
      </div>
      <div className="dsh-fleet-row-meta">
        {pane.agent && (
          <span className="dsh-fleet-pill">{pane.agent.kind}</span>
        )}
        {isBotPane(pane) && (
          <span className="dsh-fleet-pill dsh-fleet-pill--bot">Bot</span>
        )}
        {pane.agent?.name && (
          <span>@{pane.agent.name}</span>
        )}
        <span>{pane.workspaceLabel}</span>
        {gate && gate !== 'none' && (
          <span className={`dsh-fleet-pill dsh-fleet-pill--${gate}`}>
            {GATE_LABELS[gate] ?? gate}
          </span>
        )}
        {!pane.writable && (
          <span title={pane.writableReason ?? 'readonly'}>只读</span>
        )}
      </div>
      {pane.summary && (
        <div className="dsh-fleet-row-summary" title={pane.summary}>{pane.summary}</div>
      )}
    </button>
  )
}

export function Roster({
  state,
  now,
  seen,
  selectedId,
  onSelect,
  searchInputRef,
  onSetPolicy,
  policyUpdating = false,
  onOpenBotDrawer,
  onOpenSpawnDrawer,
}) {
  const [search, setSearch] = useState('')
  const [workspaceId, setWorkspaceId] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [onlyNeedsMe, setOnlyNeedsMe] = useState(false)
  const [idleExpanded, setIdleExpanded] = useState(false)
  const [shellsExpanded, setShellsExpanded] = useState(false)

  const panes = state?.panes ?? []
  const workspaces = state?.workspaces ?? []
  const policyWrite = state?.policy?.write ?? 'read-only'

  const sourceCounts = useMemo(() => {
    let herdr = 0
    let bots = 0
    for (const pane of panes) {
      if (pane.agent === null) continue
      if (isBotPane(pane)) bots += 1
      else herdr += 1
    }
    return { all: herdr + bots, herdr, bots }
  }, [panes])

  const { groups, shells } = useMemo(() => {
    const query = search.trim().toLowerCase()
    const filtered = panes.filter((pane) => {
      if (sourceFilter === 'bots' && !isBotPane(pane)) return false
      if (sourceFilter === 'herdr' && isBotPane(pane)) return false
      if (workspaceId !== 'all' && pane.workspaceId !== workspaceId) return false
      if (query) {
        const hay = [
          pane.id,
          pane.title,
          pane.cwd,
          pane.workspaceLabel,
          pane.summary,
          pane.agent?.name,
          pane.agent?.kind,
          pane.agent?.display,
        ].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(query)) return false
      }
      return true
    })

    const sorted = sortByAttention(filtered, { now, seen })
    const bucket = {
      blocked: [],
      unread: [],
      stalled: [],
      working: [],
      unknown: [],
      idle: [],
      shells: [],
    }

    for (const pane of sorted) {
      const g = attentionGroup(pane, { now, seen })
      if (g === ATTENTION_GROUPS.shell) {
        bucket.shells.push(pane)
        continue
      }
      if (onlyNeedsMe && g > ATTENTION_GROUPS.stalled) continue
      if (g === ATTENTION_GROUPS.blocked) bucket.blocked.push(pane)
      else if (g === ATTENTION_GROUPS.unread) bucket.unread.push(pane)
      else if (g === ATTENTION_GROUPS.stalled) bucket.stalled.push(pane)
      else if (g === ATTENTION_GROUPS.working) bucket.working.push(pane)
      else if (g === ATTENTION_GROUPS.unknown) bucket.unknown.push(pane)
      else bucket.idle.push(pane)
    }

    return {
      groups: [
        { key: 'blocked', label: '等你处理', items: bucket.blocked, collapsible: false },
        { key: 'unread', label: '已完成 · 未读', items: bucket.unread, collapsible: false },
        { key: 'stalled', label: '停滞 >3m', items: bucket.stalled, collapsible: false },
        { key: 'working', label: '运行中', items: bucket.working, collapsible: false },
        { key: 'unknown', label: '未识别', items: bucket.unknown, collapsible: false },
        { key: 'idle', label: '空闲 / 已读', items: bucket.idle, collapsible: true },
      ],
      shells: bucket.shells,
    }
  }, [panes, sourceFilter, workspaceId, search, onlyNeedsMe, now, seen])

  const selectedInIdle = groups.find((g) => g.key === 'idle')?.items.some((p) => p.id === selectedId) ?? false
  const showIdle = idleExpanded || selectedInIdle || search.trim().length > 0

  return (
    <aside className="dsh-fleet-roster" aria-label="Agent 名册">
      <div className="dsh-fleet-roster-controls">
        <div className="dsh-fleet-roster-head">
          <input
            ref={searchInputRef}
            type="search"
            className="dsh-fleet-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索 agent / 目录 / 标题… ( / )"
            aria-label="搜索 agent"
          />
          {(typeof onOpenSpawnDrawer === 'function' || typeof onOpenBotDrawer === 'function') && (
            <div className="dsh-fleet-roster-head-actions">
              {typeof onOpenSpawnDrawer === 'function' && (
                <button
                  type="button"
                  className="dsh-fleet-btn dsh-fleet-btn--primary dsh-fleet-btn--sm"
                  onClick={onOpenSpawnDrawer}
                  title="一键派发本地 Agent（支持 Git Worktree 隔离）"
                >
                  + 派活
                </button>
              )}
              {typeof onOpenBotDrawer === 'function' && (
                <button
                  type="button"
                  className="dsh-fleet-btn dsh-fleet-btn--sm"
                  onClick={onOpenBotDrawer}
                  title="接入外部个人 Agent Bot"
                >
                  + 接入 Bot
                </button>
              )}
            </div>
          )}
        </div>
        <div className="dsh-fleet-filter-row">
          <div className="dsh-fleet-source-pills" role="group" aria-label="按来源筛选">
            {SOURCE_FILTERS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className={`dsh-fleet-source-pill ${sourceFilter === opt.key ? 'dsh-fleet-source-pill--active' : ''}`}
                onClick={() => setSourceFilter(opt.key)}
                aria-pressed={sourceFilter === opt.key}
              >
                <span>{opt.label}</span>
                <span className="dsh-fleet-num">{sourceCounts[opt.key]}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`dsh-fleet-btn dsh-fleet-btn--sm ${onlyNeedsMe ? 'dsh-fleet-btn--active' : ''}`}
            onClick={() => setOnlyNeedsMe((v) => !v)}
            aria-pressed={onlyNeedsMe}
          >
            仅看需要我
          </button>
        </div>
        <div className="dsh-fleet-filter-row">
          <select
            className="dsh-fleet-select"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            aria-label="按工作区筛选"
          >
            <option value="all">全部工作区 ({workspaces.length})</option>
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.label} ({ws.paneCount})
              </option>
            ))}
          </select>
          <span className="dsh-fleet-row-time dsh-fleet-num">
            {state?.counts?.agents ?? 0} bots
          </span>
        </div>
        <div className="dsh-fleet-policy-row">
          <span className="dsh-fleet-policy-label" title={`policy.write = ${policyWrite}`}>
            {policyWrite === 'read-only' ? '🔒' : '🔓'} 安全锁
          </span>
          <select
            className={`dsh-fleet-select dsh-fleet-policy-select dsh-fleet-policy-select--${policyWrite}`}
            value={policyWrite}
            disabled={policyUpdating || typeof onSetPolicy !== 'function'}
            onChange={(e) => onSetPolicy?.(e.target.value)}
            aria-label="写权限安全锁"
            title={`当前策略：${policyWrite}`}
          >
            {POLICY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="dsh-fleet-roster-list">
        {groups.map((group) => {
          if (group.items.length === 0) return null
          if (group.collapsible) {
            return (
              <div className="dsh-fleet-group" key={group.key}>
                <button
                  type="button"
                  className="dsh-fleet-group-toggle"
                  onClick={() => setIdleExpanded((v) => !v)}
                  aria-expanded={showIdle}
                >
                  <span>{showIdle ? '▾' : '▸'} {group.label}</span>
                  <span className="dsh-fleet-num">{group.items.length}</span>
                </button>
                {showIdle && group.items.map((pane) => (
                  <PaneRow
                    key={pane.id}
                    pane={pane}
                    selected={pane.id === selectedId}
                    now={now}
                    seen={seen}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            )
          }
          return (
            <div className="dsh-fleet-group" key={group.key}>
              <div className="dsh-fleet-group-header">
                <span>{group.label}</span>
                <span className="dsh-fleet-num">{group.items.length}</span>
              </div>
              {group.items.map((pane) => (
                <PaneRow
                  key={pane.id}
                  pane={pane}
                  selected={pane.id === selectedId}
                  now={now}
                  seen={seen}
                  onSelect={onSelect}
                />
              ))}
            </div>
          )
        })}

        {groups.every((g) => g.items.length === 0) && (
          <div className="dsh-fleet-empty">
            <span>{onlyNeedsMe ? '当前没有需要你处理的 Agent' : '没有匹配的 Agent'}</span>
          </div>
        )}
      </div>

      {shells.length > 0 && (
        <div className="dsh-fleet-shells-footer">
          <button
            type="button"
            className="dsh-fleet-group-toggle"
            onClick={() => setShellsExpanded((v) => !v)}
            aria-expanded={shellsExpanded}
          >
            <span>{shellsExpanded ? '▾' : '▸'} 普通终端（只读）</span>
            <span className="dsh-fleet-num">{shells.length}</span>
          </button>
          {shellsExpanded && shells.map((pane) => (
            <PaneRow
              key={pane.id}
              pane={pane}
              selected={pane.id === selectedId}
              now={now}
              seen={seen}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </aside>
  )
}
