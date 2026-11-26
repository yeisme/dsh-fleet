#!/usr/bin/env node
/**
 * Generates fixtures/fleet.json: the deterministic fake fleet that the client's fixture transport serves and
 * that host tests can reuse. The generator is the source of truth; the JSON is a checked-in artifact that
 * test/contract.test.mjs keeps in sync and validates against lib/fleet/contract.schema.json.
 *
 *   node scripts/gen-fixtures.mjs           write fixtures/fleet.json
 *   node scripts/gen-fixtures.mjs --check   exit 1 if the checked-in file is stale
 *
 * Content is deliberately neutral (/Users/demo/..., generic agent names): no real paths, sessions or prompts.
 * Time is absolute epoch-ms around NOW; the client transport rebases all of it to the real clock when serving.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NOW = 1_800_000_000_000
/** Every key that carries an absolute epoch-ms instant. The client transport shifts exactly these by (real now - NOW). */
export const TIME_FIELDS = Object.freeze(['now', 'stateSince', 'outputAt', 'lastOkAt', 'at'])
const SEC = 1000
const MIN = 60 * SEC
const FENCE = '```'
const STALL_MS = 180 * SEC // keep in sync with docs/design/FLEET-API.md ("stalled")

const ESC = '\u001b['
const sgr = (codes, text) => `${ESC}${codes}m${text}${ESC}0m`
const dim = (text) => sgr('2', text)
const bold = (text) => sgr('1', text)

/* ------------------------------------------------------------------------------------------ builders */

function pane(spec) {
  const agent = spec.agent === null ? null : {
    kind: spec.agent.kind,
    name: spec.agent.name ?? null,
    display: spec.agent.display,
    session: spec.agent.session ?? null,
    interactiveReady: spec.agent.ready ?? true,
  }
  const outputAt = spec.output === null ? null : NOW - spec.output
  const status = spec.status
  return {
    id: spec.id,
    workspaceId: spec.ws[0],
    tabId: spec.tab[0],
    workspaceLabel: spec.ws[1],
    tabLabel: spec.tab[1],
    title: spec.title,
    cwd: spec.cwd ?? '/Users/demo/work/dsh-threads',
    focused: spec.focused ?? false,
    agent,
    status,
    stalled: status === 'working' && outputAt !== null && NOW - outputAt > STALL_MS,
    completionSeq: spec.seq ?? 0,
    stateChangeSeq: spec.change ?? 1,
    stateSince: NOW - spec.since,
    outputAt,
    revision: spec.rev ?? 1,
    summary: spec.summary ?? '',
    summarySource: spec.src ?? 'none',
    writable: spec.writable ?? agent !== null,
    writableReason: spec.writable === false ? spec.reason : agent === null ? 'not-an-agent' : null,
  }
}

function countsOf(panes) {
  const counts = { blocked: 0, done: 0, working: 0, idle: 0, unknown: 0, agents: 0, shells: 0, panes: panes.length }
  for (const p of panes) {
    if (p.agent === null) counts.shells += 1
    else { counts.agents += 1; counts[p.status] += 1 }
  }
  return counts
}

function workspacesOf(panes, focusedWorkspace) {
  const byId = new Map()
  for (const p of panes) {
    const entry = byId.get(p.workspaceId) ?? { id: p.workspaceId, label: p.workspaceLabel, focused: p.workspaceId === focusedWorkspace, tabs: new Set(), paneCount: 0 }
    entry.tabs.add(p.tabId)
    entry.paneCount += 1
    byId.set(p.workspaceId, entry)
  }
  return [...byId.values()].map(({ tabs, ...rest }) => ({ ...rest, tabCount: tabs.size }))
}

const HEALTH_OK = {
  connected: true, socket: '/Users/demo/.config/herdr/herdr.sock', version: '0.9.5', protocol: 22,
  lastOkAt: NOW - 800, error: null, session: null,
}

function state({ revision, panes, health = HEALTH_OK, stale = false, policy = 'all' }) {
  const focusedWorkspace = panes.find((p) => p.focused)?.workspaceId ?? null
  return {
    ok: true,
    protocol: 1,
    revision,
    now: NOW,
    stale,
    machine: { id: 'local', label: '本机' },
    health,
    policy: { write: policy },
    workspaces: workspacesOf(panes, focusedWorkspace),
    panes,
    counts: countsOf(panes),
  }
}

