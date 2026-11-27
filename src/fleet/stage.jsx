/**
 * Center Stage of the Fleet Control Room:
 *  - Transcript / Live Screen / Checks tabs
 *  - All 5 contract frame kinds (session, text, collapsible reasoning, work rows, final) + Load earlier
 *  - Live Screen ANSI SGR renderer + whitelisted plus-chord key bar
 *  - Blocked Approval Fast-Path with expectRevision (refreshes & warns on 409 screen-changed, NEVER auto-retries)
 *  - Writable prompt bar when writable && status !== 'blocked'; ZERO textarea/input when read-only/offline
 *  - Confirm-guarded restart / close, interrupt, and Handoff bar
 */
import { useEffect, useMemo, useState } from 'react'
import { formatElapsed } from '../../lib/fleet/attention.js'
import { parseAnsi, spanToReactStyle, stripAnsi } from './ansi.js'
import { dotClassFor, statusLabelFor } from './roster.jsx'

const WRITABLE_REASON_TEXT = {
  'not-an-agent': '该面板为普通终端（非 Agent），仅支持只读查看',
  'policy-read-only': '当前写策略为只读（read-only），面板不提供输入框',
  'policy-dsh-only': '当前写策略仅允许写入 DSH 创建的 Agent，该外部会话只读',
  offline: 'herdr 已断开，当前处于只读离线状态',
}

const FRAME_REASON_TEXT = {
  'no-transcript': '未找到该 Agent 的会话记录文件',
  'not-yet': 'Agent 刚启动，暂未产生对话记录',
  'unsupported-agent': '当前 Agent 类型暂不支持对话记录解析',
  unreadable: '会话记录文件无法读取或解析失败',
}

const APPROVAL_KEYS = [
  { key: '1', label: '1' },
  { key: '2', label: '2' },
  { key: '3', label: '3' },
  { key: 'y', label: 'y' },
  { key: 'n', label: 'n' },
  { key: 'enter', label: '↵ Enter' },
  { key: 'esc', label: 'Esc' },
]

// Whitelisted plus-separated key chords (HARD RULE 3: always '+' never hyphen).
const SCREEN_KEYBAR = [
  { key: 'enter', label: '↵' },
  { key: 'esc', label: 'Esc' },
  { key: 'tab', label: 'Tab' },
  { key: 'shift+tab', label: '⇧Tab' },
  { key: 'up', label: '↑' },
  { key: 'down', label: '↓' },
  { key: 'left', label: '←' },
  { key: 'right', label: '→' },
  { key: 'space', label: 'Space' },
  { key: 'backspace', label: '⌫' },
  { key: 'ctrl+c', label: 'Ctrl+C' },
  { key: 'ctrl+d', label: 'Ctrl+D' },
  { key: 'y', label: 'y' },
  { key: 'n', label: 'n' },
  { key: '1', label: '1' },
  { key: '2', label: '2' },
  { key: '3', label: '3' },
  { key: '4', label: '4' },
]

/* --------------------------------------------------------- Lightweight safe Markdown renderer */

function renderInline(text) {
  const tokens = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g
  let last = 0
  let m
  let k = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push(text.slice(last, m.index))
    const seg = m[0]
    if (seg.startsWith('`')) {
      tokens.push(<code key={k++}>{seg.slice(1, -1)}</code>)
    } else if (seg.startsWith('**')) {
      tokens.push(<strong key={k++}>{seg.slice(2, -2)}</strong>)
    } else if (seg.startsWith('[')) {
      const split = seg.indexOf('](')
      const label = seg.slice(1, split)
      const href = seg.slice(split + 2, -1)
      tokens.push(
        <a key={k++} href={href} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      )
    }
    last = re.lastIndex
  }
  if (last < text.length) tokens.push(text.slice(last))
  return tokens
}

