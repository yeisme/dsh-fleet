# BTW 辅助功能设计（v2 → v3）

> 2026-11-19 20:45。承接 `PANE-NATIVE.md` §21（v1 fork 面板）与 §22（v2 分栏 + 折叠）。
> 原则：**每个功能都要能回答「主线正在跑时，我为什么不用它」**——框架跟不上的功能一律不做。

## 0. 先修三个已实测的坑（v2.1，不叫新功能）

| # | 坑 | 证据 | 修法 |
|---|---|---|---|
| B1 | **分叉继承 plan/权限模式**：从 plan 模式会话分叉出的面板，输入框是「描述你的任务以生成计划」+`计划`徽标，不能直接问 | 2026-11-19 实测：打开 `…(6)` 分叉，`planPh: true`、`planBadge: 2`、composer「描述你的任务以生成计划 完全权限 计划」 | 客户端没有 plan 模式 setter（`dsh-api-session-controller` 合同里无此 RPC）。可行三条：① 分叉成功后调宿主的权限/模式切换（若存在 `session/set-mode` 类 RPC，需要先在 typert 目录里确认）；② 无法切换时，分叉面板顶部挂**一条黄色提示条**：「源会话在计划模式，此面板会先出计划；要直接回答请先退出计划模式」+「跳回原对话」；③ 分叉时给用户一个二选一（继承模式 / 强制普通模式），记进 fork 登记表 |
| B2 | **`⌥⌘J` 永远不分栏**：焦点不在右栏时 `focusedTarget()/commandTarget()` 都为 undefined，直接降级成同栏新标签，提示「没能定位当前栏位」 | 实测：主区聚焦时按 `⌥⌘J`，`panes` 始终 1 + 该提示；真实点击 guide 卡（焦点进侧栏）时才走到满额分支 | `openForkPaneBeside` 加第三级回退：`focusedTarget(anchor ?? null) ?? commandTarget(anchor ?? null) ?? sidebarRight.active()`（三个都是已核实存在的 API，`client.js:285` 已在用 `active()`）；三个都拿不到才报「右栏未打开」。注意 `dockPaneIds` 是 §22.1 里的想当然，宿主导出里**不存在**，不要照抄 |
| B3 | **每次分叉 = 一条新会话**，堆到 (1)…(6)，左栏污染 | 会话树实测 | 见 F7/F8 + `⌥⌘J` 语义改为「有已开的本会话分叉就聚焦，没有才新建」（强制另开走 `⌥⌘⇧J`） |

## 1. 功能清单（按「主线正在跑时值不值得用」排序）

### F1 选区即问（`⌥⌘'` 或浮动条）——P0

**问题**：读到主线某段看不懂，现在要先 Ctrl+C、再开分叉、再粘贴。
**交互**：在会话里划选文本 → 选区浮动条出现「问 BTW」→ 点击后分叉并从**选区前的完成轮次**带上下文，草稿预填 `> 选中的行`。
**实现要点（已核实）**：
- `uiConversation.interactions.register({ id, onInteraction(request) })`，`request.trigger === 'selection'`、`request.readText()`、`request.open()`——旧 `dsh-btw` 就是这么做的（`~/workspace/dsh-btw/client.js:282`）。
- 塞草稿用 `inputActions.setDraft`（v2 已在用）。
**边界**：选区跨消息取「选区所在消息之前」的完整轮次；取不到就只带选区文本。

### F2 带入范围选择——P0

**问题**：整段历史动辄几万 token，分叉一个「只问这一轮」的问题却拖进全部上下文。
**交互**：分叉面板的接续卡上加三档：`全部历史` / `最近一轮` / `仅选中消息`。
**实现要点**：`sessions.fork({ sessionId, atSeq })`——`atSeq` 是宿主已支持的**精确事件切点**（`dsh-api-session-controller/lib/index.js` 的 `fork()`：`boundary = atSeq ?? latestCompletedPrefixBoundary`）。接续卡从 `eventSource` 里数 `turn/start` 的 seq 即可算出三档。
**验收**：选「最近一轮」后，分叉面板的历史只有 1 轮，`带入 N 轮` 文案同步变。