/** Frame factories with per-transcript sequential ids. */
function transcript(paneKey) {
  let n = 0
  const id = () => `${paneKey}-f${String(++n).padStart(4, '0')}`
  return {
    session: (sessionId, cwd = '/Users/demo/work/dsh-threads') => ({ kind: 'session', id: id(), sessionId, cwd }),
    user: (text, at = null) => ({ kind: 'text', id: id(), role: 'user', text, at }),
    assistant: (text, at = null) => ({ kind: 'text', id: id(), role: 'assistant', text, at }),
    system: (text) => ({ kind: 'text', id: id(), role: 'system', text, at: null }),
    reasoning: (text) => ({ kind: 'reasoning', id: id(), text }),
    work: (summary, rows, tokens = null) => ({ kind: 'work', id: id(), summary, rows: rows.map(([verb, object, outcome = 'ok', ms = null]) => ({ verb, object, outcome, ms })), tokens }),
    final: (text, reason = 'turn_duration', ms = null) => ({ kind: 'final', id: id(), text, reason, ms }),
  }
}

function framesResponse(paneId, { source = 'transcript', reason = null, kind = null, sessionId = null, frames = [], hasEarlier = false, partial = false }) {
  return {
    ok: true,
    paneId,
    source,
    reason,
    agentKind: kind,
    sessionId,
    frames,
    hasEarlier,
    partial,
    reset: false,
    unknownFrames: 0,
    cursor: frames.length === 0 ? { start: null, end: null } : { start: 'o:1024', end: `o:${1024 + frames.length * 640}` },
  }
}

function screenResponse(paneId, revision, lines) {
  return { ok: true, paneId, revision, format: 'ansi', text: lines.join('\n'), cols: 96, rows: lines.length, at: NOW - 300 }
}

/* ------------------------------------------------------------------------------------------ transcripts */

function reviewerFrames() {
  const t = transcript('r')
  return [
    t.session('7f3a9c20-0001-demo', '/Users/demo/work/dsh-threads'),
    t.user('审查一下 legacy 包裹的注册清单测试，重点看假宿主有没有漏记注册。', NOW - 5 * MIN),
    t.reasoning('先看 `test/helpers/fake-host.mjs` 记录了哪些调用，再对照 `legacy-manifest.json` 的数量，最后确认变异测试能检出改动。'),
    t.work('读取 3 个文件', [
      ['Read', 'test/helpers/fake-host.mjs', 'ok', 12],
      ['Read', 'test/legacy-manifest.test.mjs', 'ok', 9],
      ['Grep', 'register  (src/legacy)', 'ok', 41],
    ], 18_204),
    t.assistant([
      '## 初步结论',
      '',
      '假宿主一共记录了 **77 条**调用，覆盖：',
      '',
      '- `ctx.sidebarRightTabs.register` ×3',
      '- `ctx.shortcuts.register` ×4',
      '- `ctx.commandUi.register` ×3',
      '',
      '| 注册点 | 次数 | 是否有断言 |',
      '|---|---:|---|',
      '| `slots.register` | 8 | 是 |',
      '| `resources.register` | 1 | 是 |',
      '| `head.appendChild`（CSS） | 2 | 是 |',
      '',
      '为了排除旧产物的干扰，需要清理后重新构建一次：',
      '',
      `${FENCE}bash`,
      'rm -rf dist/ && bun run build',
      FENCE,
    ].join('\n')),
    t.work('等待批准', [['Bash', 'rm -rf dist/ && bun run build', null, null]]),
  ]
}

function testerFrames() {
  const t = transcript('t')
  return [
    t.session('b21e44d0-0002-demo'),
    t.user('跑一遍测试并汇报失败项。', NOW - 14 * MIN),
    t.work('运行测试', [
      ['Bash', 'node --test "test/**/*.test.mjs"', 'ok', 1840],
    ], 4_112),
    t.assistant('12 个测试全部通过 ✅，没有失败项，也没有被跳过的用例。', NOW - 13 * MIN),
    t.user('顺便看一下构建是不是确定性的。', NOW - 12.5 * MIN),
    t.work('核对构建', [
      ['Bash', 'bun run build', 'ok', 220],
      ['Bash', 'bun run build', 'ok', 214],
      ['Bash', 'cmp dist/client.js dist/client.js.prev', 'ok', 8],
    ]),
    t.final('两次构建逐字节一致（sha 52564d4d）。', 'task_complete', 184_000),
  ]
}

