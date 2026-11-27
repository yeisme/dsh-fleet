/**
 * 3-pane Fleet Control Room assembling Roster + Stage + Inspector,
 * offline/stale/empty banners, keyboard navigation, and dev fixture switcher.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ATTENTION_GROUPS,
  attentionGroup,
  formatElapsed,
  sortByAttention,
} from '../../lib/fleet/attention.js'
import { Inspector } from './inspector.jsx'
import { Roster } from './roster.jsx'
import { Stage, formatHandoffContext } from './stage.jsx'
import { ensureFleetStyles } from './styles.js'
import { FixtureTransport, LiveTransport, SCENARIO_NAMES } from './transport.js'

const SEEN_STORAGE_KEY = 'dsh-fleet:seen:v1'

function loadSeenMap() {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveSeenMap(map) {
  try {
    globalThis.localStorage?.setItem(SEEN_STORAGE_KEY, JSON.stringify(map))
  } catch { /* ignore storage quota errors */ }
}

function mergeFrames(existing, incoming, { prepend = false, reset = false } = {}) {
  if (reset) return incoming
  const seenIds = new Set()
  const ordered = prepend ? [...incoming, ...existing] : [...existing, ...incoming]
  const deduped = []
  for (const frame of ordered) {
    if (seenIds.has(frame.id)) continue
    seenIds.add(frame.id)
    deduped.push(frame)
  }
  return deduped
}