function MarkdownBlock({ text }) {
  const blocks = useMemo(() => {
    const lines = String(text ?? '').split('\n')
    const out = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (line.startsWith('```')) {
        const lang = line.slice(3).trim()
        const codeLines = []
        i += 1
        while (i < lines.length && !lines[i].startsWith('```')) {
          codeLines.push(lines[i])
          i += 1
        }
        i += 1
        out.push({ type: 'code', lang, content: codeLines.join('\n') })
        continue
      }
      if (/^#{1,3}\s+/.test(line)) {
        const level = line.match(/^#+/)[0].length
        out.push({ type: 'heading', level, content: line.replace(/^#{1,3}\s+/, '') })
        i += 1
        continue
      }
      if (line.startsWith('> ')) {
        const quoteLines = []
        while (i < lines.length && lines[i].startsWith('> ')) {
          quoteLines.push(lines[i].slice(2))
          i += 1
        }
        out.push({ type: 'quote', content: quoteLines.join('\n') })
        continue
      }
      if (line.includes('|') && i + 1 < lines.length && /^\|?[\s:-]+\|/.test(lines[i + 1])) {
        const splitRow = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
        const header = splitRow(line)
        i += 2
        const rows = []
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          rows.push(splitRow(lines[i]))
          i += 1
        }
        out.push({ type: 'table', header, rows })
        continue
      }
      if (/^[-*]\s+/.test(line)) {
        const items = []
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^[-*]\s+/, ''))
          i += 1
        }
        out.push({ type: 'ul', items })
        continue
      }
      if (/^\d+\.\s+/.test(line)) {
        const items = []
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\d+\.\s+/, ''))
          i += 1
        }
        out.push({ type: 'ol', items })
        continue
      }
      if (line.trim() === '') {
        i += 1
        continue
      }
      const para = []
      while (
        i < lines.length
        && lines[i].trim() !== ''
        && !lines[i].startsWith('```')
        && !/^#{1,3}\s+/.test(lines[i])
        && !lines[i].startsWith('> ')
        && !/^[-*]\s+/.test(lines[i])
        && !/^\d+\.\s+/.test(lines[i])
      ) {
        para.push(lines[i])
        i += 1
      }
      out.push({ type: 'p', content: para.join('\n') })
    }
    return out
  }, [text])

  return (
    <div className="dsh-fleet-md">
      {blocks.map((b, idx) => {
        if (b.type === 'code') {
          return (
            <pre key={idx} data-lang={b.lang || undefined}>
              <code>{b.content}</code>
            </pre>
          )
        }
        if (b.type === 'heading') {
          const Tag = b.level === 1 ? 'h1' : (b.level === 2 ? 'h2' : 'h3')
          return <Tag key={idx}>{renderInline(b.content)}</Tag>
        }
        if (b.type === 'quote') {
          return <blockquote key={idx}>{renderInline(b.content)}</blockquote>
        }
        if (b.type === 'table') {
          return (
            <table key={idx}>
              <thead>
                <tr>
                  {b.header.map((h, hi) => <th key={hi}>{renderInline(h)}</th>)}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, ci) => <td key={ci}>{renderInline(c)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
        if (b.type === 'ul') {
          return (
            <ul key={idx}>
              {b.items.map((item, ii) => <li key={ii}>{renderInline(item)}</li>)}
            </ul>
          )
        }
        if (b.type === 'ol') {
          return (
            <ol key={idx}>
              {b.items.map((item, ii) => <li key={ii}>{renderInline(item)}</li>)}
            </ol>
          )
        }
        return <p key={idx}>{renderInline(b.content)}</p>
      })}
    </div>
  )
}

/* ------------------------------------------------------------------- Frame rendering */

function FrameItem({ frame, now }) {
  if (frame.kind === 'session') {
    return (
      <div className="dsh-fleet-frame-session">
        <span>session {frame.sessionId}</span>
        <span>·</span>
        <span>{frame.cwd}</span>
      </div>
    )
  }
  if (frame.kind === 'text') {
    const isUser = frame.role === 'user'
    return (
      <article className={`dsh-fleet-frame-text ${isUser ? 'dsh-fleet-frame-text--user' : ''}`}>
        <div className="dsh-fleet-frame-role">
          <span>{isUser ? '你' : (frame.role === 'system' ? '系统' : 'Agent')}</span>
          {typeof frame.at === 'number' && (
            <span className="dsh-fleet-num">{formatElapsed(now - frame.at)} 前</span>
          )}
        </div>
        <MarkdownBlock text={frame.text} />
      </article>
    )
  }
  if (frame.kind === 'reasoning') {
    return (
      <details className="dsh-fleet-frame-reasoning">
        <summary>思考过程</summary>
        <div style={{ marginTop: 6 }}>
          <MarkdownBlock text={frame.text} />
        </div>
      </details>
    )
  }
  if (frame.kind === 'work') {
    return (
      <div className="dsh-fleet-frame-work">
        <div className="dsh-fleet-work-head">
          <span>{frame.summary || '工具执行'}</span>
          {typeof frame.tokens === 'number' && (
            <span className="dsh-fleet-row-time dsh-fleet-num">{frame.tokens.toLocaleString()} tok</span>
          )}
        </div>
        {frame.rows.map((row, idx) => (
          <div className="dsh-fleet-work-row" key={idx}>
            <span className="dsh-fleet-work-verb">{row.verb}</span>
            <span className="dsh-fleet-work-obj" title={row.object}>{row.object}</span>
            <span style={{
              fontSize: 11,
              color: row.outcome === 'ok'
                ? 'var(--fleet-c-success)'
                : row.outcome === 'error'
                  ? 'var(--fleet-c-error)'
                  : 'var(--fleet-c-working)',
            }}>
              {row.outcome === 'ok' ? 'ok' : (row.outcome === 'error' ? 'error' : '运行中…')}
            </span>
            <span className="dsh-fleet-row-time dsh-fleet-num" style={{ textAlign: 'right' }}>
              {typeof row.ms === 'number' ? `${row.ms}ms` : '—'}
            </span>
          </div>
        ))}
      </div>
    )
  }
  if (frame.kind === 'final') {
    return (
      <div className="dsh-fleet-frame-final">
        <div className="dsh-fleet-frame-role" style={{ marginBottom: 4 }}>
          <span style={{ color: 'var(--fleet-c-success)' }}>回合完成 · {frame.reason}</span>
          {typeof frame.ms === 'number' && (
            <span className="dsh-fleet-num">{formatElapsed(frame.ms)}</span>
          )}
        </div>
        <MarkdownBlock text={frame.text} />
      </div>
    )
  }
  return null
}

/* ------------------------------------------------------------------- ANSI Screen view */

function AnsiScreen({ text }) {
  const lines = useMemo(() => parseAnsi(text), [text])
  return (
    <pre className="dsh-fleet-screen-pre">
      {lines.map((spans, li) => (
        <div key={li}>
          {spans.length === 0 ? '\u00a0' : spans.map((span, si) => (
            <span key={si} style={spanToReactStyle(span.style)}>{span.text}</span>
          ))}
        </div>
      ))}
    </pre>
  )
}

/* ------------------------------------------------------------------- Handoff context formatter */

export function formatHandoffContext(pane, frames) {
  const recent = (frames ?? [])
    .filter((f) => f.kind === 'text' || f.kind === 'final')
    .slice(-20)
  const lines = [
    `<外部会话上下文 pane="${pane.id}" agent="${pane.agent?.kind ?? 'shell'}" cwd="${pane.cwd}">`,
  ]
  for (const f of recent) {
    const role = f.kind === 'final' ? 'assistant' : f.role
    lines.push(`[${role}] ${f.text}`)
  }
  lines.push('</外部会话上下文>')
  const joined = lines.join('\n')
  return joined.length > 8000 ? `${joined.slice(0, 7960)}\n…（已按 8k 字符上限截断）\n</外部会话上下文>` : joined
}

/* ------------------------------------------------------------------- Stage component */

export function Stage({
  pane,
  now,
  seen,
  activeTab,
  onTabChange,
  framesData,
  framesLoading,
  onLoadEarlier,
  screenData,
  screenLoading,
  onRefreshScreen,
  onAct,
  onHandoffContinue,
  inspectorOpen,
  onToggleInspector,
}) {
  const [promptText, setPromptText] = useState('')
  const [answerText, setAnswerText] = useState('')
  const [answerEnter, setAnswerEnter] = useState(true)
  const [sending, setSending] = useState(false)
  const [actionNotice, setActionNotice] = useState(null) // { kind: 'warn' | 'error' | 'info', text }
  const [pendingConfirm, setPendingConfirm] = useState(null) // 'restart' | 'close' | null
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setActionNotice(null)
    setPendingConfirm(null)
    setCopied(false)
  }, [pane?.id])

  if (!pane) {
    return (
      <main className="dsh-fleet-stage">
        <div className="dsh-fleet-empty">
          <strong>未选择面板</strong>
          <span>从左侧名册选择一个 Agent，或按 ⌘⌥A 跳到下一个需要你处理的面板。</span>
        </div>
      </main>
    )
  }

  const label = statusLabelFor(pane, now, seen)
  const checks = pane.checks ?? { gate: 'none', steps: [], failure: null, durationMs: null, baseRevision: null, headRevision: null }

  async function dispatchAct(req) {
    setSending(true)
    setActionNotice(null)
    try {
      const res = await onAct(req)
      if (!res?.ok) {
        if (res?.reason === 'screen-changed') {
          // NEVER auto-retry on screen-changed: refresh screen and warn user to re-verify!
          await onRefreshScreen()
          setActionNotice({
            kind: 'warn',
            text: `屏幕内容已变化（当前版本 #${res.detail?.revision ?? '?'}），已刷新最新画面，请确认后再重新操作（不会自动重试）。`,
          })
        } else {
          setActionNotice({
            kind: 'error',
            text: res?.message || `操作被拒绝：${res?.reason ?? 'unknown'}`,
          })
        }
      }
      return res
    } finally {
      setSending(false)
    }
  }

  async function handleSendPrompt(e) {
    e?.preventDefault()
    const text = promptText.trim()
    if (!text || sending) return
    const res = await dispatchAct({ verb: 'prompt', pane: pane.id, text })
    if (res?.ok) setPromptText('')
  }

  async function handleSendAnswer(e) {
    e?.preventDefault()
    const text = answerText.trim()
    if (!text || sending || typeof screenData?.revision !== 'number') return
    const res = await dispatchAct({
      verb: 'answer',
      pane: pane.id,
      text,
      enter: answerEnter,
      expectRevision: screenData.revision,
    })
    if (res?.ok) setAnswerText('')
  }

  async function handleSendKey(key) {
    if (sending || typeof screenData?.revision !== 'number') return
    await dispatchAct({
      verb: 'keys',
      pane: pane.id,
      keys: [key],
      expectRevision: screenData.revision,
    })
  }

  async function handleConfirmedDanger(verb) {
    setPendingConfirm(null)
    await dispatchAct({ verb, pane: pane.id, confirm: true })
  }

  async function handleCopyContext() {
    const text = formatHandoffContext(pane, framesData?.frames ?? [])
    try {
      await globalThis.navigator?.clipboard?.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setActionNotice({ kind: 'info', text: '无法访问剪贴板，请手动复制上下文。' })
    }
  }

  const approvalExcerpt = useMemo(() => {
    if (!screenData?.text) return pane.summary || '等待读取最新屏幕…'
    const plain = stripAnsi(screenData.text).trim()
    const lines = plain.split('\n').filter((l) => l.trim() !== '')
    return lines.slice(-10).join('\n') || pane.summary
  }, [screenData?.text, pane.summary])

  return (
    <main className="dsh-fleet-stage" data-pane-readonly={!pane.writable ? '' : undefined}>
      {/* Header */}
      <header className="dsh-fleet-stage-header">
        <div className="dsh-fleet-stage-title-wrap">
          <div className="dsh-fleet-stage-title">
            <span className={dotClassFor(pane, now)} title={label} />
            <span className="dsh-fleet-stage-title-text" title={pane.title}>{pane.title || pane.id}</span>
            <span className="dsh-fleet-pill">{label}</span>
            <span className="dsh-fleet-row-time dsh-fleet-num">{formatElapsed(now - pane.stateSince)}</span>
          </div>
          <div className="dsh-fleet-stage-sub">
            {pane.workspaceLabel} / {pane.tabLabel} · {pane.cwd}
          </div>
        </div>

        <div className="dsh-fleet-stage-actions">
          {pane.writable && (pane.status === 'working' || pane.status === 'blocked') && (
            <button
              type="button"
              className="dsh-fleet-btn dsh-fleet-btn--sm"
              disabled={sending}
              onClick={() => dispatchAct({ verb: 'interrupt', pane: pane.id })}
            >
              中断
            </button>
          )}
          {pane.writable && (
            <>
              <button
                type="button"
                className="dsh-fleet-btn dsh-fleet-btn--sm"
                disabled={sending}
                onClick={() => setPendingConfirm('restart')}
              >
                重启
              </button>
              <button
                type="button"
                className="dsh-fleet-btn dsh-fleet-btn--sm dsh-fleet-btn--danger"
                disabled={sending}
                onClick={() => setPendingConfirm('close')}
              >
                关闭
              </button>
            </>
          )}
          <button
            type="button"
            className={`dsh-fleet-btn dsh-fleet-btn--sm ${inspectorOpen ? 'dsh-fleet-btn--active' : ''}`}
            onClick={onToggleInspector}
          >
            详情
          </button>
        </div>
      </header>

      {/* Confirm Guard Bar for restart / close */}
      {pendingConfirm && (
        <div className="dsh-fleet-confirm-bar" role="alertdialog" aria-label="确认危险操作">
          <span>
            {pendingConfirm === 'restart'
              ? `确认重新拉起 ${pane.title || pane.id}？（若进程仍在运行，请先中断）`
              : `确认关闭面板 ${pane.title || pane.id}？此操作不可撤销。`}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="dsh-fleet-btn dsh-fleet-btn--sm"
              onClick={() => setPendingConfirm(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="dsh-fleet-btn dsh-fleet-btn--sm dsh-fleet-btn--danger"
              disabled={sending}
              onClick={() => handleConfirmedDanger(pendingConfirm)}
            >
              确认{pendingConfirm === 'restart' ? '重启' : '关闭'}
            </button>
          </div>
        </div>
      )}

      {/* Action Warning / Error Notice */}
      {actionNotice && (
        <div
          className={`dsh-fleet-banner dsh-fleet-banner--${actionNotice.kind}`}
          role="alert"
        >
          <span>{actionNotice.text}</span>
          <button
            type="button"
            className="dsh-fleet-btn dsh-fleet-btn--sm"
            onClick={() => setActionNotice(null)}
          >
            知道了
          </button>
        </div>
      )}

      {/* Tabs */}
      <nav className="dsh-fleet-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'transcript'}
          className={`dsh-fleet-tab ${activeTab === 'transcript' ? 'dsh-fleet-tab--active' : ''}`}
          onClick={() => onTabChange('transcript')}
        >
          对话
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'screen'}
          className={`dsh-fleet-tab ${activeTab === 'screen' ? 'dsh-fleet-tab--active' : ''}`}
          onClick={() => onTabChange('screen')}
        >
          实时屏幕
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'checks'}
          className={`dsh-fleet-tab ${activeTab === 'checks' ? 'dsh-fleet-tab--active' : ''}`}
          onClick={() => onTabChange('checks')}
        >
          门禁
          {checks.gate !== 'none' && (
            <span className={`dsh-fleet-pill dsh-fleet-pill--${checks.gate}`}>{checks.gate}</span>
          )}
        </button>
      </nav>

      {/* Blocked Approval Fast-Path Banner */}
      {pane.status === 'blocked' && (
        <section className="dsh-fleet-approval" aria-label="审批快速通道">
          <div className="dsh-fleet-approval-head">
            <span>⚠️ 等待你的审批或回答</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {typeof screenData?.revision === 'number' && (
                <span className="dsh-fleet-row-time dsh-fleet-num">rev #{screenData.revision}</span>
              )}
              <button
                type="button"
                className="dsh-fleet-btn dsh-fleet-btn--sm"
                onClick={onRefreshScreen}
                disabled={screenLoading}
              >
                刷新屏幕
              </button>
            </div>
          </div>
          <pre className="dsh-fleet-approval-screen">{approvalExcerpt}</pre>
          {pane.writable ? (
            <>
              <div className="dsh-fleet-approval-keys">
                {APPROVAL_KEYS.map(({ key, label: btnLabel }) => (
                  <button
                    key={key}
                    type="button"
                    className="dsh-fleet-btn dsh-fleet-btn--sm"
                    disabled={sending || typeof screenData?.revision !== 'number'}
                    onClick={() => handleSendKey(key)}
                  >
                    {btnLabel}
                  </button>
                ))}
              </div>
              <form className="dsh-fleet-approval-form" onSubmit={handleSendAnswer}>
                <input
                  type="text"
                  className="dsh-fleet-approval-input"
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                  placeholder="输入自由文本回答（绑定当前屏幕 revision）…"
                  disabled={sending || typeof screenData?.revision !== 'number'}
                />
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--fleet-text-2)' }}>
                  <input
                    type="checkbox"
                    checked={answerEnter}
                    onChange={(e) => setAnswerEnter(e.target.checked)}
                  />
                  回车
                </label>
                <button
                  type="submit"
                  className="dsh-fleet-btn dsh-fleet-btn--primary dsh-fleet-btn--sm"
                  disabled={sending || !answerText.trim() || typeof screenData?.revision !== 'number'}
                >
                  回复
                </button>
              </form>
            </>
          ) : (
            <div className="dsh-fleet-readonly-notice">
              <span>{WRITABLE_REASON_TEXT[pane.writableReason] ?? '当前面板只读'}</span>
            </div>
          )}
        </section>
      )}

      {/* Tab Content */}
      <div className="dsh-fleet-stage-scroll">
        {activeTab === 'transcript' && (
          <>
            {framesData?.hasEarlier && (
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <button
                  type="button"
                  className="dsh-fleet-btn dsh-fleet-btn--sm"
                  disabled={framesLoading}
                  onClick={() => onLoadEarlier(framesData.cursor?.start)}
                >
                  {framesLoading ? '加载中…' : '加载更早记录'}
                </button>
              </div>
            )}

            {framesData?.partial && (
              <div className="dsh-fleet-readonly-notice">
                <span>会话文件较大，仅展示尾部窗口。</span>
              </div>
            )}

            {framesData && framesData.source !== 'transcript' ? (
              <div className="dsh-fleet-empty">
                <strong>{FRAME_REASON_TEXT[framesData.reason] ?? '暂无结构化对话记录'}</strong>
                <span>source: {framesData.source} · reason: {framesData.reason ?? 'none'}</span>
                {framesData.source === 'screen' && (
                  <button
                    type="button"
                    className="dsh-fleet-btn dsh-fleet-btn--primary"
                    onClick={() => onTabChange('screen')}
                  >
                    切换到实时屏幕
                  </button>
                )}
              </div>
            ) : (
              <>
                {(framesData?.frames ?? []).map((frame) => (
                  <FrameItem key={frame.id} frame={frame} now={now} />
                ))}
                {!framesLoading && (framesData?.frames?.length ?? 0) === 0 && (
                  <div className="dsh-fleet-empty">
                    <span>暂无对话帧</span>
                  </div>
                )}
              </>
            )}

            {(framesData?.unknownFrames ?? 0) > 0 && (
              <div style={{ fontSize: 11, color: 'var(--fleet-text-3)', textAlign: 'center' }} className="dsh-fleet-num">
                已跳过 {framesData.unknownFrames} 条未识别条目
              </div>
            )}
          </>
        )}

        {activeTab === 'screen' && (
          <div className="dsh-fleet-screen-wrap">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--fleet-text-3)' }}>
              <span className="dsh-fleet-num">
                {screenData?.ok
                  ? `rev #${screenData.revision} · ${screenData.cols ?? '?'}×${screenData.rows ?? '?'}`
                  : (screenData?.message || '等待读取屏幕…')}
              </span>
              <button
                type="button"
                className="dsh-fleet-btn dsh-fleet-btn--sm"
                onClick={onRefreshScreen}
                disabled={screenLoading}
              >
                {screenLoading ? '刷新中…' : '刷新屏幕'}
              </button>
            </div>

            {screenData?.ok ? (
              <AnsiScreen text={screenData.text} />
            ) : (
              <div className="dsh-fleet-empty">
                <span>{screenData?.message || '无法读取实时屏幕'}</span>
              </div>
            )}

            {pane.writable && (
              <div className="dsh-fleet-keybar" aria-label="终端按键条">
                {SCREEN_KEYBAR.map(({ key, label: btnLabel }) => (
                  <button
                    key={key}
                    type="button"
                    className="dsh-fleet-btn dsh-fleet-btn--sm"
                    disabled={sending || !screenData?.ok}
                    onClick={() => handleSendKey(key)}
                    title={`发送按键 ${key}`}
                  >
                    {btnLabel}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'checks' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <strong>门禁状态：{checks.gate}</strong>
              {checks.durationMs !== null && (
                <span className="dsh-fleet-row-time dsh-fleet-num">总耗时 {formatElapsed(checks.durationMs)}</span>
              )}
            </div>
            {checks.steps.length === 0 ? (
              <div className="dsh-fleet-empty">
                <span>当前面板尚未运行门禁校验。</span>
              </div>
            ) : (
              checks.steps.map((step, i) => (
                <div className="dsh-fleet-check-step" key={`${step.name}-${i}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <strong>{step.name} ({step.status})</strong>
                    <span className="dsh-fleet-num">{step.durationMs} ms</span>
                  </div>
                  {step.summary && <span>{step.summary}</span>}
                </div>
              ))
            )}
            {checks.failure && (
              <div>
                <div style={{ color: 'var(--fleet-c-error)', fontWeight: 560, fontSize: 12 }}>
                  失败：{checks.failure.step} — {checks.failure.reason}
                </div>
                <pre className="dsh-fleet-check-excerpt">{checks.failure.excerpt}</pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer: Writable Prompt Bar OR Read-Only Notice (ZERO fake textarea/input!) + Handoff Bar */}
      <footer className="dsh-fleet-footer">
        {pane.writable && pane.status !== 'blocked' && (
          <form className="dsh-fleet-prompt-row" onSubmit={handleSendPrompt}>
            <textarea
              className="dsh-fleet-prompt-textarea"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  void handleSendPrompt()
                }
              }}
              placeholder="向该 Agent 发送指令… (⌘↵ 发送)"
              rows={2}
              disabled={sending}
            />
            <button
              type="submit"
              className="dsh-fleet-btn dsh-fleet-btn--primary"
              disabled={sending || !promptText.trim()}
            >
              发送
            </button>
          </form>
        )}

        {!pane.writable && (
          <div className="dsh-fleet-readonly-notice">
            <span>⧉ {WRITABLE_REASON_TEXT[pane.writableReason] ?? '该面板只读，不提供输入框'}</span>
          </div>
        )}

        {pane.agent && (
          <div className="dsh-fleet-handoff">
            <span style={{ fontSize: 11, color: 'var(--fleet-text-3)' }}>
              接着问会带上最近 20 条消息（超 8k 截断），在新会话里继续
            </span>
            <div className="dsh-fleet-handoff-actions">
              <button
                type="button"
                className="dsh-fleet-btn dsh-fleet-btn--sm"
                title="开一个新会话，带上这条线程的最近 20 条"
                onClick={() => onHandoffContinue?.(pane, framesData?.frames ?? [])}
              >
                接着问 → 开新会话
              </button>
              <button
                type="button"
                className="dsh-fleet-btn dsh-fleet-btn--sm"
                onClick={handleCopyContext}
              >
                {copied ? '已复制 ✓' : '复制上下文'}
              </button>
            </div>
          </div>
        )}
      </footer>
    </main>
  )
}