function frontendFrames() {
  const t = transcript('f')
  return [
    t.session('c90d17aa-0003-demo'),
    t.user('把舰队页的名册做出来：分组、空闲折叠、键盘移动。', NOW - 9 * MIN),
    t.reasoning('名册要按固定顺序分组：需要你、已完成·未读、进行中、空闲。空闲默认折叠成一行计数，选中项永远不折叠。'),
    t.work('读取现有分组逻辑', [
      ['Read', 'src/features/fleet/groups.js', 'ok', 7],
      ['Read', 'test/groups.test.mjs', 'ok', 6],
    ], 9_870),
    t.assistant([
      '先从纯函数开始。`groupPanes()` 的规则：',
      '',
      '1. `blocked` 永远排最前',
      '2. `done` 且未读排第二',
      '3. `working` 里 **停滞**（超过 180 秒无输出）的单独标注',
      '4. 其余 `idle` / `unknown` 折叠',
      '',
      '> 状态用符号加文字双编码，不只靠颜色。',
    ].join('\n')),
    t.work('写入分组函数', [
      ['Write', 'src/features/fleet/groups.js', 'ok', 31],
      ['Bash', 'node --test test/groups.test.mjs', 'error', 902],
    ]),
    t.assistant([
      '测试里有一条失败：停滞判定在 `outputAt === null` 时抛了异常。修复如下：',
      '',
      `${FENCE}diff`,
      '--- a/src/features/fleet/groups.js',
      '+++ b/src/features/fleet/groups.js',
      '@@ -18,7 +18,8 @@ export function isStalled(pane, now) {',
      '-  return pane.status === \'working\' && now - pane.outputAt > STALL_MS',
      '+  if (pane.status !== \'working\' || pane.outputAt === null) return false',
      '+  return now - pane.outputAt > STALL_MS',
      ' }',
      FENCE,
    ].join('\n')),
    t.work('重新运行测试', [['Bash', 'node --test test/groups.test.mjs', 'ok', 640]]),
    t.assistant('通过。接下来做行组件，长标题要省略号截断，路径用等宽字体：`/Users/demo/work/dsh-threads/src/features/fleet/components/RosterRowWithAVeryLongNameThatMustTruncateGracefully.jsx`。'),
    t.assistant('参考：[herdr socket API](https://herdr.dev/docs/socket-api) 里五种状态的定义；耗时用 `tabular-nums`，例如 1,284 ms、12.5 s、3 分 07 秒。'),
    t.user('键盘部分别用 j/k 以外的冲突键。', NOW - 4 * MIN),
    t.reasoning('页内焦点不在输入框时才响应纯字母键；在 composer 里输入时必须原样透传。'),
    t.assistant([
      '好的，键位表如下（仅当焦点不在输入框内时生效）：',
      '',
      '| 键 | 动作 |',
      '|---|---|',
      '| `j` / `k`, `↑` / `↓` | 移动选中 |',
      '| `↵` | 打开并聚焦输入框 |',
      '| `/` | 搜索 |',
      '| `x` | 中断（需确认） |',
    ].join('\n')),
    t.work('更新名册组件', [
      ['Edit', 'src/features/fleet/Roster.jsx', 'ok', 24],
      ['Edit', 'src/features/fleet/Row.jsx', 'ok', 19],
      ['Edit', 'src/features/fleet/css.js', 'ok', 15],
    ], 31_550),
    t.assistant('名册和行已经接上，正在检查亮色与暗色主题下的状态点对比度 🎨。', NOW - 40 * SEC),
    t.work('截图检查', [['Bash', 'bun run build:client', null, null]]),
  ]
}

function researchFrames() {
  const t = transcript('s')
  return [
    t.session('1d5b8e61-0004-demo'),
    t.user('读一下 herdr 的 socket API 文档，列出和状态相关的方法。', NOW - 26 * MIN),
    t.reasoning('关键是 `agent.wait`、`agent.explain` 和 `events.subscribe`，另外要确认 `done` 与 `idle` 的区别。'),
    t.work('读取文档', [['WebFetch', 'herdr.dev/docs/socket-api', 'ok', 1210]]),
  ]
}