### F3 合流（分叉 → 主线草稿）——P0

**问题**：分叉里问出的结论要手抄回主线。
**交互**：分叉面板每条 assistant 回答下有「送到主对话」（`⌥⌘L` 发最近一条）→ 主线 composer 上方出现 `插入 BTW 回答` chip → 点击作为**引用块**进草稿，**不自动发送**。
**实现要点（已核实）**：旧 `dsh-btw` 的 outbox 机制可整套复用（`client.js` 的 `publishAnswer/pendingAnswers/takeOldestAnswer` + `conversation.composer.dock` 槽 + `inputActions.insertQuote`）。
**边界**：跨会话只走内存 outbox（刷新即失效），需要持久就写进 fork 登记表。

### F4 分叉看板（一个主线 N 个工人）——P1

**交互**：命令面板 `⌥⌘Y` 打开浮层：列出本会话所有分叉（标题、状态点、轮数、最后活动），↑↓ 选、↵ 跳、`⌫` 关面板。
**实现要点**：`paneCursors`/`paneAttention` 已有四态；fork 登记表（v2 §22.4 的 `childId → {parentId,title,turns}`）提供关系；`uiWorkspace.openSession(id)` 跳主线，`sidebarRight.openResource` 跳面板。
**为什么值**：这是「btw 从玩具变工作台」的分水岭——你现在已经堆了 6 个分叉，缺的正是这个视图。

### F5 静音分叉（只读影子）——P1

**交互**：分叉时勾「只读（不改文件、不跑命令）」。面板颜色条变灰，工具集限制为读类。
**实现要点**：`sessions.fork` 只复制会话，不改工具；需要给子会话的 agent 换 preset 或注入「禁用写工具」的指令（`sessions.create` 支持 `agentPreset`，fork 不支持 → 只能靠提示词 + 事后审计）。
**诚实的结论**：**当前 API 无法真正降权**，只能做「软只读」（提示词约束 + 面板标记）。要做硬只读必须先有 fork-with-preset。

### F6 便宜模型分叉——P1

**交互**：分叉面板用的是廉价模型（如 `magpie group/daily`），主线继续用大模型。
**实现要点**：分叉继承源会话的 `provider/model`（`fork()` 里 `agentOptions` 取 `agentDefaultModel.currentSelection()`，不是源会话的）——**实际是取默认模型**，所以「分叉用便宜模型」的正确做法是把 fork 子会话的默认模型切过去，需要 session 级模型切换能力。当前只有 `/model` 斜杠命令（写进会话），可在分叉面板自动发一条 `/model …`？那是往对话里插指令，脏。
**结论**：P2，等 session 级模型 API。

### F7 分叉成树（左栏不污染）——P0

**问题**：6 个 `…(1)(2)(3)` 平铺在「未分组」，跟真实会话混在一起。
**交互**：左栏会话行给分叉加一个 `⑃` 标记 + 缩进挂在源会话下（或聚成「分叉（6）」可折叠组）；右键菜单「跳到源对话」「归档此分叉」。
**实现要点**：宿主 fork 不写 `parentSessionId`（§22.4 已确认），所以插件自己的登记表是唯一来源；左栏行装饰用 `sidebar.session.row.leading/trailing`（`dsh-client-ui-workspace` 已把这两个 list 槽暴露出来，见 `sidebar.workspaces` 的 children）。分组则需要宿主支持——**降级方案：只做行标记 + 「分叉」筛选器**。
**验收**：分叉行带 `⑃`，点它跳到源会话；筛选器「只看分叉」能一次列全。

### F8 分叉 TTL 回收——P0