export function FleetView({
  transport: externalTransport,
  initialMode = 'live',
  onHandoffContinue,
  jumpSignal = 0,
}) {
  const [mode, setMode] = useState(externalTransport ? 'custom' : initialMode)
  const [state, setState] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [activeTab, setActiveTab] = useState('transcript')
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [seen, setSeen] = useState(loadSeenMap)
  const [clockTick, setClockTick] = useState(() => Date.now())
  const [framesData, setFramesData] = useState(null)
  const [framesLoading, setFramesLoading] = useState(false)
  const [screenData, setScreenData] = useState(null)
  const [screenLoading, setScreenLoading] = useState(false)

  const searchInputRef = useRef(null)
  const lastFetchedRef = useRef({ paneId: null, revision: null, cursorEnd: null })

  useEffect(() => {
    ensureFleetStyles()
  }, [])

  const transport = useMemo(() => {
    if (externalTransport) return externalTransport
    if (mode === 'live') return new LiveTransport()
    return new FixtureTransport({ scenario: SCENARIO_NAMES.includes(mode) ? mode : 'busy' })
  }, [externalTransport, mode])

  useEffect(() => {
    const unsubscribe = transport.subscribe((nextState) => {
      setState(nextState)
    })
    return () => {
      unsubscribe()
      if (!externalTransport) transport.close()
    }
  }, [transport, externalTransport])

  // Periodic clock tick so elapsed timers & stalled indicators update live.
  useEffect(() => {
    const timer = setInterval(() => setClockTick(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [])

  const clockOffset = state ? state.now - clockTick : 0
  const now = clockTick + (Math.abs(clockOffset) > 60_000 ? clockOffset : 0)

  const orderedPanes = useMemo(
    () => sortByAttention(state?.panes ?? [], { now, seen }),
    [state?.panes, now, seen],
  )

  // Ensure a valid selection whenever panes arrive or change.
  useEffect(() => {
    const panes = state?.panes ?? []
    if (panes.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !panes.some((p) => p.id === selectedId)) {
      const firstAgent = orderedPanes.find((p) => p.agent !== null) ?? orderedPanes[0]
      setSelectedId(firstAgent?.id ?? null)
    }
  }, [state?.panes, selectedId, orderedPanes])

  const selectedPane = useMemo(
    () => (state?.panes ?? []).find((p) => p.id === selectedId) ?? null,
    [state?.panes, selectedId],
  )

  // Mark selected completed pane as seen in localStorage.
  useEffect(() => {
    if (!selectedPane || selectedPane.status !== 'done' || selectedPane.completionSeq <= 0) return
    setSeen((prev) => {
      if ((prev[selectedPane.id] ?? 0) >= selectedPane.completionSeq) return prev
      const next = { ...prev, [selectedPane.id]: selectedPane.completionSeq }
      saveSeenMap(next)
      return next
    })
  }, [selectedPane?.id, selectedPane?.status, selectedPane?.completionSeq])

  // Jump to next attention-needing pane (used by ⌘⌥A).
  const jumpNextAttention = useCallback(() => {
    const candidates = orderedPanes.filter((p) => attentionGroup(p, { now, seen }) <= ATTENTION_GROUPS.stalled)
    if (candidates.length === 0) return false
    const idx = candidates.findIndex((p) => p.id === selectedId)
    const next = candidates[(idx + 1) % candidates.length]
    setSelectedId(next.id)
    if (next.status === 'blocked') setActiveTab('transcript')
    return true
  }, [orderedPanes, now, seen, selectedId])

  useEffect(() => {
    if (jumpSignal > 0) jumpNextAttention()
  }, [jumpSignal, jumpNextAttention])

  // On-demand /frames fetch when selected pane or its revision changes.
  useEffect(() => {
    if (!selectedPane || !selectedPane.agent) {
      setFramesData(null)
      lastFetchedRef.current = { paneId: null, revision: null, cursorEnd: null }
      return
    }
    const prev = lastFetchedRef.current
    const samePane = prev.paneId === selectedPane.id
    if (samePane && prev.revision === selectedPane.revision) return

    let cancelled = false
    setFramesLoading(true)
    const after = samePane ? prev.cursorEnd : undefined
    void transport.getFrames(selectedPane.id, after ? { after } : {}).then((res) => {
      if (cancelled) return
      if (res?.ok) {
        setFramesData((cur) => {
          if (!samePane || !cur || res.reset || res.source !== 'transcript') return res
          return {
            ...res,
            frames: mergeFrames(cur.frames ?? [], res.frames ?? [], { reset: res.reset }),
            hasEarlier: cur.hasEarlier,
            cursor: {
              start: cur.cursor?.start ?? res.cursor?.start ?? null,
              end: res.cursor?.end ?? cur.cursor?.end ?? null,
            },
          }
        })
        lastFetchedRef.current = {
          paneId: selectedPane.id,
          revision: selectedPane.revision,
          cursorEnd: res.cursor?.end ?? prev.cursorEnd,
        }
      }
    }).finally(() => {
      if (!cancelled) setFramesLoading(false)
    })
    return () => { cancelled = true }
  }, [transport, selectedPane?.id, selectedPane?.revision, selectedPane?.agent])

  const handleLoadEarlier = useCallback(async (beforeCursor) => {
    if (!selectedPane || !beforeCursor) return
    setFramesLoading(true)
    try {
      const res = await transport.getFrames(selectedPane.id, { before: beforeCursor })
      if (res?.ok) {
        setFramesData((cur) => {
          if (!cur) return res
          return {
            ...cur,
            frames: mergeFrames(cur.frames ?? [], res.frames ?? [], { prepend: true }),
            hasEarlier: res.hasEarlier,
            cursor: {
              start: res.cursor?.start ?? cur.cursor?.start ?? null,
              end: cur.cursor?.end ?? res.cursor?.end ?? null,
            },
          }
        })
      }
    } finally {
      setFramesLoading(false)
    }
  }, [transport, selectedPane])

  // Visible-only /screen fetch: ONLY when Live Screen tab is active OR pane is blocked.
  const screenNeeded = Boolean(selectedPane && (activeTab === 'screen' || selectedPane.status === 'blocked'))

  const refreshScreen = useCallback(async () => {
    if (!selectedPane) return
    setScreenLoading(true)
    try {
      const res = await transport.getScreen(selectedPane.id)
      setScreenData(res)
    } finally {
      setScreenLoading(false)
    }
  }, [transport, selectedPane])

  useEffect(() => {
    if (!screenNeeded || !selectedPane) {
      setScreenData(null)
      return
    }
    let cancelled = false
    setScreenLoading(true)
    void transport.getScreen(selectedPane.id).then((res) => {
      if (!cancelled) setScreenData(res)
    }).finally(() => {
      if (!cancelled) setScreenLoading(false)
    })
    return () => { cancelled = true }
  }, [transport, screenNeeded, selectedPane?.id, selectedPane?.revision])

  // Keyboard navigation (j/k, ↑/↓, / to search) when focus is not in an editable field.
  useEffect(() => {
    function onKeyDown(e) {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/') {
        e.preventDefault()
        searchInputRef.current?.focus()
        return
      }
      if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'k' || e.key === 'ArrowUp') {
        const agents = orderedPanes.filter((p) => p.agent !== null)
        if (agents.length === 0) return
        e.preventDefault()
        const idx = agents.findIndex((p) => p.id === selectedId)
        const dir = (e.key === 'j' || e.key === 'ArrowDown') ? 1 : -1
        const nextIdx = idx < 0 ? 0 : (idx + dir + agents.length) % agents.length
        setSelectedId(agents[nextIdx].id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [orderedPanes, selectedId])

  const handleAct = useCallback((req) => transport.act(req), [transport])

  const handleHandoff = useCallback((pane, frames) => {
    const contextText = formatHandoffContext(pane, frames)
    if (typeof onHandoffContinue === 'function') {
      onHandoffContinue(pane, contextText)
    } else {
      void globalThis.navigator?.clipboard?.writeText(contextText)
    }
  }, [onHandoffContinue])

  const health = state?.health
  const counts = state?.counts
  const isOfflineNeverConnected = state && !health?.connected && !state.stale
  const isStale = state && !health?.connected && state.stale
  const isUnsupportedProtocol = state && state.protocol !== 1
  const isEmpty = state && health?.connected && (counts?.agents ?? 0) === 0
  const isCalm = state && health?.connected && (counts?.agents ?? 0) > 0
    && counts.blocked === 0 && counts.working === 0 && counts.done === 0

  return (
    <div className="dsh-fleet-root" data-dsh-fleet-control-room="">
      {/* Top Bar */}
      <header className="dsh-fleet-topbar">
        <div className="dsh-fleet-topbar-left">
          <span className="dsh-fleet-brand">Fleet 控制室</span>
          {state?.machine?.label && (
            <span className="dsh-fleet-pill">{state.machine.label}</span>
          )}
          {counts && (
            <div className="dsh-fleet-stat-strip dsh-fleet-num">
              {counts.blocked > 0 && (
                <span className="dsh-fleet-stat-item">
                  <span className="dsh-fleet-dot dsh-fleet-dot--blocked" /> {counts.blocked} 等你
                </span>
              )}
              {counts.working > 0 && (
                <span className="dsh-fleet-stat-item">
                  <span className="dsh-fleet-dot dsh-fleet-dot--working" /> {counts.working} 运行
                </span>
              )}
              {counts.done > 0 && (
                <span className="dsh-fleet-stat-item">
                  <span className="dsh-fleet-dot dsh-fleet-dot--done" /> {counts.done} 完成
                </span>
              )}
              {isCalm && (
                <span className="dsh-fleet-pill dsh-fleet-pill--passed">全部处理完毕</span>
              )}
            </div>
          )}
        </div>

        <div className="dsh-fleet-topbar-right">
          <button
            type="button"
            className="dsh-fleet-btn dsh-fleet-btn--sm"
            onClick={jumpNextAttention}
            title="跳到下一个需要你处理的 Agent (⌘⌥A)"
          >
            下一个待处理 ⌘⌥A
          </button>
          {!externalTransport && (
            <select
              className="dsh-fleet-select"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              aria-label="数据源切换"
              title="切换实时连接或 Fixture 场景"
            >
              <option value="live">Live (/plugin/fleet)</option>
              {SCENARIO_NAMES.map((name) => (
                <option key={name} value={name}>Fixture: {name}</option>
              ))}
            </select>
          )}
        </div>
      </header>

      {/* Protocol mismatch banner */}
      {isUnsupportedProtocol && (
        <div className="dsh-fleet-banner dsh-fleet-banner--error" role="alert">
          <span>不支持的 Fleet 协议版本（protocol={String(state.protocol)}），请升级客户端。</span>
        </div>
      )}

      {/* Stale banner */}
      {isStale && (
        <div className="dsh-fleet-banner dsh-fleet-banner--warn" role="status">
          <span>
            herdr 已断开（已断开 {health?.lastOkAt ? formatElapsed(now - health.lastOkAt) : '—'}）· 当前展示最后已知状态，所有面板只读。
            {health?.error ? ` 原因：${health.error}` : ''}
          </span>
          <button type="button" className="dsh-fleet-btn dsh-fleet-btn--sm" onClick={() => transport.reconnect?.()}>
            重新连接
          </button>
        </div>
      )}

      {/* Offline (never connected) empty state */}
      {isOfflineNeverConnected ? (
        <div className="dsh-fleet-empty">
          <strong>herdr 未连接</strong>
          <span>{health?.error || '未能连接到 herdr socket，请先启动 herdr 后重试。'}</span>
          <button type="button" className="dsh-fleet-btn dsh-fleet-btn--primary" onClick={() => transport.reconnect?.()}>
            重新连接
          </button>
        </div>
      ) : isEmpty ? (
        <div className="dsh-fleet-empty">
          <strong>还没有运行中的 Agent Bot</strong>
          <span>herdr 已连接，当前仅有 {counts?.shells ?? 0} 个普通终端面板。启动任意 Agent 后会自动出现在这里。</span>
        </div>
      ) : (
        <div className={`dsh-fleet-body ${inspectorOpen && selectedPane ? '' : 'dsh-fleet-body--no-inspector'}`}>
          <Roster
            state={state}
            now={now}
            seen={seen}
            selectedId={selectedId}
            onSelect={setSelectedId}
            searchInputRef={searchInputRef}
          />
          <Stage
            pane={selectedPane}
            now={now}
            seen={seen}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            framesData={framesData}
            framesLoading={framesLoading}
            onLoadEarlier={handleLoadEarlier}
            screenData={screenData}
            screenLoading={screenLoading}
            onRefreshScreen={refreshScreen}
            onAct={handleAct}
            onHandoffContinue={handleHandoff}
            inspectorOpen={inspectorOpen}
            onToggleInspector={() => setInspectorOpen((v) => !v)}
          />
          {inspectorOpen && selectedPane && (
            <Inspector
              pane={selectedPane}
              now={now}
              onAct={handleAct}
              onClose={() => setInspectorOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}