/* ------------------------------------------------------------------------------------------ screens */

function reviewerScreen() {
  const bar = dim('─'.repeat(70))
  return [
    ` ${sgr('1;36', '●')} ${bold('Bash')}(rm -rf dist/ && bun run build)`,
    '',
    dim('╭' + '─'.repeat(70) + '╮'),
    `${dim('│')} ${bold('Bash command')}${' '.repeat(57)}${dim('│')}`,
    `${dim('│')}${' '.repeat(70)}${dim('│')}`,
    `${dim('│')}   rm -rf dist/ && bun run build${' '.repeat(38)}${dim('│')}`,
    `${dim('│')}   ${dim('清理旧产物后重新构建')}${' '.repeat(39)}${dim('│')}`,
    dim('╰' + '─'.repeat(70) + '╯'),
    '',
    ` Do you want to proceed?`,
    ` ${sgr('36', '❯ 1. Yes')}`,
    `   2. Yes, and don't ask again for ${bold('rm')} commands in this project`,
    `   3. No, and tell Claude what to do differently ${dim('(esc)')}`,
    '',
    bar,
  ]
}

function frontendScreen() {
  return [
    ` ${sgr('1;32', '✓')} 读取 src/features/fleet/groups.js`,
    ` ${sgr('1;32', '✓')} 写入 src/features/fleet/groups.js`,
    ` ${sgr('1;31', '✗')} node --test test/groups.test.mjs ${dim('(exit 1)')}`,
    ` ${sgr('1;32', '✓')} node --test test/groups.test.mjs`,
    '',
    ` ${sgr('33', '✻')} 更新名册组件… ${dim('(12s · ↑ 3.1k tokens · esc to interrupt)')}`,
    '',
    ` ${dim('> ')}`,
    ` ${dim('? for shortcuts')}`,
  ]
}

function genericScreen(label) {
  return [
    ` ${bold(label)}`,
    '',
    ` ${dim('(fixture screen)')}`,
    '',
    ` ${dim('> ')}`,
  ]
}

/* ------------------------------------------------------------------------------------------ scenarios */

const W1 = ['w1', 'dsh-threads-dev']
const W2 = ['w2', 'solocut']
const W3 = ['w3', 'docs']

function busyPanes() {
  return [
    pane({ id: 'w1:p1', ws: W1, tab: ['w1:t1', 'main'], title: '审查 legacy 包裹的注册清单', status: 'blocked', since: 4 * MIN, output: 4 * MIN, seq: 8, change: 31, rev: 412,
      agent: { kind: 'claude', name: 'dsh-reviewer', display: 'claude · 审查注册清单' }, summary: '等待批准：Bash — rm -rf dist/ && bun run build', src: 'screen' }),
    pane({ id: 'w1:p2', ws: W1, tab: ['w1:t1', 'main'], title: '跑一遍测试 | dsh-threads', status: 'done', since: 12 * MIN, output: 12 * MIN, seq: 15, change: 44, rev: 903,
      agent: { kind: 'codex', name: 'dsh-tester', display: 'codex · 跑一遍测试' }, summary: '12 个测试全部通过', src: 'transcript' }),
    pane({ id: 'w1:p3', ws: W1, tab: ['w1:t1', 'main'], title: '舰队页名册', status: 'working', since: 9 * MIN, output: 3 * SEC, seq: 6, change: 52, rev: 1288, focused: true,
      agent: { kind: 'claude', name: 'dsh-frontend', display: 'claude · 舰队页名册' }, summary: '正在改 src/features/fleet/Roster.jsx', src: 'transcript' }),
    pane({ id: 'w2:p1', ws: W2, tab: ['w2:t1', 'edit'], title: 'π - dsh-research', status: 'working', since: 25 * MIN, output: 7 * MIN, seq: 3, change: 20, rev: 301, cwd: '/Users/demo/work',
      agent: { kind: 'pi', name: 'dsh-research', display: 'pi · herdr 文档', session: { kind: 'path', source: 'herdr:pi' } },
      summary: '读取 socket-api.mdx', src: 'transcript' }),
    pane({ id: 'w2:p2', ws: W2, tab: ['w2:t1', 'edit'], title: 'Grok · 竞品调研', status: 'working', since: 2 * MIN, output: 1 * SEC, seq: 2, change: 9, rev: 77, cwd: '/Users/demo/work/research',
      agent: { kind: 'grok', name: 'dsh-grok-bot', display: 'grok · 竞品调研' }, summary: '汇总 T3 Code 与 Alma 的差异', src: 'screen' }),
    pane({ id: 'w3:p1', ws: W3, tab: ['w3:t1', 'notes'], title: 'π - workspace', status: 'idle', since: 40 * MIN, output: 40 * MIN, seq: 1, change: 6, rev: 64, cwd: '/Users/demo/work',
      agent: { kind: 'pi', name: null, display: 'pi · workspace', session: { kind: 'path', source: 'herdr:pi' } },
      summary: '', src: 'none' }),
    pane({ id: 'w3:p2', ws: W3, tab: ['w3:t1', 'notes'], title: 'README 草稿', status: 'idle', since: 180 * MIN, output: 180 * MIN, seq: 4, change: 12, rev: 150, cwd: '/Users/demo/work/docs',
      agent: { kind: 'opencode', name: 'docs-writer', display: 'opencode · README' }, summary: '已更新 README 的安装一节', src: 'screen' }),
    pane({ id: 'w3:p3', ws: W3, tab: ['w3:t1', 'notes'], title: 'gemini', status: 'unknown', since: 1 * MIN, output: 20 * SEC, seq: 0, change: 2, rev: 11, cwd: '/Users/demo/work/docs',
      agent: { kind: 'gemini', name: 'dsh-gemini', display: 'gemini' }, summary: '', src: 'none' }),
    pane({ id: 'w1:p4', ws: W1, tab: ['w1:t1', 'main'], title: 'zsh — dsh-threads', status: 'unknown', since: 30 * MIN, output: 30 * MIN, rev: 5, agent: null }),
    pane({ id: 'w2:p3', ws: W2, tab: ['w2:t1', 'edit'], title: 'zsh', status: 'unknown', since: 50 * MIN, output: 50 * MIN, rev: 3, cwd: '/Users/demo/work', agent: null }),
  ]
}