**问题**：分叉会无限堆积（实测一下午 6 条），且每条都带完整历史（存储 + 列表噪音）。
**交互**：分叉闲置 N 小时（默认 12h）自动归档，归档前在主线发一条可撤销提示；设置项可关。
**实现要点**：`workspaceRegistry.archiveSession(sessionId)` 已有 RPC（`dsh-api-workspace-controller/lib/index.js:297`），客户端侧有 `uiWorkspace.archiveSession`。计时器用登记表的 `at` + 面板未挂载判定，仅当 `sidebarRight.openTabs` 里没有该分叉且会话 `running === false` 时归档。
**边界**：只归档**插件自己建的分叉**（登记表里有），绝不碰用户原会话。

### F9 分叉就绪聚合提示——P1

**交互**：主线 composer 上方一条细条：「2 条分叉已就绪 · 1 个在跑」，点开看板（F4）。
**实现要点**：`paneAttention(status, summary, binding, lastSeenSeq, resource)` 已实现四态；聚合时过滤 `session.parentId` 在登记表里的会话。

### F10 `/side` 斜杠命令（对齐 Codex）——P1

**交互**：输入 `/side 这个问题怎么看` → 分叉 + 自动在该面板发出这句话（`mode: 'queue'`）。
**实现要点**：客户端 `commandUi.register({ name: 'side', ui: { kind: 'action', run } })`——但 `btw` 名已被宿主 `/btw` 占用（同名会 fail loud，见 `dsh-client-ui-commands` 合同注释），所以用 `side` 新名，不抢 `/btw`。发消息用 `session.prompt(content, 'queue')`（客户端 `Session.prompt` 已支持）。
**注意**：这条不依赖重启宿主（纯客户端注册）。

### F11 键位速查浮层——P2

`⌥⌘/` 打开，内容从 `ctx.shortcuts.catalog` 动态生成 + 本插件 id 置顶高亮。永远不手写键位表（会跟用户改键脱节）。

## 2. 落地顺序（建议）

| 批次 | 内容 | 理由 |
|---|---|---|
| v2.1（修坑） | B1 提示条、B2 三级回退、B3 复用语义 | 现在用起来最硌手的三处，都是小改 |
| v2.2（闭环） | F3 合流、F7 行标记、F8 TTL | 一次把「分叉 → 结论回主线 → 不留垃圾」打通 |
| v3.0（工作台） | F4 看板、F9 聚合提示、F1 选区即问 | 从「一个面板」升级为「多面板作业」 |
| 待定 | F2 带入范围、F5 软只读、F6 便宜模型、F10 /side、F11 速查 | F2 有宿主 `atSeq` 支撑最靠谱；F5/F6 受 API 限制，先说清楚再动 |

## 3. 明确不做

- **不做 leader 键**、不做 vim 模式（Codex 有 `toggle_vim_mode`，但你不用 vim，白增复杂度）。
- **不做「分叉自动跑测试/改代码」**：那是 Agent Teams 的活，btw 的定位是「问得快、回得来」。
- **不改宿主 DOM 做分栏**：v2 已经用官方 `split()`，不要退回 DOM 手术。


---

## 4. 排期（2026-11-19 20:5x 落库，herdr 任务库）

| 波次 | 任务 id | 内容 | 面板 | 状态 |
|---|---|---|---|---|
| v2.1 | `T-btw-v21-fixes` | 三坑：B1 plan 提示条 / B2 三级回退 / B3 分叉复用 | `w2:p5`（pi，magpie group/coding） | 已派发 |
| v2.2 | `T-btw-v22-closeup` | 合流 F3 + 行标记 F7 + 闲置归档 F8 | 待定 | 排队（等 v2.1 合入） |
| v2.3 | `T-btw-v23-keymap` | `BTW-KEYMAP.md §4` 全部键位落地 | 待定 | 排队（等 v2.2） |
| v2.1b | `T-btw-v21b-defects`（待建） | 登记表不落盘 / `panechat.branch` 绑定失效 / 分栏 target 仍取不到 | — | 待排 |
| F12 | `T-btw-f12-fold` | 折叠只藏带入历史、发消息永不自动展开（§5） | `w1:pP`（claude，frontend lane） | 已派发 2026-11-21 09:5x |

