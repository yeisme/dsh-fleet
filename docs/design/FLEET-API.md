# Fleet API 契约 v1（`/plugin/fleet/*`）

> 状态：P0-2 契约草案。**权威定义是 `lib/fleet/contract.schema.json`**，本文解释它；`test/contract.test.mjs` 保证两者同步（路由、动词、错误原因、按键、`writableReason`、时间字段缺一个就红）。
> 两个实现者共用这一份契约：客户端的 **fixture transport**（P0-6，不经宿主）和 **宿主路由**（H 批，需 idle-restart，不在 3081 上热改）。

| 文件 | 作用 |
|---|---|
| `lib/fleet/contract.schema.json` | 线上形状的权威 schema（所有对象闭合：宿主要加字段，必须先改这里） |
| `lib/fleet/schema.js` | 无依赖校验器，只实现 schema 用到的严格子集；遇到不认识的关键字**抛错**而不是悄悄忽略 |
| `fixtures/fleet.json` | 确定性假舰队，**由 `scripts/gen-fixtures.mjs` 生成，不手改**（`node scripts/gen-fixtures.mjs --check` 查是否过期） |
| `test/schema.test.mjs` / `test/contract.test.mjs` | 校验器语义 / fixtures 对 schema 的符合性、语义自洽、变异测试、文档同步 |

## 刻意为之的约束（先读这里再改；这些都不是缺陷）

### `expectRevision`：不盲打。`screen-changed` 是有意的拒绝，不是要消灭的错误

`answer` 和 `keys` **必须**带 `expectRevision`（用户上一次看屏幕时的 pane revision）。宿主执行前比对 pane 当前的 revision，对不上就拒绝 `screen-changed`（409），**一个字符都不发给 herdr**。

- **为什么**：往终端里打字、按键不可撤销。用户是看着某一刻的屏幕做的决定（比如在审批框上按 `1`）。这之后屏幕变了——agent 弹出了另一个框、问题已在别处被回答——同一个按键就可能批准一个用户从没看过的操作。`expectRevision` 把"我看到的是这一版"绑在动作上。
- **所以 `screen-changed` 是被期望的结果**，不是异常路径。working 中的 pane 输出不断，会经常触发它——这是已接受的代价；要停一个在跑的 agent，用不需要 revision 的 `interrupt`。
- **客户端收到它时要做的**：重新读 `/screen`，把**新屏幕**再展示给用户，由用户重新决定。**不要**拿 `detail.revision` 自动重发——那等于把这道保险拆了。
- **下面这些"优化"都会破坏它，别做**：把 `expectRevision` 改成可选；缺省时由宿主补当前 revision；遇到 `screen-changed` 自动重试；在宿主里把它降成"尽力而为"的警告。`test/contract.test.mjs` 在 schema 把它改成可选时会变红，这是有意的。

同类的严格规则——`confirm` 必须严格等于 `true`、按键只认白名单里的加号和弦、普通 shell 永远只读——见 §6，它们同样是有意的。

## 1. 约定

- JSON、UTF-8。成功响应带 `"ok": true`；失败一律 `{"ok": false, "reason": <§7>, "message": <一句话给人看>, "detail"?: {…}}`。程序只判 `reason`，不解析 `message`。
- 时间是 epoch 毫秒整数，时长是毫秒整数。`State.now` 是宿主时钟；客户端用 `now - Date.now()` 估偏差，不假定两端时钟一致。
- id 是不透明字符串（≤64）。herdr 的 pane id 形如 `w1:p7`，fixtures 用同形。
- **`revision`（pane 级）是变更信号**：影响该 pane 展示的任何变化（状态、输出、transcript 追加）都会让它变；客户端只比较"变没变/是否等于"，不做算术。`State.revision`（全局）同理，且**只在同一个宿主进程生命周期内可比**——重连后无条件整体替换。
- 所有路由先过现有 `endpoint()` 守卫：来源不被信任 → 403 `forbidden`；非文档方法 → 405 `method-not-allowed`；POST 必须是 `application/json`（否则 415 `unsupported-media-type`）；body ≤ 256 KB（否则 413 `payload-too-large`）。
- 日志规则：只记 verb、pane、结果、耗时。**不记** `text`、`thenPrompt`、`keys` 的内容；`message`/`detail` 也不回显它们。

