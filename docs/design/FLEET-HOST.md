# Fleet 宿主侧设计（H1–H6）

> 状态：宿主批次开工时的接口与规则（2026-11-27）。对外形状以 `docs/design/FLEET-API.md` 和 `lib/fleet/contract.schema.json` 为准，本文只管**宿主内部**：模块边界、接口、herdr 线上事实、动词到 RPC 的映射、派生字段、哪些已核实哪些没有。
> 宿主代码在 `index.js` 接线之前**不会被线上的 3081 加载**；接线是最后一步，且要先问用户（宿主改动走 idle-restart 窗口）。

## 0. 硬约束（所有轨道）

- **复用 orchestrator = 复制 + 改造**（源在 `~/Documents/deepseek-harness/default-workspace/herdr-orchestrator/lib`，只读）。不 import、不依赖它，它保持独立可下线。
- 不碰 `~/.dsh-test`；不重启 3081；**只新增文件**，不改 `index.js`、`client.js`、`src/`。
- **绝不向真实 herdr pane 发输入**：写路径只在假 herdr（`test/helpers/fake-herdr.js`）上测；任何接真 herdr 的脚本只许只读。
- 三条硬规则（`test/hard-rules.test.mjs` 会扫 `lib/`、`scripts/`）：按键用加号和弦，**`ctrl+c`，不是连字符形式**；不用 `state-done-*`；JSX 不适用于宿主。
- 日志只记 `verb`、`pane`、结果、耗时。**不记** `text`、`thenPrompt`、`keys` 的内容；错误 `message`/`detail` 也不回显它们。
- 风格：ESM、无分号、2 空格、单引号、**零依赖**（只用 `node:*`）、`node:test`。注释写「为什么」，不复述代码。
- 宿主的每个对外产出都要在测试里用 `lib/fleet/schema.js` 对 `contract.schema.json` 校验（`validateDef(contract, 'State', …)`）。**产出不合契约就是 bug**，不要为迁就实现去改契约；觉得契约有问题，停下来报告。
- 不提交（`git commit`/`git add` 由协调者做）。

## 1. 模块与所有权

| 模块 | 文件 | 轨道 |
|---|---|---|
| H1 协议、发现、规范化 | `lib/herdr/{protocol,discover,normalize}.js`、`test/helpers/{fake-herdr,wire}.js`、`test/{protocol,fake-herdr,normalize}.test.mjs` | **已完成** |
| H2 状态存储 | `lib/herdr/state.js`、`test/state.test.mjs`、`scripts/parity.mjs` | A |
| H3 转写读取 | `lib/transcripts/{index,pi,claude,codex}.js`、`test/fixtures/transcripts/**`、`test/transcripts.test.mjs` | B |
| H4 状态模型 | `lib/fleet/{model,attention}.js`、`test/{model,attention}.test.mjs`、`test/helpers/fixture-world.js` | C1 |
| H5 写动作 | `lib/fleet/{actions,errors,store}.js`、`test/{actions,store,errors}.test.mjs` | C2 |
| 共享：谁能写 | `lib/fleet/writability.js`、`test/writability.test.mjs` | **已完成** |
| H5′ 服务（胶水） | `lib/fleet/service.js`、`test/service.test.mjs` | 协调者（等 A/B/C1/C2 合入后） |
| H6 HTTP/SSE/安全与接线 | `lib/{http,sse,security}.js`、`index.js`（最后、需批准） | 协调者 |

## 2. 接口（各轨道按此并行开发；写偏了就报告，不要自己改别人的文件）

