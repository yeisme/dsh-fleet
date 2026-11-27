/**
 * Collapsible right inspector showing cwd, workspace/tab, agent metadata,
 * inline rename (for writable agents), and full checks gate steps + failure excerpt.
 */
import { useEffect, useState } from 'react'
import { formatElapsed } from '../../lib/fleet/attention.js'

const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

const GATE_LABELS = {
  none: '未配置',
  running: '运行中',
  passed: '通过',
  failed: '失败',
  stale: '已过期（代码已变更）',
}

const STEP_ICONS = {
  passed: '✓',
  failed: '✕',
  skipped: '–',
}

export function Inspector({ pane, now, onAct, onClose }) {
  const [nameInput, setNameInput] = useState(pane?.agent?.name ?? '')
  const [renaming, setRenaming] = useState(false)
  const [renameMsg, setRenameMsg] = useState('')

  useEffect(() => {
    setNameInput(pane?.agent?.name ?? '')
    setRenameMsg('')
  }, [pane?.id, pane?.agent?.name])

  if (!pane) return null

  const checks = pane.checks ?? {
    gate: 'none',
    startedAt: null,
    durationMs: null,
    baseRevision: null,
    headRevision: null,
    steps: [],
    failure: null,
  }

  async function handleRename(e) {
    e.preventDefault()
    const next = nameInput.trim()
    if (!AGENT_NAME_RE.test(next)) {
      setRenameMsg('名称需匹配 ^[a-z][a-z0-9_-]{0,31}$')
      return
    }
    setRenaming(true)
    setRenameMsg('')
    try {
      const res = await onAct({ verb: 'rename', pane: pane.id, name: next })
      if (res?.ok) setRenameMsg('已更新名称')
      else setRenameMsg(res?.message || res?.reason || '重命名失败')
    } finally {
      setRenaming(false)
    }
  }

  return (
    <aside className="dsh-fleet-inspector" aria-label="面板详情">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="dsh-fleet-section-title">详情 · {pane.id}</span>
        {onClose && (
          <button type="button" className="dsh-fleet-btn dsh-fleet-btn--sm" onClick={onClose}>
            收起
          </button>
        )}
      </div>

      <section className="dsh-fleet-section">
        <div className="dsh-fleet-section-title">位置与状态</div>
        <div className="dsh-fleet-kv">
          <span className="dsh-fleet-kv-k">工作区</span>
          <span className="dsh-fleet-kv-v">{pane.workspaceLabel} / {pane.tabLabel}</span>
          <span className="dsh-fleet-kv-k">目录</span>
          <span className="dsh-fleet-kv-v" style={{ fontFamily: 'var(--fleet-mono)', fontSize: 11 }}>{pane.cwd}</span>
          <span className="dsh-fleet-kv-k">状态</span>
          <span className="dsh-fleet-kv-v">{pane.status}{pane.stalled ? '（停滞）' : ''}</span>
          <span className="dsh-fleet-kv-k">持续时长</span>
          <span className="dsh-fleet-kv-v dsh-fleet-num">{formatElapsed(now - pane.stateSince)}</span>
          <span className="dsh-fleet-kv-k">最近输出</span>
          <span className="dsh-fleet-kv-v dsh-fleet-num">
            {pane.outputAt !== null ? `${formatElapsed(now - pane.outputAt)} 前` : '—'}
          </span>
          <span className="dsh-fleet-kv-k">Revision</span>
          <span className="dsh-fleet-kv-v dsh-fleet-num">#{pane.revision}</span>
          <span className="dsh-fleet-kv-k">写权限</span>
          <span className="dsh-fleet-kv-v">{pane.writable ? '可写' : `只读 (${pane.writableReason ?? 'unknown'})`}</span>
        </div>
      </section>

      {pane.agent && (
        <section className="dsh-fleet-section">
          <div className="dsh-fleet-section-title">Agent 元数据</div>
          <div className="dsh-fleet-kv">
            <span className="dsh-fleet-kv-k">类型</span>
            <span className="dsh-fleet-kv-v">{pane.agent.kind}</span>
            <span className="dsh-fleet-kv-k">展示名</span>
            <span className="dsh-fleet-kv-v">{pane.agent.display}</span>
            <span className="dsh-fleet-kv-k">交互就绪</span>
            <span className="dsh-fleet-kv-v">
              {pane.agent.interactiveReady === null ? '未知' : (pane.agent.interactiveReady ? '是' : '否')}
            </span>
            {pane.agent.session && (
              <>
                <span className="dsh-fleet-kv-k">会话来源</span>
                <span className="dsh-fleet-kv-v">{pane.agent.session.source} ({pane.agent.session.kind})</span>
              </>
            )}
          </div>

          {pane.writable && (
            <form onSubmit={handleRename} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
              <label className="dsh-fleet-section-title" htmlFor={`fleet-rename-${pane.id}`}>
                重命名 Agent
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  id={`fleet-rename-${pane.id}`}
                  type="text"
                  className="dsh-fleet-approval-input"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="my-agent-name"
                  disabled={renaming}
                />
                <button type="submit" className="dsh-fleet-btn dsh-fleet-btn--sm" disabled={renaming}>
                  保存
                </button>
              </div>
              {renameMsg && (
                <span style={{ fontSize: 11, color: 'var(--fleet-text-2)' }}>{renameMsg}</span>
              )}
            </form>
          )}
        </section>
      )}

      <section className="dsh-fleet-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="dsh-fleet-section-title">门禁 Checks</span>
          <span className={`dsh-fleet-pill ${checks.gate !== 'none' ? `dsh-fleet-pill--${checks.gate}` : ''}`}>
            {GATE_LABELS[checks.gate] ?? checks.gate}
          </span>
        </div>

        {(checks.baseRevision || checks.headRevision || checks.durationMs !== null) && (
          <div className="dsh-fleet-kv">
            {checks.baseRevision && (
              <>
                <span className="dsh-fleet-kv-k">Base</span>
                <span className="dsh-fleet-kv-v" style={{ fontFamily: 'var(--fleet-mono)', fontSize: 11 }}>{checks.baseRevision}</span>
              </>
            )}
            {checks.headRevision && (
              <>
                <span className="dsh-fleet-kv-k">Head</span>
                <span className="dsh-fleet-kv-v" style={{ fontFamily: 'var(--fleet-mono)', fontSize: 11 }}>{checks.headRevision}</span>
              </>
            )}
            {checks.durationMs !== null && (
              <>
                <span className="dsh-fleet-kv-k">耗时</span>
                <span className="dsh-fleet-kv-v dsh-fleet-num">{formatElapsed(checks.durationMs)}</span>
              </>
            )}
          </div>
        )}

        {checks.steps.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {checks.steps.map((step, i) => (
              <div className="dsh-fleet-check-step" key={`${step.name}-${i}`}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <strong>{STEP_ICONS[step.status] ?? '·'} {step.name}</strong>
                  <span className="dsh-fleet-row-time dsh-fleet-num">{step.durationMs} ms</span>
                </div>
                {step.summary && (
                  <span style={{ fontSize: 11, color: 'var(--fleet-text-2)' }}>{step.summary}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--fleet-text-3)' }}>暂无门禁步骤记录</span>
        )}

        {checks.failure && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--fleet-c-error)', fontWeight: 560 }}>
              失败步骤：{checks.failure.step} — {checks.failure.reason}
            </div>
            {checks.failure.excerpt && (
              <pre className="dsh-fleet-check-excerpt">{checks.failure.excerpt}</pre>
            )}
          </div>
        )}
      </section>
    </aside>
  )
}