## 2. `GET /plugin/fleet/state` → `State`

整个舰队的快照：`machine`（本机）、`health`（herdr 连接）、`policy`、`workspaces`、`panes`、`counts`。首屏、SSE 不可用、fixture transport 都用它。

- `stale` 只回答一件事：**`panes` 是不是最后已知的旧数据**。herdr 连着时 `connected=true`、`stale=false`。
  - 断开过：`connected=false` 且 `stale=true`——面板仍显示最后已知状态，所有 pane `writable=false`（`offline`）；`health.lastOkAt` 给出"已断开 N 秒"。
  - 从没连上过：`connected=false` 但 `stale=false`——没有旧数据可显示，`panes: []`、`revision: 0`、`lastOkAt: null`，`health.error` 说明原因（如 socket 不存在）。
- `counts`：`blocked/done/working/idle/unknown` 只数 agent；普通 shell 记在 `shells`；`panes` 是全部。
- `policy.write`：`all` / `dsh-only` / `read-only`，**服务端强制**；客户端通过每个 pane 的 `writable` 镜像它。

### Pane 字段

| 字段 | 来源 | 说明 |
|---|---|---|
| `id` `workspaceId` `tabId` | herdr `pane_id` `workspace_id` `tab_id` | |
| `title` | `terminal_title_stripped` | 已去掉行首状态字形（✳ ◐…）；UI 自己画状态点，字形不能再冒出来 |
| `cwd` | `foreground_cwd`，缺则 `cwd` | |
| `agent` | `agent` `name` `display_agent` `agent_session` `interactive_ready` | `null` = 普通 shell。`agent.session` 只给 `{kind, source}`，**路径/ID 不出宿主**（浏览器经 `/frames` 读 transcript，用不着） |
| `status` | `agent_status` | `working` `blocked` `done` `idle` `unknown` 五态；`unknown` 的文案是"未识别"，不推断 |
| `stalled` | 派生 | `working` 且有过输出且已 **180 秒**无输出；fixtures 与测试按这个阈值 |
| `completionSeq` | `completion_seq` | 单调。**已读游标只在浏览器本地**；未读 = `status === 'done' && completionSeq > 游标` |
| `stateChangeSeq` | `state_change_seq` | |
| `stateSince` `outputAt` | 宿主派生 | 进入当前状态的时刻 / 最近一次输出时刻（未知为 `null`）。宿主重启后 `stateSince` 取首次观察时刻，可能偏晚 |
| `summary` `summarySource` | 宿主派生 | ≤240 字的"正在干什么"，出处 `transcript` / `screen` / `none`；没有就是空串，**绝不编** |
| `writable` `writableReason` | 宿主派生 | 见下 |

`writableReason`（`writable === false` 时必有，否则为 `null`），**优先级从上到下**，内在原因压过瞬时原因：`not-an-agent`（普通 shell，永远只读）→ `policy-read-only` / `policy-dsh-only`（设置）→ `offline`（herdr 断了；横幅已经说明，恢复后自动消失）。

## 3. `GET /plugin/fleet/stream`（SSE，一页一条）

- `Content-Type: text/event-stream`。**每个浏览器页面只开一条**，页内所有视图共用（旧实现每个线程 tab 一条，撞 HTTP/1.1 连接上限）。
- 只有一种事件：`event: state`，`id: <State.revision>`，`data: <State 的单行 JSON>`。**每个事件都是完整快照**，没有增量、没有缺口、不需要补发。
- 连上即发一条；之后任何变化都发，宿主合并 120 ms 内的 herdr 事件。每 15 秒一行 `: ping` 心跳。
- 断线重连：浏览器带 `Last-Event-ID`，宿主**不重放**，直接先发当前完整状态；客户端无条件替换本地状态。
- herdr 断开时流不断，继续发 `stale: true` 的状态。
- pane 的 `revision` 变了，客户端才去补那个 pane 的 `/frames`（`after=<cursor.end>`）；屏幕视图可见时才轮询 `/screen`。

## 4. `GET /plugin/fleet/frames?pane=<id>[&before=<cursor>|&after=<cursor>][&limit=<n>]` → `FramesResponse`