```js
// lib/herdr/protocol.js —— 已有。HerdrClient.request(method, params, { timeoutMs, signal }) / subscribe(subs, { onEvent, onAck, onLost })
//   HerdrError { method, code } ；isOfflineError(error)：socket 不可达（ENOENT/ECONNREFUSED/…）≠ herdr 答了一个错误帧

// lib/herdr/state.js （H2）
export const SUBSCRIPTIONS            // 沿用 orchestrator：只订阅不要 pane id 的广播类，坏一个 pane 不会让整条订阅被拒
export class HerdrState extends EventEmitter {
  constructor(client, { pollIntervalMs = 3000, coalesceMs = 120, now = Date.now, session = null } = {})
  start(): Promise<this>              // 首次刷新失败不抛：health 置为 down，继续轮询
  stop()
  refresh({ force }): Promise<Snapshot>   // 同一时刻只有一次在飞（合并），失败抛 HerdrError
  get snapshot(): Snapshot            // 首次成功之前是空快照
  get revision(): number              // 可见内容变了才 +1（时间字段不算）
  get health(): Health                // 契约 Health：{ connected, socket, version, protocol, lastOkAt, error, session }
  get stale(): boolean                // 有过快照、但最近一次刷新失败：继续展示最后已知
  // 事件：'change' (snapshot, previous)、'status' ({ status: 'live' | 'reconnecting' | 'down', error? })
}
// Snapshot：herdr 的 snake_case 在 lib/herdr/normalize.js（已完成，纯函数）里一次性规范化，下游不再见到 wire 名。
//   `normalizeSnapshot(result)`、`snapshotSignature(snapshot)`（"可见内容变了没有"的等价键，不含时间字段）、`EMPTY_SNAPSHOT` 都从那里取，不要重写。
//   测试里要一个 Snapshot：`normalizeSnapshot(world.snapshot())`（`test/helpers/wire.js` 的 `createWorld`），再按需补 `stateSince`/`outputAt`。
//   { version, protocol, focused: { workspaceId, tabId, paneId },
//     workspaces: [{ id, number, label, focused, paneCount, tabCount, activeTabId, agentStatus }],
//     tabs:       [{ id, workspaceId, number, label, focused, paneCount, agentStatus }],
//     panes: [{ id, workspaceId, tabId, terminalId, focused, cwd, foregroundCwd, title, label,
//               agent: string | null, displayAgent, agentName: string | null, agentStatus,
//               agentSession: { agent, kind, source, value } | null,   // 原样保留：转写模块要用 `value`；对浏览器的契约只给 {kind, source}，由 model 裁剪
//               interactiveReady: boolean | null, launchPending: boolean,
//               revision, completionSeq, stateChangeSeq, stateSince, outputAt }],
//     updatedAt, revision }
//   `agent*` 字段来自 session.snapshot 的 `agents[]`（按 pane_id 合并到 pane 上；`panes[]` 自己没有 name/completion_seq/state_change_seq/interactive_ready）。

// lib/transcripts/index.js （H3）
export function supportsKind(kind): boolean                    // 目前 pi / claude / codex
export function readFrames({ kind, session, cwd, home = os.homedir(), before, after, limit = 80, signal }): Promise<
  | { status: 'ok', sessionId, frames, hasEarlier, partial, reset, unknownFrames, cursor: { start, end } }   // frames 是契约的 Frame
  | { status: 'missing', reason: 'no-transcript' | 'not-yet' | 'unsupported-agent' | 'unreadable' } >
//   `session` = 快照里的 agentSession（原样）。screen / none 的取舍不在这里：缺失只报原因，由 service 决定 source。

// lib/fleet/attention.js （H4，纯函数，客户端也会 import，所以不得引入任何 node:* 模块）
export const STALL_MS = 180_000
export function isStalled(pane, now), attentionGroup(pane, { now, seen })   // pane 是契约的 Pane；seen: { [paneId]: 已读 completionSeq }

// lib/fleet/model.js （H4，纯）
export function buildState({ snapshot, health, stale, policy, now, summaries, revision }): State   // 契约 State；summaries: { [paneId]: { text, source } }
//   每个 pane 的 writable/writableReason 用 lib/fleet/writability.js 的 writability({ id, isAgent }, { policy, dshPanes, connected, stale })（已完成；model 与 actions 共用，不要重写）
export function deriveSummary({ status, frames, screenText }): { text, source }                    // 纯：≤240 个码点，超出以 … 截断

// lib/fleet/writability.js （已完成）：writability({ id, isAgent }, { policy, dshPanes, connected, stale }) → { writable, reason }
//   优先级 not-an-agent → policy-* → offline；不认识的 policy 一律按只读（fail closed）；POLICIES 列表

// lib/fleet/errors.js （H5）
export class FleetError extends Error { reason; status; detail }       // reason ∈ 契约 ErrorReason；status 按 FLEET-API.md §7 的表
export const STATUS_BY_REASON                                          // 必须覆盖契约 ErrorReason 的每一项（测试断言）

// lib/fleet/store.js （H5）：原子写的小 JSON 存储，路径注入
export class FleetStore { constructor({ file }); get policy(); setPolicy(policy); get dshPanes(): Set<string> }   // 默认 policy = 'all'

// lib/fleet/actions.js （H5，C2）：写动作的全部逻辑，不依赖 service
export function validateRequest(request): ValidRequest                 // 纯；§4 第 1 步；抛 FleetError
export function mapHerdrError(error, { verb }): FleetError             // §4 的集中映射
export function createActions({ client, state, store, log = () => {}, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }): { act(request): Promise<ActResponse> }
//   state：HerdrState 形的对象 { snapshot, health, stale, refresh() }；store：FleetStore 形的对象 { policy, dshPanes }；二者在测试里都可以是手写桩

// lib/fleet/service.js （H5′，协调者在各轨道合入后写：把 state/transcripts/model/actions/store 接成 state()/frames()/screen()/act()）
export class FleetService {
  constructor({ client, state, transcripts, store, config = {}, now = Date.now, sleep, log = () => {} })
  get revision(): number                 // 构建出的 State（不含 now/revision 本身）变了才 +1
  state(): State                         // 同步，来自缓存
  frames(paneId, { before, after, limit }): Promise<FramesResponse>   // 含 ok/paneId/source/reason/agentKind…；缺失原因 → source 'screen'（能读屏）或 'none'（不能）
  screen(paneId): Promise<ScreenResponse>
  act(request): Promise<ActResponse>     // 失败抛 FleetError
  onChange(listener): () => void         // revision 变化时触发（SSE 订阅它）
  start(): Promise<void>; stop()
}
```