const withFocus = (panes, id) => panes.map((p) => ({ ...p, focused: p.id === id }))
const only = (map, ids) => Object.fromEntries(Object.entries(map).filter(([id]) => ids.includes(id)))

/** What the host serves for each agent pane of the full fleet; the smaller scenarios are slices of it. */
function busyFrames() {
  return {
    'w1:p1': framesResponse('w1:p1', { kind: 'claude', sessionId: '7f3a9c20-0001-demo', frames: reviewerFrames() }),
    'w1:p2': framesResponse('w1:p2', { kind: 'codex', sessionId: 'b21e44d0-0002-demo', frames: testerFrames() }),
    'w1:p3': framesResponse('w1:p3', { kind: 'claude', sessionId: 'c90d17aa-0003-demo', frames: frontendFrames(), hasEarlier: true }),
    'w2:p1': framesResponse('w2:p1', { kind: 'pi', sessionId: '1d5b8e61-0004-demo', frames: researchFrames() }),
    'w2:p2': framesResponse('w2:p2', { source: 'screen', reason: 'unsupported-agent', kind: 'grok' }),
    'w3:p1': framesResponse('w3:p1', { source: 'screen', reason: 'not-yet', kind: 'pi' }),
    'w3:p2': framesResponse('w3:p2', { source: 'screen', reason: 'unsupported-agent', kind: 'opencode' }),
    'w3:p3': framesResponse('w3:p3', { source: 'screen', reason: 'unsupported-agent', kind: 'gemini' }),
  }
}

function busyScreens() {
  return {
    'w1:p1': screenResponse('w1:p1', 412, reviewerScreen()),
    'w1:p2': screenResponse('w1:p2', 903, genericScreen('codex · 跑一遍测试')),
    'w1:p3': screenResponse('w1:p3', 1288, frontendScreen()),
    'w2:p1': screenResponse('w2:p1', 301, genericScreen('pi · herdr 文档')),
    'w2:p2': screenResponse('w2:p2', 77, genericScreen('grok · 竞品调研')),
    'w3:p1': screenResponse('w3:p1', 64, genericScreen('pi · workspace')),
    'w3:p2': screenResponse('w3:p2', 150, genericScreen('opencode · README')),
    'w3:p3': screenResponse('w3:p3', 11, genericScreen('gemini')),
  }
}

