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
import { POLICY_OPTIONS, Roster } from './roster.jsx'
import { Stage, formatHandoffContext } from './stage.jsx'
import { ensureFleetStyles } from './styles.js'
import { FixtureTransport, LiveTransport, SCENARIO_NAMES } from './transport.js'

const POLICY_LABEL_MAP = Object.fromEntries(POLICY_OPTIONS.map((o) => [o.value, o.label]))

const SPAWN_UI_KINDS = [
  { value: 'claude', label: 'claude' },
  { value: 'codex', label: 'codex' },
  { value: 'pi', label: 'pi' },
  { value: 'opencode', label: 'opencode' },
]

function SpawnAgentDrawer({ defaultCwd, onClose, onSpawn }) {
  const [kind, setKind] = useState('claude')
  const [cwd, setCwd] = useState(() => defaultCwd || '~/workspace')
  const [name, setName] = useState('')
  const [worktree, setWorktree] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState(null)

  const previewName = name.trim() || `dsh-${kind}`
  const cleanCwd = cwd.trim().replace(/\/+$/, '') || '~/workspace'

  async function handleSubmit(e) {
    e.preventDefault()
    const targetCwd = cwd.trim()
    if (!targetCwd || submitting) {
      setFormError('请输入有效的工作目录（cwd）')
      return
    }
    setFormError(null)
    setSubmitting(true)
    try {
      const payload = {
        kind,
        cwd: targetCwd,
        worktree,
      }
      if (name.trim()) payload.name = name.trim()
      if (prompt.trim()) payload.prompt = prompt.trim()
      const res = await onSpawn(payload)
      if (res?.ok) {
        setName('')
        setPrompt('')
        setWorktree(false)
        onClose()
      } else {
        setFormError(res?.message || `派发失败：${res?.reason ?? 'unknown'}`)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="dsh-fleet-spawn-drawer" aria-label="派发 Agent (Spawn Agent)">
      <div className="dsh-fleet-bot-drawer-head">
        <strong>+ 派活 (Spawn Agent)</strong>
        <button type="button" className="dsh-fleet-btn dsh-fleet-btn--sm" onClick={onClose}>
          关闭
        </button>
      </div>
      <form className="dsh-fleet-bot-form" onSubmit={handleSubmit}>
        <div className="dsh-fleet-spawn-grid">
          <label className="dsh-fleet-field">
            <span>Agent 类型</span>
            <select
              className="dsh-fleet-input"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              disabled={submitting}
              aria-label="Agent 类型"
            >
              {SPAWN_UI_KINDS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label className="dsh-fleet-field">
            <span>工作目录 (cwd) *</span>
            <input
              type="text"
              className="dsh-fleet-input"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="~/workspace"
              disabled={submitting}
            />
          </label>
          <label className="dsh-fleet-field">
            <span>名称 (可选)</span>
            <input
              type="text"
              className="dsh-fleet-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 feat-auth"
              disabled={submitting}
            />
          </label>
        </div>

        <label className="dsh-fleet-spawn-check">
          <input
            type="checkbox"
            checked={worktree}
            onChange={(e) => setWorktree(e.target.checked)}
            disabled={submitting}
          />
          <span>新建 Git Worktree 隔离</span>
          {worktree && (
            <span className="dsh-fleet-spawn-hint">
              {cleanCwd}/.worktrees/{previewName}
            </span>
          )}
        </label>

        <label className="dsh-fleet-field">
          <span>初始指令 (可选)</span>
          <textarea
            className="dsh-fleet-spawn-textarea"
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="启动后自动发送给该 Agent 的首条任务指令…"
            disabled={submitting}
          />
        </label>

        {formError && (
          <div className="dsh-fleet-bot-error" role="alert">{formError}</div>
        )}

        <div className="dsh-fleet-bot-form-foot">
          <span className="dsh-fleet-spawn-hint">
            启动后自动选中新面板，Esc 可随时收起抽屉
          </span>
          <button
            type="submit"
            className="dsh-fleet-btn dsh-fleet-btn--primary dsh-fleet-btn--sm"
            disabled={submitting || !cwd.trim()}
          >
            {submitting ? '启动中…' : '立即派发'}
          </button>
        </div>
      </form>
    </section>
  )
}

function buildBotCurlSnippet(baseUrl) {
  const origin = globalThis.location?.origin || 'http://127.0.0.1:4310'
  const root = `${origin}${baseUrl || '/plugin/fleet'}`
  return [
    '# 1) 注册外部 Agent Bot',
    `curl -X POST ${root}/bots/register \\`,
    '  -H \'content-type: application/json\' \\',
    '  -d \'{"id":"my-bot","name":"my-bot","kind":"webhook","summary":"就绪，等待任务"}\'',
    '',
    '# 2) 发送心跳更新状态',
    `curl -X POST ${root}/bots/heartbeat \\`,
    '  -H \'content-type: application/json\' \\',
    '  -d \'{"id":"my-bot","status":"working","summary":"正在处理任务"}\'',
  ].join('\n')
}

function BotConnectDrawer({ baseUrl, onClose, onRegister }) {
  const [botId, setBotId] = useState('')
  const [botName, setBotName] = useState('')
  const [botKind, setBotKind] = useState('webhook')
  const [botSummary, setBotSummary] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [copiedCurl, setCopiedCurl] = useState(false)
  const [formError, setFormError] = useState(null)

  const curlSnippet = useMemo(() => buildBotCurlSnippet(baseUrl), [baseUrl])

  async function handleCopySnippet() {
    try {
      await globalThis.navigator?.clipboard?.writeText(curlSnippet)
      setCopiedCurl(true)
      setTimeout(() => setCopiedCurl(false), 1800)
    } catch {
      setFormError('无法访问剪贴板，请手动复制下方 curl 命令。')
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const cleanId = botId.trim()
    if (!cleanId || submitting) {
      setFormError('请输入 Bot ID（例如 review-bot）')
      return
    }
    setFormError(null)
    setSubmitting(true)
    try {
      const res = await onRegister({
        id: cleanId,
        name: botName.trim() || cleanId,
        kind: botKind.trim() || 'webhook',
        summary: botSummary.trim(),
      })
      if (res?.ok) {
        setBotId('')
        setBotName('')
        setBotSummary('')
        onClose()
      } else {
        setFormError(res?.message || `接入失败：${res?.reason ?? 'unknown'}`)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="dsh-fleet-bot-drawer" aria-label="接入外部 Agent Bot">
      <div className="dsh-fleet-bot-drawer-head">
        <strong>接入外部 Agent Bot</strong>
        <button type="button" className="dsh-fleet-btn dsh-fleet-btn--sm" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="dsh-fleet-bot-drawer-grid">
        <div className="dsh-fleet-bot-snippet">
          <div className="dsh-fleet-bot-snippet-head">
            <span>HTTP 注册与心跳示例（curl）</span>
            <button type="button" className="dsh-fleet-btn dsh-fleet-btn--sm" onClick={handleCopySnippet}>
              {copiedCurl ? '已复制 ✓' : '复制 curl'}
            </button>
          </div>
          <pre className="dsh-fleet-bot-pre">{curlSnippet}</pre>
        </div>

        <form className="dsh-fleet-bot-form" onSubmit={handleSubmit}>
          <div className="dsh-fleet-bot-form-row">
            <label className="dsh-fleet-field">
              <span>Bot ID *</span>
              <input
                type="text"
                className="dsh-fleet-input"
                value={botId}
                onChange={(e) => setBotId(e.target.value)}
                placeholder="例如 ops-bot"
                disabled={submitting}
              />
            </label>
            <label className="dsh-fleet-field">
              <span>名称</span>
              <input
                type="text"
                className="dsh-fleet-input"
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                placeholder="例如 ops-helper"
                disabled={submitting}
              />
            </label>
            <label className="dsh-fleet-field">
              <span>类型 (kind)</span>
              <input
                type="text"
                className="dsh-fleet-input"
                value={botKind}
                onChange={(e) => setBotKind(e.target.value)}
                placeholder="webhook / daemon / im"
                disabled={submitting}
              />
            </label>
          </div>
          <label className="dsh-fleet-field">
            <span>初始摘要 (summary)</span>
            <input
              type="text"
              className="dsh-fleet-input"
              value={botSummary}
              onChange={(e) => setBotSummary(e.target.value)}
              placeholder="例如：监听部署告警并等待指令"
              disabled={submitting}
            />
          </label>
          {formError && (
            <div className="dsh-fleet-bot-error" role="alert">{formError}</div>
          )}
          <div className="dsh-fleet-bot-form-foot">
            <span style={{ fontSize: 11, color: 'var(--fleet-text-3)' }}>
              提交后立即注册为 bot:&lt;id&gt; 面板并出现在名册中
            </span>
            <button
              type="submit"
              className="dsh-fleet-btn dsh-fleet-btn--primary dsh-fleet-btn--sm"
              disabled={submitting || !botId.trim()}
            >
              {submitting ? '接入中…' : '立即接入测试'}
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}

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
  const [policyUpdating, setPolicyUpdating] = useState(false)
  const [botDrawerOpen, setBotDrawerOpen] = useState(false)
  const [spawnDrawerOpen, setSpawnDrawerOpen] = useState(false)
  const [toast, setToast] = useState(null) // { kind: 'success' | 'error' | 'info', text, targetPaneId?, targetLabel? }

  const searchInputRef = useRef(null)
  const lastFetchedRef = useRef({ paneId: null, revision: null, cursorEnd: null })
  const toastTimerRef = useRef(null)

  const showToast = useCallback((nextToast, durationMs = 5000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(nextToast)
    if (durationMs > 0) {
      toastTimerRef.current = setTimeout(() => {
        setToast(null)
        toastTimerRef.current = null
      }, durationMs)
    }
  }, [])

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
  }, [])

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

  // Keyboard navigation (j/k, ↑/↓, / to search, Escape to close drawers) when focus is not in an editable field.
  useEffect(() => {
    function onKeyDown(e) {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        if (botDrawerOpen || spawnDrawerOpen) {
          e.preventDefault()
          setBotDrawerOpen(false)
          setSpawnDrawerOpen(false)
        }
        return
      }
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
  }, [orderedPanes, selectedId, botDrawerOpen, spawnDrawerOpen])

  const handleAct = useCallback((req) => transport.act(req), [transport])

  const handleSetPolicy = useCallback(async (nextPolicy) => {
    if (typeof transport.setPolicy !== 'function') return
    setPolicyUpdating(true)
    try {
      const res = await transport.setPolicy(nextPolicy)
      if (res?.ok) {
        const label = POLICY_LABEL_MAP[nextPolicy] ?? nextPolicy
        showToast({ kind: 'success', text: `安全锁已切换为：${label}` })
      } else {
        showToast({
          kind: 'error',
          text: res?.message || `切换写策略失败：${res?.reason ?? 'unknown'}`,
        })
      }
      return res
    } finally {
      setPolicyUpdating(false)
    }
  }, [transport, showToast])

  const handleAgentHandoff = useCallback(async (targetPaneId, text) => {
    const targetPane = (state?.panes ?? []).find((p) => p.id === targetPaneId)
    const targetLabel = targetPane?.agent?.name
      ? `@${targetPane.agent.name}`
      : (targetPane?.title || targetPaneId)
    const res = await transport.act({ verb: 'prompt', pane: targetPaneId, text })
    if (res?.ok) {
      showToast({
        kind: 'success',
        text: `已将交接上下文发送给 ${targetLabel}`,
        targetPaneId,
        targetLabel,
      }, 7000)
    } else {
      showToast({
        kind: 'error',
        text: res?.message || `交接发送失败：${res?.reason ?? 'unknown'}`,
      })
    }
    return res
  }, [transport, state?.panes, showToast])

  const handleRegisterBot = useCallback(async (bot) => {
    if (typeof transport.registerBot !== 'function') {
      return { ok: false, reason: 'unsupported', message: '当前传输层不支持注册外部 Bot' }
    }
    const res = await transport.registerBot(bot)
    if (res?.ok) {
      const paneId = res.pane?.id || res.bot?.id || `bot:${bot.id}`
      setSelectedId(paneId)
      showToast({
        kind: 'success',
        text: `已接入外部 Bot：${paneId}`,
        targetPaneId: paneId,
        targetLabel: paneId,
      })
    } else {
      showToast({
        kind: 'error',
        text: res?.message || `接入 Bot 失败：${res?.reason ?? 'unknown'}`,
      })
    }
    return res
  }, [transport, showToast])

  const handleSpawn = useCallback(async (spec) => {
    if (typeof transport.spawn !== 'function') {
      return { ok: false, reason: 'unsupported', message: '当前传输层不支持派发 Agent' }
    }
    const res = await transport.spawn(spec)
    if (res?.ok) {
      const paneId = typeof res.pane === 'string' ? res.pane : res.pane?.id
      const label = res.name ? `@${res.name}` : (paneId || spec.kind)
      if (paneId) setSelectedId(paneId)
      showToast({
        kind: 'success',
        text: `已派发 ${res.kind || spec.kind} Agent：${label}${res.worktree ? ` · worktree ${res.worktree}` : ''}`,
        targetPaneId: paneId || undefined,
        targetLabel: label,
      })
    } else {
      showToast({
        kind: 'error',
        text: res?.message || `派发 Agent 失败：${res?.reason ?? 'unknown'}`,
      })
    }
    return res
  }, [transport, showToast])

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

      {/* Toast Feedback */}
      {toast && (
        <div className={`dsh-fleet-toast dsh-fleet-toast--${toast.kind}`} role="status">
          <span>{toast.text}</span>
          <div className="dsh-fleet-toast-actions">
            {toast.targetPaneId && (
              <button
                type="button"
                className="dsh-fleet-btn dsh-fleet-btn--sm dsh-fleet-btn--primary"
                onClick={() => {
                  setSelectedId(toast.targetPaneId)
                  setToast(null)
                }}
              >
                跳到 {toast.targetLabel || toast.targetPaneId}
              </button>
            )}
            <button
              type="button"
              className="dsh-fleet-btn dsh-fleet-btn--sm"
              onClick={() => setToast(null)}
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {/* Inline Spawn Agent Drawer */}
      {spawnDrawerOpen && (
        <SpawnAgentDrawer
          defaultCwd={selectedPane?.cwd || '~/workspace'}
          onClose={() => setSpawnDrawerOpen(false)}
          onSpawn={handleSpawn}
        />
      )}

      {/* Inline External Bot Connect Drawer */}
      {botDrawerOpen && (
        <BotConnectDrawer
          baseUrl={transport.baseUrl}
          onClose={() => setBotDrawerOpen(false)}
          onRegister={handleRegisterBot}
        />
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
          <span>herdr 已连接，当前仅有 {counts?.shells ?? 0} 个普通终端面板。启动任意 Agent 或接入外部 Bot 后会自动出现在这里。</span>
          <div className="dsh-fleet-handoff-actions">
            <button
              type="button"
              className="dsh-fleet-btn dsh-fleet-btn--primary"
              onClick={() => {
                setBotDrawerOpen(false)
                setSpawnDrawerOpen(true)
              }}
            >
              + 派活 (Spawn Agent)
            </button>
            <button
              type="button"
              className="dsh-fleet-btn"
              onClick={() => {
                setSpawnDrawerOpen(false)
                setBotDrawerOpen(true)
              }}
            >
              + 接入外部 Agent Bot
            </button>
          </div>
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
            onSetPolicy={handleSetPolicy}
            policyUpdating={policyUpdating}
            onOpenSpawnDrawer={() => {
              setBotDrawerOpen(false)
              setSpawnDrawerOpen((v) => !v)
            }}
            onOpenBotDrawer={() => {
              setSpawnDrawerOpen(false)
              setBotDrawerOpen((v) => !v)
            }}
          />
          <Stage
            pane={selectedPane}
            panes={state?.panes ?? []}
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
            onHandoff={handleAgentHandoff}
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

      {/* Compact bottom keyboard hint strip */}
      <footer className="dsh-fleet-hintbar dsh-fleet-num" aria-label="快捷键提示">
        <span>j/k 切换 · ⌘⌥A 跳待处理 · Esc 关闭抽屉</span>
      </footer>
    </div>
  )
}