## 3. herdr 线上事实（`herdr api schema` + 对真实快照只看键名与类型核实，herdr 0.9.5 / protocol 22）

- 请求 `{ id, method, params }`；成功 `{ id, result: { type: <tag>, … } }`；失败 `{ id, error: { code, message } }`；普通请求答完即关连接，`events.subscribe` 长连接（先 `subscription_started`，再 `{ event, data }`）。订阅条目用点号名（`pane.updated`），事件名是下划线（`pane_updated`）。
- 用到的方法与参数（均在 schema 里）：

| 方法 | 参数 | 结果 tag |
|---|---|---|
| `session.snapshot` | — | `session_snapshot`{ snapshot } |
| `pane.get` | `pane_id` | `pane_info`{ pane }（含 `revision`、`agent_status`） |
| `agent.get` | `target`（pane id 或 agent 名） | `agent_info`{ agent } |
| `pane.read` | `pane_id`, `source`(`visible`\|`recent`\|`recent_unwrapped`\|`detection`), `format`(`text`\|`ansi`), `lines?` | `pane_read`{ read: { text, revision, truncated, … } } |
| `agent.prompt` | `target`, `text`, `wait?` | `agent_prompted`{ agent } |
| `agent.send_keys` / `pane.send_keys` | `target`\|`pane_id`, `keys[]` | `ok` |
| `pane.send_text` | `pane_id`, `text` | `ok` |
| `pane.send_input` | `pane_id`, `text?`, `keys?` | `ok` |
| `agent.rename` | `target`, `name`\|null | `ok` |
| `agent.start` | `name`, `kind`, `pane_id`, `args?`, `timeout_ms?` | `agent_started`{ agent, argv } |
| `pane.close` | `pane_id` | `ok` |

- 快照里：`workspaces[]`、`tabs[]`、`panes[]`、`agents[]`、`layouts[]`；id 形如 `w1`、`w1:t1`、`w1:p7`；状态 `working` `blocked` `done` `idle` `unknown`；`agent_session` 是 `{ agent, kind, source, value }`。`pane.read` 的结果直接带 pane 的 `revision`，契约的 `ScreenResponse.revision` 就取它。

## 4. 动词到 herdr 的映射与安全规则（H5）

`act(request)` 的流程（`FLEET-API.md` §6 的校验顺序的实现）：

1. **纯校验**（`actions.js` 的 `validateRequest`，不碰 herdr）：非对象/无 `verb` → `invalid-request`；`verb` 不在白名单 → `unknown-verb`；`restart`/`close` 的 `confirm !== true` → `confirm-required`；`keys` 有白名单外的键 → `key-not-allowed`；其余按 `<Verb>Request` 对契约校验 → `invalid-request`。
2. **缓存状态检查**（`state.snapshot` + `writability`）：pane 不在 → `unknown-pane`；不是 agent → `not-an-agent`；策略不允许 → `policy-denied`（`detail.policy`）；herdr 断了或 `stale` → `herdr-offline`。
3. **每个 pane 一把锁**：同一 pane 的写动作串行，不交错按键。
4. **动词专属**（下表）。成功后尽力 `state.refresh({ force: true })`，失败忽略。
5. **任何拒绝都发生在向 herdr 写之前**：七条状态相关拒绝（见 `FLEET-API.md` §8「宿主单测必须点名的拒绝」）的断言是 `fake.writeRequests()` 为空。