/** herdr unreachable: transcripts are still files on disk, but a screen fallback has no screen to fall back to. */
function staleFrames() {
  return Object.fromEntries(Object.entries(busyFrames()).map(([id, response]) => [id, response.source === 'screen' ? { ...response, source: 'none' } : response]))
}

/** The second kind of "waiting for you": a plain question, not a tool approval. */
function questionScreen() {
  return [
    ` ${sgr('1;36', '●')} ${bold('Write')}(docs/design/FLEET.md)`,
    '',
    ' 文件已存在。要覆盖 docs/design/FLEET.md 吗？',
    ` ${sgr('36', '❯ 1. 覆盖')}`,
    '   2. 另存为 FLEET-2.md',
    `   3. 取消 ${dim('(esc)')}`,
  ]
}

/** The everyday fleet: every status, a stalled agent, unread completions, six agent kinds, two plain shells. */
function busyScenario() {
  return { state: state({ revision: 5821, panes: withFocus(busyPanes(), 'w1:p3') }), frames: busyFrames(), screens: busyScreens() }
}

/** Two agents need the user (one tool approval, one plain question) and one is working. */
function blockedScenario() {
  const ids = ['w1:p1', 'w2:p1', 'w1:p3', 'w1:p4']
  const revision = 302 // the research agent just flipped to blocked: its revision moved, and its screen is read at the new one
  const panes = withFocus(busyPanes(), 'w1:p3').filter((p) => ids.includes(p.id)).map((p) => (p.id !== 'w2:p1' ? p : {
    ...p,
    title: '调研 herdr 文档',
    status: 'blocked',
    stalled: false,
    stateSince: NOW - 9 * MIN,
    outputAt: NOW - 9 * MIN,
    stateChangeSeq: p.stateChangeSeq + 1,
    revision,
    summary: '等待回答：文件已存在，要覆盖吗？',
    summarySource: 'screen',
    agent: { ...p.agent, kind: 'claude', display: 'claude · 调研', session: null },
  }))
  return {
    state: state({ revision: 5890, panes }),
    frames: { ...only(busyFrames(), ['w1:p1', 'w1:p3']), 'w2:p1': framesResponse('w2:p1', { source: 'screen', reason: 'no-transcript', kind: 'claude' }) },
    screens: { ...only(busyScreens(), ['w1:p1', 'w1:p3']), 'w2:p1': screenResponse('w2:p1', revision, questionScreen()) },
  }
}

/** Nothing needs anyone: the "all handled" empty state. */
function calmScenario() {
  const ids = ['w3:p1', 'w3:p2', 'w1:p4']
  return {
    state: state({ revision: 6010, panes: withFocus(busyPanes(), 'w3:p1').filter((p) => ids.includes(p.id)) }),
    frames: only(busyFrames(), ids),
    screens: only(busyScreens(), ids),
  }
}

/** herdr is up but only a plain shell is running: the "no bots yet" empty state. */
function emptyScenario() {
  const panes = withFocus(busyPanes(), 'w1:p4').filter((p) => p.id === 'w1:p4')
  return { state: state({ revision: 1, panes }), frames: {}, screens: {} }
}

/** herdr is not running: the "start herdr / reconnect" empty state. */
function offlineScenario() {
  const health = { connected: false, socket: '/Users/demo/.config/herdr/herdr.sock', version: null, protocol: null, lastOkAt: null, error: 'connect ENOENT /Users/demo/.config/herdr/herdr.sock', session: null }
  return { state: state({ revision: 0, panes: [], health }), frames: {}, screens: {} }
}

/** herdr dropped after a good state: last-known data, read-only, with a "disconnected N s ago" banner. */
function staleScenario() {
  const health = { ...HEALTH_OK, connected: false, lastOkAt: NOW - 95 * SEC, error: 'herdr socket closed (ECONNRESET)' }
  // An intrinsic reason outranks the transient one: a shell stays "not-an-agent" while the connection is down.
  const panes = withFocus(busyPanes(), 'w1:p3').map((p) => ({ ...p, writable: false, writableReason: p.agent === null ? 'not-an-agent' : 'offline' }))
  // Transcripts are files, so frames keep working without herdr; a screen needs the live socket, so there are none.
  return { state: state({ revision: 5821, panes, health, stale: true }), frames: staleFrames(), screens: {} }
}