规范化后的对话帧。`limit` 1–200，默认 80；`before` 与 `after` 互斥（都给 → `invalid-request`）。

- 不带游标：最新一窗。`hasEarlier` 为真时用 `before=<cursor.start>` 向前翻页。
- `after=<cursor.end>`：只要之后追加的；没有就是空数组。`reset: true` 表示 transcript 被改写/截断/换了会话——**丢弃本地帧，以本响应为新的末尾**。
- `partial: true`：文件很大，宿主只解析了尾部窗口，首帧可能落在对话中间（不是错误）。`unknownFrames`：被规范化器跳过的未识别条目数，只当计数，**绝不当内容渲染**。
- `cursor.start/end` 是不透明字符串，空响应时都是 `null`。帧 `id` 跨请求稳定、在一份 transcript 内唯一，客户端据此去重。

**`source` / `reason` 自报来源**（缺数据要说明原因，不留空白）：

| `source` | `reason` | 含义 |
|---|---|---|
| `transcript` | `null` | 帧来自 agent 自己的会话文件（目前支持 pi / claude / codex） |
| `screen` | `no-transcript` | 该 agent 受支持，但找不到它的会话文件 |
| `screen` | `not-yet` | 刚启动，还没有记录 |
| `screen` | `unsupported-agent` | 没有这种 agent 的 transcript 适配器 |
| `screen` | `unreadable` | 文件在但读不了/解析不了 |
| `none` | 同上 | 既没有 transcript，也没有屏幕可退（典型：herdr 断了） |

`screen` = 无记录，客户端改展示实时屏幕视图；帧数组此时为空。

**帧类型**：`session`（头：`sessionId`、`cwd`）· `text`（`role` 为 `user`/`assistant`/`system`，`text` 是 markdown，`at` 可为 `null`）· `reasoning`（默认折叠）· `work`（一组工具动作：`summary`、`rows[{verb, object, outcome, ms}]`、`tokens`；`outcome` 为 `ok`/`error`/`null`，`null` = 还在跑）· `final`（一轮结束：`text`、agent 原始的结束 `reason`、`ms`）。

## 5. `GET /plugin/fleet/screen?pane=<id>` → `ScreenResponse`

`format` 恒为 `ansi`：可见屏幕，行以 `\n` 连接，**只含 SGR 转义**（客户端自写解析器，其余 CSI 忽略）。`cols`/`rows` herdr 不报时为 `null`。`revision` 是读屏那一刻的 pane revision，**用户据此决定下一步时，原样放进 `expectRevision`**。herdr 不可达 → `herdr-offline`。

## 6. `POST /plugin/fleet/act` → `ActResponse`

请求是闭合对象，按 `verb` 分派到 `<Verb>Request`（`ActRequest` 的 `oneOf` 供 schema 使用者对照，宿主按 `verb` 分派才能给出精确错误）。响应：`{ok:true, verb, pane, revision}`，`revision` 是动作后的 pane revision（拿不到则 `null`）。

| `verb` | 字段 | 语义 | 状态前置 | `confirm` |
|---|---|---|---|---|
| `prompt` | `pane` `text`(1–20000) | 向 agent 发一条新指令（等同在其终端输入并回车）；agent 在 working 时由 agent 自己排队 | 不能是 `blocked` | — |
| `answer` | `pane` `text`(1–2000) `enter` `expectRevision` | 回答 agent 正在等的问题（自由文本，`enter` 为真则随后回车） | 必须是 `blocked`，且 revision 未变 | — |
| `keys` | `pane` `keys`(1–8，白名单) `expectRevision` | 按键序列，用于审批（`1`/`y`/`enter`/`esc`…）与屏幕视图的按键条 | revision 未变 | — |
| `interrupt` | `pane` | 中断当前工作 | — | — |
| `rename` | `pane` `name` | 设置 agent 名，规则 `[a-z][a-z0-9_-]{0,31}` | — | — |
| `restart` | `pane` `confirm` `thenPrompt`? | 重启 agent 进程，可选地在重启后发第一条指令 | — | **必须 `true`** |
| `close` | `pane` `confirm` | 关闭 pane | — | **必须 `true`** |