| verb | herdr 调用 | 备注 |
|---|---|---|
| `prompt` | `agent.prompt {target: paneId, text}` | 缓存状态为 `blocked` → `agent-blocked`（`detail.status`）。herdr 返回 `agent_blocked` 或消息含 "answer the question on screen first" → 同样 `agent-blocked`。**绝不退化成往终端打字**（orchestrator 会用 bracketed paste 兜底，我们不要：blocked 时用户必须先看到屏幕，走 `answer`/`keys`） |
| `answer` | 先**现读** `pane.get {pane_id}`（不用缓存）：`agent_status !== 'blocked'` → `not-blocked`；`revision !== expectRevision` → `screen-changed`（`detail.revision` = 现读值）。通过后 `pane.send_text {pane_id, text}`（含换行时包 `\u001b[200~…\u001b[201~`），`enter` 为真则间隔 150 ms 再 `pane.send_keys {pane_id, keys:['enter']}` | 不重试；`send_text` 失败则不发回车 |
| `keys` | 现读 `pane.get` → `revision` 对不上 `screen-changed`（不要求 blocked）→ `pane.send_keys {pane_id, keys}` | 键白名单已在第 1 步拦过 |
| `interrupt` | `pane.send_keys {pane_id, keys:['ctrl+c']}` | 一个和弦，不做更强的事；不需要 revision |
| `rename` | `agent.rename {target: paneId, name}` | |
| `restart` | `agent.start {name, kind: pane.agent, pane_id}`；`thenPrompt` 非空则再 `agent.prompt`（仅对 "unknown agent or pane" 这一个竞态重试，≤8 次 × 250 ms） | **只重新拉起，不杀进程**（沿用 orchestrator）：agent 还活着时 herdr 会拒绝，如实以 `herdr-error` 报出（`detail.code`）。`name` 取现有 agent 名，没有则 `${kind}-${paneId}` 清洗成 `[a-z][a-z0-9_-]{0,31}` |
| `close` | `pane.close {pane_id}` | 没有 `force`、没有"只关自己创建的"：谁能关由 `policy` 决定 |

**`screen-changed` 不自动重试**，宿主也不替客户端用新 revision 重发（见 `FLEET-API.md`「刻意为之的约束」）。

**HerdrError → FleetError**（一处集中实现，`actions.js`）：`isOfflineError` → `herdr-offline`；`code === 'timeout'` → `timeout`（注意：超时的写**结果未知**，消息里要如实说）；消息匹配 /unknown (agent or )?pane/i → `unknown-pane`；其余 herdr 错误帧 → `herdr-error`，`detail: { code }`；非 HerdrError 的异常 → `internal`（不暴露栈）。

## 5. 派生字段（H2/H4/H5）

- `stateSince`：宿主观察到状态变化的时刻；**首次观察到某个 pane 时取首次观察的时刻**（不是 orchestrator 的 `now - 1000`，那是在编造输出时间）。宿主重启后会偏晚，文档已写明。
- `outputAt`：宿主观察到该 pane 的 `revision` 变化的时刻；首次观察取首次观察的时刻。
- `stalled`：`status === 'working' && outputAt !== null && now - outputAt > 180_000`。
- `title` = `terminal_title_stripped`（已去掉行首状态字形）回退 `terminal_title`，再回退 `''`；`cwd` = `foreground_cwd` 回退 `cwd` 回退 `''`。
- `agent.name`：不符合 `^[a-z][a-z0-9_-]{0,31}$` 就置 `null`（绝不输出不合契约的值）；`agent.display` 回退到 `kind`；`agent.session` 只留 `{ kind, source }`；`interactiveReady` 为 boolean 或 `null`。
- 普通 shell：`agent: null`、`status: 'unknown'`、不计入按状态的计数（只计入 `shells`/`panes`）。
- `workspaces`/`counts` **从 panes 推导**（不照抄 herdr 自己的计数），这样与 `test/contract.test.mjs` 里的不变量一致。标签取 herdr 的 workspace/tab `label`。
- `summary` / `summarySource`：服务端后台尽力而为，**绝不阻塞 `state()`**，可以落后一轮；按 `(paneId, revision)` 缓存；并发 ≤2。`done` → 最后一条 assistant 文本；`working` → 最近一个工具动作；`blocked` → 读屏（`pane.read visible text`）取提问；其余为空串、`none`。读不到就是空，**不编**。
- `State.revision`：服务层计数，构建出的 State（去掉 `now`、`revision`）与上一次不同才 +1。`State.protocol` 是**契约**版本（常量 1），不是 herdr 的 protocol。