**为什么串行**：三个波次都只改 `client.js` 一个文件，并发改必冲突；herdr 的仓库锁 + `git_paths_only` 断言都按「一次一个人动这个文件」设计。

**每波的主 agent 验收**（不由面板自证）：

1. 刷新页面 → bundle rev 变化（免重启生效）。
2. v2.1：主区聚焦按 `⌥⌘J` → 提示文案应是「右栏已占满两个窗口 / 右栏未打开」，不再出现「没能定位当前栏位」；分叉面板顶部出现 `data-dsh-fork-planwarn`；连按两次 `⌥⌘J` 不再新增会话。
3. v2.2：分叉里「送到主对话」→ 主线 chip → 插入草稿（不自动发）；左栏分叉行有 `⑃`；短 TTL 下闲置分叉被归档且可撤销。
4. v2.3：`⌘/` 速查表里出现新 id，键位与设计表一致；冲突项以实测兜底键为准并回填到 §4。


---

## 5. F12 折叠语义重设计：折叠只藏「带进来的历史」，永不自动展开（2026-11-21）

### 5.1 现象与根因

主人反馈：**「目前折叠后，输入信息后又会突然展开」**。

根因在 `client.js:1476-1484`（v2 写的自动展开）：

```js
const speaking = paneSession?.running === true || (paneSession?.pendingSubmissions?.length ?? 0) > 0
useEffect(() => {
  if (paneId === undefined || !folded || !speaking) return
  setFolded(false)              // ← 一发言就展开
  setForkExpanded(paneId, true) // ← 还把这当成用户意愿写进登记表
}, [paneId, folded, speaking])
```

两个设计错误：
1. 把「我要在这问一句」当成「我要看 5 轮历史」——用户收起历史是为了**少看上下文**，不是为了少输入。
2. 展开后写 `expanded: true` 持久化，于是**收起点被永久覆盖**，下次打开还是全展开。

### 5.2 新语义

> 折叠 = 只隐藏「分叉时带进来的那部分历史」。本面板里新说的话、新回答，任何情况下都可见。

- 用户在这个面板里发消息 → 不改变折叠状态，新一轮直接出现在卡片下方。
- 折叠状态只由两个动作改变：点卡片「展开历史」、按 `⌥⌘H`。
- 折叠态卡片文案改成「历史已收起（只显示本轮）」，让语义自解释。

### 5.3 判定数据（实测，2026-11-21 宿主 80843）

主区会话 DOM 实测：

| 事实 | 值 |
|---|---|
| 消息流容器 | `[data-conversation-scroll] > [data-slot] > …`（嵌套 slot，**层级不固定**，按 index 藏不可靠） |
| 每行带 turn 号 | `data-chat-turn="30"`、`data-chat-flow-key="9:turn-tail30"`、`data-chat-flow-kind="turn-tail"` |
| turn 号性质 | **单调递增整数**，实测当前挂载 26–30（窗口化只渲染最近 5 轮） |
| 行条数 | 单会话 146 个 `[data-chat-turn]` 节点（一 turn 多行：user/tool/assistant） |

所以判据用**阈值**而不是序号：`turn <= cutoff` 的行属于「带进来的历史」，隐藏；`turn > cutoff` 的行是本面板产生的，永远显示。窗口化后加载的旧 turn 也自然落在阈值下被隐藏。

**已在分叉面板内复验**（2026-11-21 10:0x，宿主 80843，`⌥⌘J` 开分叉后）：`[data-dsh-pane-chat]` 带 `data-dsh-fork="folded"`，内部同样有 **146 个 `[data-chat-turn]` 节点、turn 26–30**（与主区同构）。折叠引擎直接工作在 pane 根节点内即可，不需要跨容器取数。


### 5.4 实现要点