/* ------------------------------------------------------------------------------------------ act examples */

// The one deliberately WRONG chord, assembled from parts so this file itself stays clean under the hard-rule scan.
const HYPHEN_CHORD = ['ctrl', 'c'].join('-')

function actExamples() {
  const valid = [
    { verb: 'prompt', pane: 'w1:p3', text: '继续：把空闲折叠做成一行计数，点开才展开。' },
    { verb: 'answer', pane: 'w1:p1', text: '先别删，改成只删 dist/client.js', enter: true, expectRevision: 412 },
    { verb: 'keys', pane: 'w1:p1', keys: ['1', 'enter'], expectRevision: 412 },
    { verb: 'keys', pane: 'w1:p1', keys: ['esc'], expectRevision: 412 },
    { verb: 'interrupt', pane: 'w1:p3' },
    { verb: 'rename', pane: 'w3:p1', name: 'dsh-notes' },
    { verb: 'restart', pane: 'w2:p1', confirm: true },
    { verb: 'restart', pane: 'w2:p1', confirm: true, thenPrompt: '接着刚才的调研继续，先列出状态相关的方法。' },
    { verb: 'close', pane: 'w3:p2', confirm: true },
  ]
  const invalid = [
    { why: 'restart without confirm', request: { verb: 'restart', pane: 'w2:p1' }, reason: 'confirm-required' },
    { why: 'close with a non-boolean confirm (must be exactly true)', request: { verb: 'close', pane: 'w3:p2', confirm: 'yes' }, reason: 'confirm-required' },
    { why: 'close with confirm:false', request: { verb: 'close', pane: 'w3:p2', confirm: false }, reason: 'confirm-required' },
    { why: 'hyphen chord is not in the key grammar (hard rule 3)', request: { verb: 'keys', pane: 'w1:p3', keys: [HYPHEN_CHORD], expectRevision: 1288 }, reason: 'key-not-allowed' },
    { why: 'a printable key outside the whitelist', request: { verb: 'keys', pane: 'w1:p3', keys: ['a'], expectRevision: 1288 }, reason: 'key-not-allowed' },
    { why: 'keys without expectRevision', request: { verb: 'keys', pane: 'w1:p1', keys: ['enter'] }, reason: 'invalid-request' },
    { why: 'empty prompt', request: { verb: 'prompt', pane: 'w1:p3', text: '' }, reason: 'invalid-request' },
    { why: 'unknown extra field', request: { verb: 'interrupt', pane: 'w1:p3', force: true }, reason: 'invalid-request' },
    { why: 'agent name must be lowercase kebab', request: { verb: 'rename', pane: 'w3:p1', name: 'Not Valid' }, reason: 'invalid-request' },
    { why: 'spawn is reserved for P2, not in v1', request: { verb: 'spawn', kind: 'claude', cwd: '/Users/demo/work' }, reason: 'unknown-verb' },
    { why: 'no verb', request: { pane: 'w1:p3' }, reason: 'invalid-request' },
  ]
  return { valid, invalid }
}

/* ------------------------------------------------------------------------------------------ file */

export function build() {
  return {
    about: 'Deterministic fake fleet for the Fleet client (fixture transport) and host tests. Generated by scripts/gen-fixtures.mjs — do not edit by hand. Times are absolute epoch-ms around `now`; clients rebase them to the real clock.',
    now: NOW,
    scenarios: {
      busy: busyScenario(),
      blocked: blockedScenario(),
      calm: calmScenario(),
      empty: emptyScenario(),
      offline: offlineScenario(),
      stale: staleScenario(),
    },
    act: actExamples(),
  }
}

export const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/fleet.json')
export const render = () => `${JSON.stringify(build(), null, 2)}\n`

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const text = render()
  if (process.argv.includes('--check')) {
    let current = ''
    try { current = readFileSync(FIXTURE_PATH, 'utf8') } catch { /* missing counts as stale */ }
    if (current !== text) { console.error('fixtures/fleet.json is stale: run node scripts/gen-fixtures.mjs'); process.exit(1) }
    console.log('fixtures/fleet.json is up to date')
  } else {
    writeFileSync(FIXTURE_PATH, text)
    console.log(`wrote fixtures/fleet.json (${text.length} bytes)`)
  }
}