## 6. 转写帧（H3）

- 目标是契约的 `Frame`（`session` `text` `reasoning` `work` `final`），**不要**沿用 orchestrator 自己的帧形状。orchestrator 的 `parsePi/parseClaude/parseCodex` 是解析逻辑的参考，不是输出格式。
- `work`：把连续的工具调用及其结果配成一帧：`rows[{verb, object, outcome, ms}]`（`outcome` 为 `ok`/`error`/`null`=还没有结果），`summary` 用中性文本（如 `Read ×3 · Bash`，不本地化，客户端自己决定怎么展示），`tokens` 取不到就 `null`。
- `final`：回合结束的标记（Claude 的 turn_duration、Codex 的 task_complete 等）带出 `reason`（agent 原样的字符串）和 `ms`；没有这类标记就不产出，别编。
- 游标 `{start, end}` 是不透明字符串（建议按字节偏移 + 一个短指纹，用来发现文件被替换）。`after=cursor.end` 只给之后追加的；文件缩小/被替换 → `reset: true` 并返回新的末尾窗口；`before=cursor.start` 向前翻页，`hasEarlier` 如实；大文件只解析尾部窗口，`partial: true`；读到但不认识的条目计入 `unknownFrames`，**不进 frames**。
- 已知要修的缺陷（orchestrator）：Codex 的 rollout 要**按 cwd** 选，不是"最新的一个"；`before` 必须真的向前翻页；pi 的 usage/time 字段要按真实会话的字段名读。
- 真实 transcript 只能**只读**地看结构来核对字段名；**不得**把任何真实内容抄进仓库，fixtures 全部合成、中性（`/Users/demo/…`）。

## 7. HTTP / SSE（H6，协调者）

沿用 `FLEET-API.md` §1、§3：所有路由先过 `endpoint()` 守卫的等价物（`connection.requestRejection` → 403 等）；SSE 的客户端集合用 `Set`/`Map` 并正确遍历（orchestrator 把 Map 当数组遍历，每个事件都抛错并关订阅——要有回归用例）；`GET frames` 要把 `before` 透传到底；旧的 `/plugin/threads/*` 不动。

## 8. 已核实 / 未核实

**已核实**：方法名与参数、结果 tag、错误帧形状、事件名、`pane.read` 的 `source`/`format` 取值和它带 `revision`（均来自二进制自带的 schema）；快照里各集合的键名与类型（只看了键名与类型）；id 形状；orchestrator 的 prompt/restart 流程是在 0.9.5 上跑过的代码。

**未核实（只有真实 herdr 能证实，留给 P1b / G4 的 `fleet-test` 会话；假 herdr 里是**假设**，别当成事实写进文档）**：
- 按键文法就是加号和弦（`ctrl+c` 可用、连字符形式不可用）——spike 8 只是文档级；
- `agent.prompt` 对 blocked 的拒绝措辞与 `agent_blocked` 这个码；
- `agent.start` 在仍有 agent 的 pane 上被拒绝，以及它的错误码（假 herdr 里的 `agent_already_running` 是编的）；
- `pane.get` 的 `revision` 与快照里的 `revision` 是同一个计数；
- `agent.rename` 接受 pane id 作为 `target`；
- `pane.send_text` 对多行文本的 bracketed paste 行为；
- `completion_seq` 的精确语义（假 herdr 只保证单调）。

## 9. 通用验收

- `node --test "test/**/*.test.mjs"` 全绿（含硬规则扫描）；新增代码零依赖。
- 只改自己名下的文件；没有 `index.js`/`client.js`/`src/` 的改动；没有 git 操作。
- 安全相关的测试要**做变异验证**：把保护代码改坏，测试必须变红，再还原（汇报里写明做了哪几处）。
- 汇报：文件清单、公开接口与上面是否一致（不一致处逐条列出）、没做/做不了的、任何你不确定是否符合契约的地方。