1. **收起点采样**：点「收起历史」那一刻取 `cutoff = max(data-chat-turn)`（没有 turn 行就取 0），写进 fork 登记表 `cutoff` 字段。
2. **标记隐藏**：对该 pane 内所有 `[data-chat-turn]` 节点，`Number(el.dataset.chatTurn) <= cutoff` 的加 `data-dsh-fork-hid=""`；CSS 一条规则收口：
   ```css
   [data-dsh-fork-hid]{display:none !important}
   ```
   不用内联 `style.display`：React 重渲染会覆盖内联样式，加属性则会被我们下轮扫描补回。
3. **MutationObserver**：监听 pane 根节点的 subtree childList，新增行立刻按阈值判定（流式输出/翻历史都会新增）。观察器在 pane 卸载时 disconnect。
4. **展开**：删除该 pane 全部 `data-dsh-fork-hid`，登记表 `expanded=true`。
5. **删除自动展开**：删掉 `client.js:1476-1484` 整段 effect 与 `setForkExpanded(paneId, true)` 调用。
6. **挂载复原**：登记表 `expanded=false` 时按 `cutoff` 重放隐藏（cutoff 缺失则取挂载时的 max turn，等价「先全藏」）。
7. **非分叉面板**：`forkOf(paneId) === undefined` 时完全不介入（不注册观察器、不加属性）。

### 5.5 边界

- 分叉里**已经**聊过几轮后再收起：cutoff 取当时的 max turn，已聊的内容也归入「历史」被藏；这是自洽的（用户点的是「收起」）。
- 老登记表没有 `cutoff` 字段：按挂载时 max turn 兜底，不报错。
- 懒加载更早历史（向上滚动）：新加载的 turn 号更小 → 被隐藏；用户此时点展开即可看全。

### 5.6 验收

| # | 断言 |
|---|---|
| F12-1 | 折叠态在 composer 发一条消息后，`[data-dsh-fork="folded"]` 仍存在、卡片文案仍是「历史已收起」 |
| F12-2 | 新一轮的行可见（该 turn 号 > cutoff），旧轮的行 `display:none` |
| F12-3 | 刷新页面后仍折叠（登记表 `expanded=false` 且 `cutoff` 有值） |
| F12-4 | 点「展开历史」后全部可见，且刷新后仍展开 |
| F12-5 | `⌥⌘H` 与卡片按钮行为一致 |
| F12-6 | 非分叉的普通 panechat 面板不出现 `data-dsh-fork-hid` |
| F12-7 | 代码里不再有 `speaking` 触发的自动 `setForkExpanded` |


### 排期修订（2026-11-21）

F12 与 v2.2/v2.3 都改 `client.js`，但 F12 是**体验级阻塞**（主人每次发言都被强行展开），优先级高于 v2.2 的功能补齐，故插队为独立一波，先派 claude（frontend lane）。

**必修前置（2026-11-19 验收遗留，至今未修）**，建议并入 v2.1b：

1. **登记表写到 `localStorage["undefined"]`**（2026-11-21 10:2x 实测钉死，不是假阴性）：
   - 现象：`dsh-threads:forks:v1` 为 null，但 `Object.keys(localStorage)` 里有键 `"undefined"`，其值是 2 条合法记录（`{id, at, cutoff:30, expanded:false}`）。
   - 根因：`FORK_STORE_KEY` 用 `var` 声明（v2 为躲 TDZ 而改），提升后为 `undefined` 直到执行到赋值行；`apply()` 若在 factory 体跑到那行之前被 Cordis 调用，`setItem(FORK_STORE_KEY, …)` 就成了 `setItem(undefined, …)`。与第二次踩的 `Cannot access 'forkRegistry' before initialization` 同源。
   - 修法：键名改成 `function forkStoreKey() { return 'dsh-threads:forks:v1' }`，读写都走函数调用（与初始化顺序无关），删掉 `var FORK_STORE_KEY`；启动时若 `localStorage['undefined']` 是合法数组，并入正式键后 `removeItem('undefined')`（已有真数据，别丢）。
   - 影响面：F12 的 `cutoff`/`expanded` 全存在这张表 → 不修则刷新即回默认，折叠永远不持久。