- **只写 agent pane**；普通 shell 只读（`not-an-agent`）。
- **`confirm` 严格等于布尔 `true`**：`"true"`、`"yes"`、`1`、`false`、缺省，一律 `confirm-required`。
- **按键白名单**（`keys` 的每一项都必须在内；加号和弦，不接受别的写法）：`enter` `esc` `tab` `shift+tab` `up` `down` `left` `right` `space` `backspace` `ctrl+c` `ctrl+d` `y` `n` `1` `2` `3` `4`。`ctrl-c` 这类连字符写法不在 herdr 的按键文法里，会被拒绝为 `key-not-allowed`。
- **`expectRevision` = 不盲打**（有意设计，理由与禁忌见文首「刻意为之的约束」）：用户基于哪个版本的屏幕做的决定，就带那个 revision；pane 已经变了就 `screen-changed`，客户端重读屏幕让用户再看一眼。代价是 working 中的 pane 因输出不断而常触发它——这是有意的，working 中想停用 `interrupt`。
- **保留给 P2，v1 不接受**（`unknown-verb`）：`spawn`（派活）、`connect`、`presets`。静音、置顶是纯客户端状态（localStorage），不是宿主动词。

### 请求校验顺序（第一条失败即定论）

1. 传输层（§1）：`forbidden` → `method-not-allowed` → `unsupported-media-type` → `payload-too-large`。
2. 不是对象或没有字符串 `verb` → `invalid-request`。
3. `verb` 不在上表 → `unknown-verb`。
4. `restart`/`close` 且 `confirm !== true` → `confirm-required`（**先于其余字段错误**）。
5. `keys` 里有不在白名单的键 → `key-not-allowed`（先于通用形状错误）。
6. 其余字段按 `<Verb>Request` 校验（必填、长度、闭合对象）→ 失败是 `invalid-request`。
7. 需要状态的检查，依次：`unknown-pane` → `not-an-agent` → `policy-denied` → `herdr-offline` → 动词专属（`prompt` 的 `agent-blocked`；`answer` 的 `not-blocked`；`answer`/`keys` 的 `screen-changed`）。

`test/contract.test.mjs` 里的 `classify()` 是第 2–6 步的可执行版本；`fixtures/fleet.json` 的 `act.invalid` 是它的一致性用例，宿主和 fixture transport 实现后必须对每一条给出**相同的 `reason`**。

## 7. 错误

| `reason` | HTTP | 何时 |
|---|---|---|
| `forbidden` | 403 | 来源不被信任 |
| `method-not-allowed` | 405 | 方法不对 |
| `unsupported-media-type` | 415 | POST 不是 `application/json` |
| `payload-too-large` | 413 | body 超过 256 KB |
| `invalid-request` | 400 | 形状不对、越界、多余字段、缺必填；`before`+`after` 同给 |
| `unknown-verb` | 400 | `verb` 不在白名单 |
| `unknown-pane` | 404 | pane 不存在（已关闭或 id 错） |
| `not-an-agent` | 409 | 目标是普通 shell |
| `agent-blocked` | 409 | `prompt` 打到 `blocked` 的 agent；改用 `answer`/`keys`。`detail.status` 给当前状态 |
| `not-blocked` | 409 | `answer` 打到没在等待的 agent（文字会落进普通输入框）；改用 `prompt` |
| `confirm-required` | 400 | `restart`/`close` 的 `confirm` 不是 `true` |
| `policy-denied` | 403 | 设置里的写权限策略不允许；`detail.policy` 给当前策略 |
| `key-not-allowed` | 400 | `keys` 含白名单外的键 |
| `screen-changed` | 409 | `expectRevision` ≠ 当前 revision；`detail.revision` 给当前值 |
| `herdr-offline` | 503 | herdr socket 不可达 |
| `herdr-error` | 502 | herdr 返回了错误；`detail.code` 透传，不含 prompt 内容 |
| `timeout` | 504 | herdr 在期限内没有响应 |
| `internal` | 500 | 宿主自己的缺陷；不暴露栈 |

`detail` 只是个对象，键按上表约定，不含用户输入。

## 8. Fixtures