2. **`panechat.branch`（⌥⌘⇧J）无反应**：`tryRegister` 静默跳过，需在回报里列出实际生效键位，或退化为仅命令面板可用并明说。
3. **分栏 target 仍取不到**：三级回退加了 `active()` 仍落「右栏未打开」，需要改成对 `mounted` 的第一个 docked pane 直接 `split`。


### 5.7 验收结果（2026-11-21 10:5x，宿主 80843，commit `13f7e48`）

主人报的「折叠后输入信息又突然展开」已修好，逐条实测：

| 断言 | 实测 |
|---|---|
| F12-1 折叠态发消息后仍折叠 | ✅ `data-dsh-fork="folded"` 不变，卡片仍「历史已收起（只显示本轮）」 |
| F12-2 旧轮隐藏、新轮可见 | ✅ 旧轮 27–30 共 109 行全部带 `data-dsh-fork-hid`；新轮 31 的 7 行可见 |
| F12-3 刷新后保持 | ✅ 仍 `folded`，登记表 `expanded=false, cutoff=30`，turn 31 仍可见 |
| F12-4 展开 | ✅ `open`、隐藏清零、登记表 `expanded=true` |
| F12-5 再收起 | ✅ `cutoff` 30→31（含刚聊的轮）、隐藏 116 行 |
| F12-7 自动展开删净 | ✅ `grep -c speaking client.js` = 0 |
| 键名迁移 | ✅ `localStorage["undefined"]` 已删，正式键 `dsh-threads:forks:v1` 有 2 条 |
| 控制台 | ✅ `command.label` 报错 0 次 |

**补充说明**：刷新后隐藏行数从 146 降到 109 不是漏标 —— 窗口化只挂载了最近 4 个历史轮（27–30），阈值判定对「已挂载的」全命中；向上滚动加载更早的轮同样落在 `cutoff` 之下。


---

## 6. v2.1b：`⌥⇧⌘J` 静默 + 分栏永远「右栏未打开」（2026-11-21 12:1x 实测）

### 6.1 现象

| 动作 | 结果 |
|---|---|
| `⌥⌘J`（分叉面板） | 分叉建出来了，但提示「右栏未打开，分叉已开在同一栏的新标签里」——而右栏**明明开着**（`[role=tablist]` = 2，5 个默认 tab 在位） |
| `⌥⇧⌘J`（强制分叉面板） | **完全静默**：不建分叉、不建 tab、无提示、无报错 |
| `⌘/` 速查表 | 两条都已注册（「强制分叉面板 ⌥⇧⌘J」「收起/展开分叉历史 ⌥⇧⌘H」） |

### 6.2 根因

两条都卡在同一个判据：`sidebarRight.mounted.getSnapshot()`。

```js
async function openContinuationFrom(owner, sourceId, noticeSession = owner, anchor, { force = false } = {}) {
  if (scope.sidebarRight.mounted.getSnapshot() !== owner || pending.has(owner)) return   // ← 静默 return
  ...
}
```

- `mounted` 只在「右栏由某会话主动打开」时有值。刷新后右栏从 localStorage **恢复布局**（tab 还在、`openTabs` 有内容），但 `mounted` 是空的。
- 于是在这种状态下：`⌥⌘J` 走的是「没匹配到 owner」的分支却仍然建了分叉（说明它走了另一条路径），最终 `splitBlock` 判 `stale` → 落到「右栏未打开」文案；`⌥⇧⌘J` 则被第一行直接 return，连提示都没有。
- `focusedTarget()/commandTarget()/active()` 三级回退也都没取到目标（与 `mounted` 同源，都依赖右栏的「当前挂载会话」而不是「当前有 tab」）。

**结论：判据把「右栏有布局」误判成「右栏没打开」。** 真机证据：`strips=2`、5 个 tab 在、`panes=1`（分叉确实开了），但文案说没打开。

### 6.3 修法

1. **判据改成看布局，不看 mounted**：
   - 「右栏是否可用」= `sidebarRight.isExpanded() === true` 且 `openTabs.getSnapshot().length > 0`（或 `[role=tablist]` 存在）。
   - owner 的取法：`mounted.getSnapshot() ?? sessions.currentOrLastFocused() ?? sid`（用当前主区会话兜底），不要再因 mounted 为空而 return。
2. **目标 pane 的取法**加一层：「若 `focusedTarget/commandTarget/active` 全空，就取右栏第一个 docked pane」（从 `openTabs` 里第一个 `kind==='panechat'` 或默认 pane 推断），拿不到才报 blocked。
3. **静默不允许**：任何提前 return 的分支都要 `notify('info', …)` 说明原因（「右栏未打开」「正在分叉，请稍候」「目标会话已切换」），不再无声无息。
4. **`⌥⇧⌘J` 与 `⌥⌘J` 共用同一条 open 路径**，只在 `force` 上有差别；force 时不查 `openExistingFork`。

### 6.4 验收

| # | 断言 |
|---|---|
| P1 | 刷新页面（右栏布局被恢复、mounted 为空）后按 `⌥⌘J`：分叉建出、**不出现**「右栏未打开」文案 |
| P2 | 同一状态按 `⌥⇧⌘J`：必然新建一条分叉（不受已有分叉影响），且不静默 |
| P3 | 右栏真的关掉时（`⌥⇧⌘B` 收起）按 `⌥⌘J`：给出「右栏未打开」的**提示**，不是静默 |
| P4 | 分栏成功时 `[role=tablist]` 从 1 变 2（新 pane 在旁边） |
| P5 | 连续按 `⌥⌘J` 两次：第二次聚焦已有分叉，不新建（F12 之前的 B3 语义保持） |


---

## 7. 体验完善清单（2026-11-21 12:2x，按「主人今天被挡的频率」排序）

| 优先级 | 项 | 现在 | 目标 | 归属 |
|---|---|---|---|---|
| P0 | 右栏判据（v2.1b） | 刷新后按 `⌥⌘J` 误报「右栏未打开」；`⌥⇧⌘J` 静默 | 看布局不看 mounted；一切提前退出都给提示 | `T-btw-v21b-sidebar` 已派 |
| P0 | 结论回流主线（F3） | 面板只有「展开历史 / 跳回原对话」 | 每条回答下「送到主对话」→ 主线 chip → 引用块进草稿（**不自动发**） | v2.2 |
| P1 | 分叉行标记（F7） | 左栏 6 个 `(1)…(6)` 平铺，混在真实会话里 | 行加 `⑃` + 「只看分叉」筛选 | v2.2 |
| P1 | 闲置回收（F8） | 分叉无上限堆积，每条都带完整历史 | 12h 未打开且 idle → 自动归档，可撤销 | v2.2 |
| P1 | `⌥⇧⌘H` 折叠快捷键 | 已注册但未真机验过 | 与卡片按钮行为一致，含新语义（只藏带入历史） | 验收项 |
| P1 | 「加载更早」在折叠态无意义 | 折叠时仍显示，点它会触发历史加载（又被阈值藏掉，白加载） | 折叠态隐藏分页哨兵，展开时恢复 | v2.2 |
| **P0** | **面板空态引导** | **实测折叠后会话区只剩一条「加载更早」（`visibleTextLen=85`），像加载失败** | 折叠且本轮无内容时，在会话区渲染一行淡色占位：「历史已收起 · 在下面提问，本轮会显示在这里」；本轮有内容时不显示 | v2.2 |
| P2 | 分叉标题可读性 | 标题复制源会话名 + `(n)` | 面板 tab 前加分叉字形，一眼区分主线/分叉 | v2.2 |
| P2 | 折叠时新回答提示 | 折叠态有新回答时无提示 | 卡片 meta 加「本轮已更新」，或折叠态自动滚到本轮末尾 | v3 |

**不做**（明确排除，避免堆功能）：多级折叠、分叉内嵌分叉树、分叉自动跑测试/改代码——btw 的定位是「问得快、回得来」，重活走 Agent Teams。