`fixtures/fleet.json`：`{about, now, scenarios, act}`。每个场景是 `{state, frames, screens}`，`frames`/`screens` 以 pane id 为键，等于宿主会对该 pane 返回的响应。

| 场景 | 用途 |
|---|---|
| `busy` | 日常舰队：10 个 pane、3 个 workspace、五种状态俱全、1 个久无输出、1 个已完成（可未读）、6 种 agent（pi/claude/codex/grok/opencode/gemini）、2 个 shell；对话帧含 markdown/表格/代码/diff/链接/CJK/emoji/超长路径/推理/工具行/成败/进行中；屏幕含 SGR 与审批对话框 |
| `blocked` | 两个 agent 等你（一个工具审批、一个纯文字提问）+ 一个在跑 |
| `calm` | 全部空闲：「都处理完了」空态 |
| `empty` | herdr 在跑但只有一个 shell：「还没有 bot」空态 |
| `offline` | herdr 没在跑：「启动 herdr / 重新连接」空态 |
| `stale` | herdr 刚断：最后已知状态、全部只读、有「已断开 N 秒」；帧还在（文件），屏幕没有 |

**时间重基规则**：fixtures 里的时刻都是绝对 epoch 毫秒，围绕 `now`（2027-01-15T08:00:00Z）。客户端 transport 提供数据时，对下列键且仅对这些键加上 `delta = Date.now() - fixtures.now`（`null` 保持 `null`）：`now`、`stateSince`、`outputAt`、`lastOkAt`、`at`。时长（`ms`）不是时刻，不动。截图要稳定就取 `delta = 0`。`test/contract.test.mjs` 保证：任何 ≥1e11 的数字都在这五个键下，所以不会有"漏重基"的时刻。

`act.valid`：每个动词的合法请求，且相对 `busy` 场景**真实可执行**（pane 存在、可写、`expectRevision` 就是该 pane 当前的 revision）。`act.invalid`：被拒绝的请求与应得的 `reason`。**状态相关**的拒绝要有 pane 状态才能判定，fixtures 覆盖不了，所以**不在 fixtures 里**；它们由宿主批次（H1–H6）的假 herdr 单测和 fixture transport 自己的测试覆盖。

数据一律中性：路径是 `/Users/demo/…`，没有真实会话、prompt 或账号（测试会扫）。

### 宿主单测必须点名的拒绝

下面七项，宿主的假 herdr 单测要**逐条点名**（用例名里写出 `reason`），一项都不能漏。"herdr 没收到任何输入"指假 herdr 记录的请求里没有任何输入类方法——假 herdr 必须按方法记录收到的每个请求，供断言用。

| `reason` | 用例 | 断言 |
|---|---|---|
| `unknown-pane` | pane id 不存在，或已关闭 | 404；herdr 没收到任何输入 |
| `not-an-agent` | 对普通 shell 发每一个动词 | 409；herdr 没收到任何输入 |
| `policy-denied` | `read-only` 下发每一个写动词；`dsh-only` 下目标不是 DSH 创建的 agent | 403；`detail.policy` 正确；herdr 没收到任何输入 |
| `herdr-offline` | socket 不可达时发写动词 | 503；没有任何输入被发出 |
| `agent-blocked` | 对 `blocked` 的 agent 发 `prompt` | 409；`detail.status` 为 `blocked`；herdr 没收到任何输入 |
| `not-blocked` | 对非 `blocked` 的 agent 发 `answer`（working / idle / done / unknown 各一条） | 409；herdr 没收到任何输入 |
| `screen-changed` | `answer` / `keys` 带过期的 `expectRevision`（含"读屏之后 pane 刚好变了"） | 409；`detail.revision` 是当前值；herdr 没收到任何输入；**宿主没有自动用新 revision 重试** |

## 9. 改契约的流程

改 `contract.schema.json` → 改 `scripts/gen-fixtures.mjs` → `node scripts/gen-fixtures.mjs` → 改本文 → `node --test "test/**/*.test.mjs"` 全绿，同一个提交。`protocol`（现为 `1`）的规则：**只加可选信息**的改动不动它；改名、删除、改类型、改变枚举含义这类旧客户端会读错的改动要 +1，客户端遇到不认识的 `protocol` 要给出明确提示，而不是硬渲染。
