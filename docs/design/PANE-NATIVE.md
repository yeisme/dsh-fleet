# 面板即会话（Pane = Session）· 设计基线 v1

> 2026-11-19 · 针对 `@local/dsh-threads` 的下一版：右栏面板（pane）的输入框与「+ 新建面板」流程。
> 证据来源：本机 DSH 0.2.2-rc.3 安装源码（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/`）、`~/workspace/dsh-threads` 现状审计、Codex Desktop 26.1103 官方文档 + 本机状态文件。
> 与代码冲突时以本文为准；改设计先改这里。

---

## 0. 结论先行

**押三个注：**

1. **面板只承载 DSH 会话**（`ctx.sessions.create()` 建的真会话），面板体直接用 `conversation.content` Factory 的 `embedded` 变体渲染 —— 原生输入框（附件、@引用、斜杠命令、模型、权限、Plan、排队/插话、中断、审批）**免费全拿到**，一行 composer 代码都不用写。
2. **外部 pi/herdr 会话永远只读**，输入框**从只读面板里删掉**，底部换成动作条：「接着问 → 开新会话（原生输入框）」「复制上下文」。不再假装只读面板能追问。
3. **「+」不改成弹窗，改成接管右栏 guide 页**（`sidebar.right.tab.guide` 是 chain 替换缝）：Codex Desktop 式的一页式启动台 —— 搜索框 + 三组入口 + 最近 + 键位常显。

**为什么不是「把原生输入框抠出来用」**：它不是组件，是会话页的一部分。`conversation.composer` 是 `chain` 槽、`composer.bar` 是 `single` 槽，`InputBar` 从未被导出为公开组件，它的 props 需要 renderer 在槽位绑定时注入 9 个子槽 + 6 个 observable + locale（见 §2）。**任何「抠出来」的路都要 fork 宿主。**

**代价必须说清**：pi 面板里的历史不会被 DSH 会话继承。要延续上下文，只能把历史摘要作为首轮 prompt 的一段前缀塞进去（§4.4）。这是有意的：DSH 会话与 pi 进程是两套写者，共写同一份会话文件必炸（`index.js` 现在就有这条后门，见 §9 的 R5 与既有坑清单）。

---

## 1. 现状诊断（截图这一版）

截图里右栏两个 tab：`phone-run.sh`（外部终端 pane）+ 一条线程。线程面板从上到下是：标题行（`侧线` `线程列表`）、消息流、自绘输入框 `追问这个线程…`。

| 问题 | 具体 | 后果 |
|---|---|---|
| 输入框是仿的 | 一个 `textarea` + 发送按钮（`client.js:413-446`） | 与主页面输入框**肌肉记忆断裂**：表单一处有附件/@/斜杠，一处没有 |
| 能力缺口 21 项 | 附件、拖放、斜杠命令、@引用、引用 chip、模型选择、effort、权限档、Plan、排队、插话、失败重试、提交状态机、停止快捷键、草稿语义、图片渲染、富 markdown、历史分页、上下文占用、错误通道、送到主对话 | 用户被迫为「同一件事」记两套操作 |
| 只读面板给了输入框 | `bound` 时 textarea `disabled`（`client.js:425`），但形状仍在 | 语义错：**长得像能写，实际不能写** |
| 「+」是胶囊网格 | 右栏 guide 只列出各 tab 类型自带的 capsule（`GuideBody.tsx` 头注释） | 没有搜索、没有最近、没有「新建会话」这个概念、没有键位提示 |
| 线程不是会话 | 「侧线」= `~/.dsh/threads/pi/*.jsonl`，无 workspace、无 `session.lock`、不产生 `SessionReference` | 结构上就进不了原生会话页 |

**一句话**：这一版把「看历史」和「继续干活」塞进同一个面板，于是两者都做得不对。

---

## 2. 硬事实裁决：输入框能不能复用

| 路线 | 裁决 | 关键证据 |
|---|---|---|
| **A. 整块原生会话嵌进面板** | ✅ **可以**，产品内已有 50 行范本 | `dsh-client-ui-subagent/src/client/sidebar-chat/index.tsx:129-198`：`renderFactorySlot('conversation.content',{variant:'embedded',…})` + `SessionProvider` 换绑 |
| **B. 单独 require `InputBar`** | ❌ **不可以** | ①组件未导出（`dsh-client-ui-conversation/lib/types/client/index.d.ts` 运行时导出里没有 `InputBar`）；②props = `PropsRenderSlots<9 个子槽> & InjectFace<ComposerBarInjected> & PropsLocale`（`contract/slots.ts:639-648`），只能由 renderer 注入；③`InputBar.tsx:1-4` 自述「我是 `conversation.composer.bar` 这个槽的条目」；④`require` 种子表冻结在 11 个 specifier，UI 包不在其中；⑤官方红线 `docs/subsystems/slots.md:5,225`「feature 插件从不到另一个 feature 插件里 import 组件/运行时值」 |
| **C. 自绘 composer，只借样式与行为** | 🟡 **半可以** | 样式是 CSS Module（`InputBar.module.css`），hash 后不可跨包引用；但 `input-trigger` 注册表（@ / 斜杠 / 手势）与 `shortcuts` 目录是公开面，可单独接 |

**结论**：走 A。B 是死路，C 是自我安慰——它只能让假输入框更像，不能让它真的能传图、能排队、能改权限。

**A 的五个卡点（必须设计绕法）**

| # | 卡点 | 绕法 |
|---|---|---|
| A1 | `sessions.retain` 只接受**宿主认识**的 id（`manager.ts:140-148` 未知即抛） | 面板只开 DSH 会话，不试图 retain pi 会话 |
| A2 | 同一会话两个原生 composer → **共用同一份草稿与队列**（`apply.ts:341-345,373`） | 面板会话 ≠ 主区会话：新建面板永远 `sessions.create()` 出新会话；打开「已在主区的会话」时只做**导航**不做第二渲染 |
| A3 | tab 的 `contentId` 必须是 `dsh-resource://` 地址，现成协议只有 `file`/`plan`/`subagentchat` | 自己声明一个 `panechat` 协议（declaration merge `ResourceProtocolMap` + `SessionReferenceSourceMap`，范本同上 `:29-38`） |
| A4 | `ctx.sidebarRight` 的写操作只作用于**当前在屏会话**（`sidebar-right.md:92`） | 面板新建走「先导航到该会话，再开 tab」，或使用实现类上的 `openTabIn(sessionId,…)`（未文档化，需实测） |
| A5 | 右栏 tab 是 per-session 的（`service.ts:118-120` `bySession[sessionId]`） | 这不是卡点，是红利：**Codex「每会话独立拓扑」DSH 原生就有**，开箱可用 |

---

## 3. 目标架构

### 3.1 三层模型

```
Surface  = 右栏一个 pane（可 split、可 float、可全屏）
 └ Tab   = 面板，kind ∈ { panechat(会话) | thread(只读外部会话) | file | plan | browser | terminal }
    └ Session = DSH 会话（panechat）／外部 JSONL 只读视图（thread）
```

**一条铁律**：同一个会话在一个窗口里**只允许一个原生渲染位置**（主区或面板，二选一）。不做「主区开着、面板也开着」——草稿会串（A2）。

### 3.2 新面板的代码骨架（照此实现，约 60 行）

```js
// 1) 资源协议：把 DSH 会话 id 包成 dsh-resource 地址
ctx.resources.register({
  protocol: 'panechat',
  async *open(address, { signal }) {
    const id = parsePaneChatAddress(address)            // dsh-resource://panechat/session/<id>
    const reference = ctx.sessions.retain(id, { source: 'paneChat', signal })
    try { yield { ok: true, value: { id, reference } }; await waitAbort(signal) }
    finally { reference.release() }
  },
})

// 2) tab 类型 + 主体（keyed slot，按 definition.id 分派）
ctx.sidebarRightTabs.register({
  id: PANECHAT_ID, kind: 'panechat',
  patterns: ['dsh-resource://panechat/**'],
  priority: 'extension',
  canOpen: a => parsePaneChatAddress(a) !== undefined,
  title: a => titleOf(ctx.sessions.list.getSnapshot(), parsePaneChatAddress(a)),
  guide: [{ id: 'new-session', order: 10, title: () => '新建会话', description: () => '选目录与预设，直接开一个新面板' }],
})

ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PANECHAT_ID,
  children: { 'panechat.conversation': { kind: 'single', scope: 'session' } } },
  function PaneChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
    const { tab } = useTabInfo()
    const resource = useResource('panechat')(tab.contentId)
    if (resource.value === undefined) return null
    return h(SessionProvider, { session: resource.value.reference },
      renderSlot('panechat.conversation', {}))
  })

// 3) 面板体 = 原生会话（embedded），原生 composer 自带
ctx.slots.register({ name: 'panechat.conversation' },
  function PaneConversation(props) {
    const session = props.useSession(s => s)
    const active = session.running || !session.blank
    const phase = active ? 'active' : 'hero'
    return props.renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero: phase === 'hero' },
      { slots: { views: FixedChatView } })     // views = 只渲染 chat，不给 trajectory 切换
  })
```

### 3.3 「新建会话面板」一步到位

```js
const id = await ctx.sessions.create({ cwd, agentPreset })   // 同 cwd 会复用可复用的 blank 会话
ctx.sidebarRight.openResource(`dsh-resource://panechat/session/${id}`)
```

`create(opts)` 的语义（`sessions.d.ts:76-90`）：Host 会**复用同名可复用的 blank 会话**，否则新建；返回 catalogued id，**先 retain 再借 binding**。

---

## 4. 「+ 新建面板」= Codex Desktop 式启动台

### 4.1 机制：接管 guide 页，而不是自造弹窗

`sidebar.right.tab.guide` 是 **chain 槽**（`contract/slots.ts:84-89`），官方注释写明：「a product with its own idea of what an empty sidebar should say registers into it, and its entry takes the whole body」。点 `+` 的本质是 `openTab('guide')`（`SidebarRight.tsx:180`），一个 pane 最多一个 guide tab。

**所以：注册一个 chain entry → 我们拿到整页，宿主逻辑一行不改。** 兜底仍是原生胶囊网格（我们的 entry 只在有会话/有候选时接管）。

**今天没人占这个缝**（实测 slot catalog：`key: 'sidebar.right.tab.guide'`，`occupants: []`，`replaceRisk: 'none'`），所以不存在抢位问题。

**白捡的两个能力**：guide 体的 standardProps 里带着 `useSessionStatus`、`useSessionRetainInfo`、`useSessions`（`@deepseek-ai/dsh-cordis-client-runner/src/client/slot-catalog.ts:4888` 起的 `key: 'sidebar.right.tab.guide'` 段）——启动台能直接显示每条会话的**实时状态点**与运行时长，不用另建轮询。

> 实现期可用 `cordis_inspect what:"client"` 查这个槽的活体契约；`replaceRisk` 与 `occupants` 都以活体为准。

### 4.2 结构（一页、三段、零弹窗）

```
┌───────────────────────────────────────────────┐
│  ⌕  想开什么？                        ⌘N 新建   │  顶部搜索（自动聚焦，输入即过滤）
├───────────────────────────────────────────────┤
│  新建                                          │
│   ⊕ 新会话           选目录 + 预设    ⌘N        │
│   ▣ 新终端           在当前目录      ⌘\`       │
│   ◫ 新浏览器 tab                    ⌘⌥T       │
├───────────────────────────────────────────────┤
│  打开                                          │
│   最近 3 个会话：标题 · 目录 · 3 分钟前           │
│   最近工作区                                    │
├───────────────────────────────────────────────┤
│  只读                                          │
│   ⧉ herdr 面板 · phone-run.sh · 运行中 · 17.0s  │  ← 点开 = thread tab（无输入框）
├───────────────────────────────────────────────┤
│  键盘：↑↓ 选择 · ↵ 打开 · esc 关闭              │
└───────────────────────────────────────────────┘
```

**三条规则（抄 Codex，别抄错）**

1. **浏览靠分区、检索靠拍平**：空输入显示三组分区；一旦输入 1 个字符，全部拍平成单一列表（Raycast 规则）。`参考资料/REFERENCES` 同理。
2. **每个入口右侧常显自己的键位**（教用户偷懒）。
3. **不做第二个弹窗**：所有建面板的动作都在这一页完成，不叠 modal。Codex 的 `New chat` 直接进新对话页、不弹框——这条必须抄。

### 4.3 交互规格（逐条：触发 → 反馈 → 边界）

| # | 场景 | 触发 | 反馈 | 边界 |
|---|---|---|---|---|
| G1 | 点 `+` | 点 tab strip 右侧 `+` | guide 页出现，搜索框聚焦，光标在框内 | 已有 guide tab 时 `+` 隐藏（宿主行为，不改） |
| G2 | 直接新建会话 | `⌘N` 或回车「新会话」 | 新会话面板立刻出现（hero 空态），焦点在 composer | 不弹目录选择器；目录沿用「上一次选择」（Codex 的 `new-task-project-by-computer` 同款记忆） |
| G3 | 换目录新建 | 在 guide 里点「新会话」右侧的目录 chip | 目录选择浮层（玻璃浮层，唯一允许的浮层） | 36px 以下不出现浮层，改为整页替换 |
| G4 | 打开最近会话 | 点最近项 | 该会话在主区打开（导航），并**关掉 guide** | 若该会话已在面板里 → 聚焦那个 tab，不新建 |
| G5 | 打开只读线程 | 点 herdr 面板项 | 开 `thread` tab；底部无输入框，动作条「接着问 · 复制上下文」 | 只读标记 `⧉` 必须常显，不能只靠 disabled |
| G6 | 搜索 | 输入 | 立即拍平过滤；无结果显示「没有匹配。新建会话？」+ `⌘N` | 不做防抖（本地数据） |
| G7 | esc | 按 esc | 关闭 guide tab，回到原 tab | 不能把整个右栏关掉 |

### 4.4 只读线程的「接着问」

- 动作：把该线程最近 N 条（默认 20）消息压成一段 `<外部会话上下文>` 前缀 → `sessions.create()` → 把前缀塞进新会话的**草稿**（不自动发送）→ 开面板 → 用户在原 composer 里补自己的问题。
- 文案：`接着问` → hover 提示「开一个新会话，带上这条线程的最近 20 条」（把代价写在按钮上）。
- 边界：超长上下文截断到 8k 字符（对齐 `MAX_MESSAGES` 的截断策略，别偷偷塞几十万 token）。

---

## 5. 面板内的信息架构

### 5.1 tab strip（一个面板一行，36px）

| 元素 | 规格 |
|---|---|
| 图标 | 会话：agent preset 的图标（缺失用方块占位）；终端：`>_`；只读线程：`⧉` 套在线程图标外 |
| 标题 | 会话标题（Host 投影 `projectionValues.<preset>.label` 优先，退化到会话标题）；**只读线程一律前置 `⧉`**；截断保留前 18 字符 + 省略号 |
| 状态点 | 6px，贴标题左侧，只在非 idle 时出现（见 5.2 四态） |
| 运行时长 | 悬浮才出现，不常显（常显会跟状态点抢注意力） |
| 关闭 | `×` 仅 hover/focus 出现；中键关闭始终可用 |
| 拖拽 | 面板内可重排（宿主已支持？未证实 → P1 实测，不做就先不承诺） |

### 5.2 四态（直接抄 Codex 的词表，映射到 DSH 投影）

| 态 | 英文原文 | 判定（DSH） | 视觉 | 说明 |
|---|---|---|---|---|
| 运行中 | Running | `session.running === true` | 蓝点 + 呼吸（2s，仅点） | 面板内 hero 撤掉，显示过程 |
| 等你 | Needs input | `pendingInteraction` 非空 / 有审批 | 琥珀点 + 该行整行底色 3% | **必须常显**，不能只弹 toast |
| 就绪 | Ready | 完成且有未读 | 绿点，进入即清 | 完成 = 有终态 |
| 卡住 | Blocked | `promptError` 非空 | 红点 | 红点必须能点开看原因 |

优先级：**Needs input > Blocked > Ready > Running**（Codex 的 `pets.md` 原文顺序）。

> 这一套必须**贯穿**：tab 状态点、侧栏行、`⌘⌥A` 跳下一个待处理、系统通知。只做 tab 点是浪费。

### 5.3 面板内的三段形态

| 形态 | 出现条件 | 内容 | 禁止 |
|---|---|---|---|
| hero（空态） | `blank && !promptAttempted` | 原生 composer（hero 变体）+ 3 个起手胶囊（按 cwd 推断：接着上次 / 跑测试 / 看 diff） | 禁「欢迎使用」大字、禁插画 |
| active（运行） | 有 turn 或 `running` | 消息流 + composer + 队列 chip（在 composer 上方） | 禁百分比进度、禁骨架屏闪烁 |
| readonly（只读线程） | `kind==='thread'` | 消息流（无 composer）+ 底部动作条 | **禁渲染输入框**，包括 disabled 的 |

### 5.4 完成态做减法

答案出现后：撤掉 Stop、把过程折叠成一行（「12 步 · 1m12s」）、队列 chip 消失、状态点转 Ready 并在 800ms 后淡出（未读态由侧栏承载）。**面板里不重复侧栏的未读红点。**

---

## 6. 键盘

| 动作 | 键 | 状态 | 理由 |
|---|---|---|---|
| 新建会话面板 | `⌘N` | **空** | 实测全仓无 `KeyN` 绑定；Codex 同键 |
| 打开面板选单（guide） | `⌘⇧N` | **空** | 与 `⌘N` 成对，不抢宿主键 |
| 关闭当前 tab | `⌘W`（desktop）/ `⌘⌥W`（web） | 已占用 | 沿用 `page.close`，不自造 |
| 跳下一个待处理面板 | `⌘⌥A` | **空** | 抄 Codex，多面板并行的核心键 |
| 面板内分屏 / 全屏 | `⌘\` / `⌘⌥↵` | 已占用 | 沿用宿主 |
| 右栏开关 | `⌘⇧B`（web） | 已占用 | **不要**再拿它做「布局循环」（Codex 是 `⌘⇧B`，这里必须让位） |
| 新浏览器 tab | `⌘⌥T`（web）/ `⌘T`（desktop） | 已占用 | guide 里常显即可 |
| 聚焦 composer | 无 | — | **不新增**：进入面板即聚焦（`⌘N` 后直接可打字），比记键位更省 |

原则：**只新增 2 个键**（`⌘N`、`⌘⇧N`）+ 1 个导航键（`⌘⌥A`）。其余全部沿用宿主。Codex 自己也只靠 `⌘N` 这一个主键，其余是给重度用户的。

---

## 7. 视觉与动效（现代 macOS，玻璃只上浮层）

| 项 | 规格 |
|---|---|
| 底色 | 面板 `--dsw-alias-bg`；tab strip 与内容区之间 **0.5px 发丝线**，不加阴影 |
| 强调色 | 单一 `#0A84FF`，只用于：选中 tab 的下边线（2px）、主操作按钮、焦点环 |
| 状态色 | 蓝 `#0A84FF` / 琥珀 `#FF9F0A` / 绿 `#30D158` / 红 `#FF453A`，**只出现在 6px 点**，不染整行 |
| 玻璃 | 只用于两处浮层：目录选择浮层、`⌘K` 命令面板。正文、代码块、消息流一律不透明 |
| 圆角 | tab 6px、按钮 6px、浮层 12px、输入框 10px（沿用宿主 token，不自造） |
| 字阶 | 只有五级：17/590 面板标题、14/560 行标题、13/400 正文、12/400 meta、11/400 faint |
| 数字 | 全部 `tabular-nums` |
| 动效 | tab 切换 120ms ease-out（只动 opacity+translateY 2px）；状态点呼吸 2s；hero→active 160ms；**禁**骨架屏、禁持续脉冲光晕、禁百分比 |
| 减动效 | `prefers-reduced-motion` 下全部关掉（含呼吸） |

---

## 8. 落地分期与验收

### P0（最小可用，1 个面板类型 + 1 个启动台）

1. 新增 `panechat` 资源协议 + tab 类型 + 面板体（§3.2），**面板内出现原生 composer**。
2. `⌘N` → 新会话面板（hero 空态，焦点在 composer）。
3. guide chain entry：三段式启动台（新建 / 打开最近 / 只读线程），`↑↓ ↵ esc` 可用。
4. 只读 `thread` tab：**删掉输入框**，底部换「接着问 · 复制上下文」动作条。

**验收（可判定）**
- 面板内 composer 能拖入一张图并发出（原生能力，不是自绘）。
- 面板内输入 `/` 出现命令菜单；输入 `@` 出现引用候选。
- 面板内改模型/权限档，与主区同一会话的显示一致（同一份 session 状态）。
- 只读面板里**找不到任何输入框节点**（`document.querySelector('[data-pane-readonly] textarea') === null`）。
- `⌘N` 后可直接打字，无需再点输入框。
- 全程不出现第二个弹窗（除目录选择浮层）。

### P1（把「多面板」变成可用）

5. `⌘⌥A` 跳下一个待处理面板 + tab 状态点四态。
6. 面板标题/图标/未读与侧栏一致（单一数据源）。
7. 会话面板与主区互斥规则：打开已在主区的会话 → 导航而非第二渲染（A2）。
8. 面板宽度/高度记忆（per-session 拓扑宿主已有，验证是否随会话恢复）。

### P2（打磨）

9. 起手胶囊（按 cwd 推断 3 个）。
10. 「接着问」的上下文压缩（8k 上限 + 可见的截断提示）。
11. `claude` / `codex` 外部会话适配（只读），复用同一 `thread` tab。

### 明确不做

- ❌ 自绘 composer 的任何增强（要增强就去改 DSH 的 `conversation.composer` chain，那是全产品受益的正路）。
- ❌ 把 pi JSONL 桥接成 DSH 会话（写私有落盘格式，随版本必炸；见 §9 的 R5）。
- ❌ 面板内再嵌一套消息渲染（原生 `ChatView` 已含 markdown/fence/图片/工具卡）。
- ❌ 底部面板 / 浮动面板第二套落点（Codex 实测 453 份拓扑里 bottom 开启 0 次）。
- ❌ 布局三态循环键（`⌘⇧B` 已归宿主）。

---

## 9. 风险与翻车点

| # | 风险 | 触发条件 | 兜底 |
|---|---|---|---|
| R1 | **双 composer 草稿串台** | 同一会话在主区与面板同时渲染 | 硬规则互斥（P1-7）；先在 `sessions.create` 后按 id 查重，命中就导航 |
| R2 | `sessions.create` 复用 blank 会话 | 同 cwd 连续 `⌘N` 两次 | 期望行为（复用同一 blank），但**第二次必须聚焦已有 tab**，否则看起来"没反应" |
| R3 | `openTabIn` 未文档化 | 需要给非在屏会话开 tab | 只用 `openResource` + 先导航；`openTabIn` 只在实测通过后用，并写注释标明未文档化 |
| R4 | guide chain 被别的插件抢 | 未来装第二套「空态页」 | chain 有 `priority` 选举；我们的 entry 只在「有候选」时 `select` 返回非 null，其余让位 |
| R5 | 只读线程的 `force:true` 后门 | 现有宿主路由接受 `force`（`index.js:539`） | P0 一并**删掉这条后门**（客户端从未使用），否则同源 POST 可对 herdr 正在写的文件并发写 |
| R6 | 改 `index.js`/`client.js` 不生效 | ESM 按 URL 缓存 | 派独立面板重启宿主（不得在本会话重启，见全局约定） |
| R7 | 「接着问」上下文超限 | 线程几十万字符 | 8k 截断 + 在动作条上明写「最近 20 条」 |

### 现在就该顺手修掉的 6 个既有坑（都在改造路径上）

1. `MAX_MESSAGES` 到顶后流**静默冻结**（`index.js:298` vs `push()` 判据 `:514`）。
2. 超长单行（>8MB）让偏移**永不前进**，600ms 重读一次（`:278-297`）。
3. `spawn` 的 stdout 接了不读 → 管道满 → `running` 永不清（`:316-322`）。
4. `spawn` 把 prompt 当 argv 传（`:316`）→ 以 `-` 开头即被当选项、超长撞 `E2BIG`。
5. `interrupt` 只杀直接子进程（`:569`）。
6. `bound` 只比路径字符串、不看 `agent_session.kind`（`:44-52`）→ 漏判即误开写入。

---

## 10. 与 Codex Desktop 的对照（抄什么、不抄什么）

| Codex | 我们 | 判断 |
|---|---|---|
| `New chat` 直接进新对话页、不弹框 | `⌘N` 直开面板 | 抄 |
| 每会话独立 tab 拓扑（`thread-tab-routes-v1:<threadId>`） | 宿主原生 per-session（`bySession[sessionId]`） | 红利，直接用 |
| 四态词表 Running / Needs input / Ready / Blocked | 照搬，映射 DSH 投影 | 抄 |
| `⌘⌥A` 跳下一个待处理 | 抄 | 抄 |
| `⌘⇧B` 布局循环 | 键位冲突（宿主右栏开关） | 让位，不做 |
| `⌘T` 新浏览器 tab | 宿主已有 | 不重复设计 |
| 只有「chat ｜ 附属 tab」，没有双会话同屏 | 我们有 split pane（`⌘\`） | **我们更强，保持**，别学它 |
| 底部面板 + 右栏双落点，453 份拓扑里 bottom 开 0 次 | 只做右栏 | 不抄 |
| 会话标题自动生成长句、重命名只有 `⌘⌥R` | 面板标题用 preset label + 会话标题双源 | 改进 |

---

## 11. P0 派单提示词（可直接粘给 pi 面板）

> 按本机约定：实现不由会话内直接写，派到独立面板执行。以下七段可直接作为任务 description。

1. **目标**：把 `@local/dsh-threads` 的右栏面板从「自绘线程 + 自绘输入框」改成「面板即会话」：新增 `panechat` 面板类型，面板体渲染 DSH 原生会话（含原生 composer）；`thread` 只读面板删除输入框，换动作条。设计基线：`docs/design/PANE-NATIVE.md`（必须读完再动手，冲突以它为准）。
2. **信息架构**（不许改层级）：`Surface(右栏 pane) → Tab(kind) → Session`。只允许右栏一个落点；不做底部面板、不做浮动面板。
3. **演示剧本（逐字文案，照抄）**：`新会话` / `想开什么？` / `新建` / `打开` / `只读（外部会话）` / `接着问 → 开新会话` / `复制上下文` / `该会话由外部终端持有，面板不提供输入框` / `接着问会带上最近 20 条消息（超 8k 截断），在新会话里继续`。
4. **视觉**：沿用宿主 token，不新造色板；发丝线 0.5px；状态点 6px 四色（`#0A84FF` / `#FF9F0A` / `#30D158` / `#FF453A`）只染点不染行；字阶只有 17/14/13/12/11；数字 `tabular-nums`；玻璃只用于目录选择浮层与 `⌘K`，正文不透明。
5. **动效**：tab 切换 120ms ease-out（opacity + translateY 2px）；状态点呼吸 2s（仅点）；hero→active 160ms；`prefers-reduced-motion` 全关。禁骨架屏、禁脉冲光晕、禁百分比进度。
6. **交互与边界**：`⌘N` 新会话面板（出现即聚焦 composer，不弹第二个框）；`⌘⇧N` 打开启动台；`⌘⌥A` 跳下一个待处理；沿用 `⌘\` `⌘⌥↵` `⌘W`；同一会话禁止在主区与面板同时渲染（命中则导航）；`sessions.create` 复用 blank 会话时聚焦已有 tab；只读面板里**不得存在任何 textarea 节点**。
7. **验收（可判定）**：①面板内拖入图片能发出；②面板内 `/` 出命令菜单、`@` 出引用候选；③改模型/权限档与主区同一会话一致；④`document.querySelector('[data-pane-readonly] textarea') === null`；⑤`⌘N` 后无需点击即可打字；⑥`node --check client.js && node --check index.js` 通过；⑦全程不出现第二个弹窗（目录选择浮层除外）。

**同一批顺带修**（§9「现在就该顺手修掉的 6 个坑」）：`MAX_MESSAGES` 冻结、超长单行偏移不前进、stdout 不读、prompt 当 argv、interrupt 不杀子孙、`bound` 不看 `kind`；并**删除 `force:true` 后门**。

---

## 附：证据索引

- 会话页 Factory / 槽位：`@deepseek-ai/dsh-client-ui-conversation/src/client/contract/slots.ts:288-290,336,544-561,639-648,681-685`
- 原生输入框是槽条目：`…/src/client/skeleton/InputBar.tsx:1-4`；注册 `…/src/client/apply.ts:466`
- 组件未导出：`…/lib/types/client/index.d.ts`
- 官方红线：`docs/subsystems/slots.md:5,99,225`；`docs/subsystems/sidebar-right.md:13,28-32,80-92,144,148,157`
- 现成范本：`@deepseek-ai/dsh-client-ui-subagent/src/client/sidebar-chat/index.tsx:29-38,105-198`
- 会话 API：`@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:52,76-90`；`manager.ts:140-148`
- 右栏服务：`@deepseek-ai/dsh-client-ui-sidebar-right/src/client/service.ts:118-120,243-297,403,416`；`tab-registry.ts:41,59,64-138`
- guide 替换缝：`…/src/client/contract/slots.ts:84-89`；`tabs/guide/GuideBody.tsx` 头注释
- 键位注册与占用：`…/src/client/shortcuts.ts:27-105`；`dsh-client-ui-sidebar-browser/src/client/index.ts:50-54`
- 现状代码：`~/workspace/dsh-threads/client.js:413-446`、`index.js:278-320,514,539,569`、`docs/DETAIL.md:23-30`

---

## 12. 实证记录（P0-① 已落地，2026-11-19 12:44）

代码提交 `6b3b039 feat: 新增 DSH 原生会话面板`（`client.js` +228 行，`package.json` 加 `dsh.client.inject` 两项；`index.js` 零改动）。

**浏览器实测**（`127.0.0.1:3081`，未重启宿主）：

| 验收项 | 结果 |
|---|---|
| 右栏 guide 出现新胶囊「新会话面板」 | ✅ |
| 点胶囊 → 启动页（目录输入，默认取当前会话 cwd） | ✅ |
| 点「创建」→ tab 变「会话」，面板内出现**原生 composer** | ✅ |
| 原生能力：`/` 出命令菜单（文件/目标/计划…）、`@`、附件、权限档、模型选择、语音、发送 | ✅ |
| 真发一轮：1 秒完成、回复「收到」、用量 29.4K tok、复制/反馈/分支/上下文视图全在 | ✅ |
| 宿主是否需重启才能生效 | ❌ **不需要**：`dsh-client-hmr` 每 500ms stat 轮询 graph row 的 bundle，改完自动热替换；实测 combo rev 变为 `43da47067d4e`，`panechat` 命中 21 次 |

证据截图：[`shots/verify-panechat.png`](shots/verify-panechat.png)

### 12.1 本文档 §3.2 的四处 API 与真实签名不一致（以源码为准）

| # | 我写的 | 真实签名 | 依据 |
|---|---|---|---|
| 1 | `useResource('panechat')(tab.contentId)` | `useResource(tab.contentId)`——协议由完整 URL 决定，不是「协议名 + 地址」两段式 | `dsh-client-resources/src/client/contract.ts:60` |
| 2 | `sidebarRight.openResource(addr, { replaceTab: true })` | 全局 `openResource` 的 `replaceTab` 收 **TabId**；要在「启动页原位替换」，必须用 **tab action**：`tab.actions.openResource(addr, true)`——它绑定发起请求的那个 tab，异步创建完成时仍指向正确的 tab | `dsh-client-ui-sidebar-right/src/client/contract/slots.ts:146`、`service.ts:170` |
| 3 | `ctx.commands.register(...)` | 客户端命令是 `ctx.commandUi.register({ name, available, ui: { kind:'action', run } })`；`ctx.commands` 是宿主命令路径 | `dsh-client-ui-commands/src/client/contract.ts:78`、`service.ts:489` |
| 4 | 有空会话 `phase:'hero'` | **Hero 需要 Workspace 标签**，按目录创建的会话没有 Workspace → Hero 里输入框被禁用。面板必须固定 `phase:'active', hero:false` | `dsh-client-ui-conversation/src/client/skeleton/ConversationContent.tsx:142` |

另两条实测事实（文档里没写、但实现必须知道）：

- **会话快照没有 `cwd`**：目录要从 `useSessions(s => s.byId[sessionId]?.cwd)` 取；`sessions.create({cwd})` 省略 `sessionId` 时总是分配新 id（复用只发生在显式传 `sessionId` 时）。`~` 需用 `remote.$host.home` 展开。
- **资源 provider 抛异常不会被资源服务兜住**：失败要以 `{ok:false,error:{code,message,details}}` 帧 yield 出去，否则面板只剩空白。恢复旧 tab 时若会话目录还在 `pending`，要先 `sessions.refresh()` 再 `retain`。

### 12.2 P0-① 已实现但尚未验的两项（下一轮补）

- 同一会话「已在别处打开」的守卫（代码里有：命中 `mounted` 或已有同 contentId 的 tab 时显示「此会话已在其他位置打开」），未做双开实测。
- 拖图片进面板 composer 上传（原生能力，理论上免费，未实测）。

---

## 13. 实证记录（P0-②③ 已落地，2026-11-19 13:08）

提交 `1eec8c7 feat: 快捷键新建会话面板与只读线程动作`（`client.js` +181 / −152，仅一个文件）。

**浏览器实测**（未重启宿主，HMR 自动生效）：

| 验收项 | 结果 |
|---|---|
| `⌥⌘J` 一步开面板 | ✅ 直接多出一个「会话」tab |
| 打开后**无需点击**即可打字 | ✅ 用真键盘输入「焦点测试」，文字直接落进 composer（原生自动聚焦，不需要补 hack） |
| 只读线程面板**没有任何输入框** | ✅ DOM 里只有徽标「⧉ 只读 · 侧线」+「线程列表」+ 动作条 |
| 动作条三键 | ✅「接着问 → 开新会话」「复制上下文」「分叉继续」 |
| 「接着问」= 新会话 + **草稿**注入 | ✅ 新 tab 的 composer 里出现 `<外部会话上下文>` 前缀（含 `[user]/[assistant]` 逐条），**未自动发送** |
| 既有线程只读渲染 / `thread` 地址 / 分叉 | ✅ 未回退 |

证据截图：[`shots/verify-p023.png`](shots/verify-p023.png)

### 13.1 两处新 API（文档原先没写，实现必须知道）

| 场景 | 真实做法 | 依据 |
|---|---|---|
| **跨会话写草稿**（「接着问」把上下文塞进**新**会话的 composer） | `inputActions.setDraft(text)` 是**组件注入属性**，只对当前 slot 绑定的会话有效。跨会话要用 `sessions.using(id, { source, signal }, cb)` 持有新会话，再 `conversation.input.for(reference.binding.ctx).setDraft(text)` | `dsh-api-session-controller` 的 `ISessions.using` + `dsh-client-ui-conversation` 的 `IConversation.input.for(actx)` |
| **快捷键冲突回退** | `shortcuts.register` 的 `defaults` 是"尽力而为"：注册时若发现同 key 已被占用，回退到 `⌥⌘U` 并把实际生效键位回报 | `dsh-client-shortcuts/src/client/types.ts:8` |

另：`⌥⌘J` 选键依据（实测占用表）——`⌘N`/`⌥⌘N`=`session.new`，`⌘P`/`⌥⌘P`=工作区文件，`⌘K`/`⌥⌘K`=搜索会话，`⌘T`/`⌥⌘T`=新浏览器 tab，`⌘W`=关页，`⌘⇧B`=右栏开关，`⌘\`=分屏，`⌘⌥↵`=全屏。

### 13.2 状态盘点

| 阶段 | 状态 |
|---|---|
| P0-① `panechat` 面板 + 原生会话 | ✅ 已落地并实测 |
| P0-② `⌥⌘J` 一步开面板 + 自动聚焦 | ✅ 已落地并实测 |
| P0-③ 只读面板动作条 + 接着问 | ✅ 已落地并实测 |
| 宿主侧六坑 + 删 `force` 后门 | ⏳ 规格已写（`TASK-HOST-1.md`），**只改代码不重启**；重启需独立窗口 |
| P1（状态点四态、`⌘⌥A`、标题统一） | ⏳ 未开始 |
| P2（起手胶囊、上下文压缩、claude/codex 适配） | ⏳ 未开始 |

---

## 14. HOST-1 代码已落地（待重启生效，2026-11-19 13:21）

提交 `01928f2 fix: 修复 DSH 线程宿主游标、进程与只读边界`（`index.js` +244 / −103，仅一个文件）。

| 坑 | 修法（代码实况） |
|---|---|
| ① 游标到顶后 SSE 冻结 | 缓存改带**绝对序号** `total`，`after` 与 `total` 比较，不再用截断数组长度 |
| ② 超长单行 offset 不前进 | 块内无换行时翻倍重试，`droppingLine` 保证 offset 单调前进并只 warn 一次 |
| ③ stdout 管道满 → running 永不清 | `stdio: ['pipe','ignore','pipe']`：stdout 直接 ignore，只留 stderr |
| ④ prompt 当 argv 传 | **改走 stdin**：`spawn('pi',['-p','--session',path,'--'])` + `child.stdin.end(text)`——比规格里的 `--` 更彻底，同时消除 ARG_MAX |
| ⑤ interrupt 只杀直接子进程 | `detached: true` + `process.kill(-pid, signal)` 杀进程组 |
| ⑥ bound 误判 | 只认 `agent_session.kind === 'path'`，路径 `realpath` 归一化，不确定一律偏只读 |
| ⑦ `force` 后门 | **已删除**（`grep force` 归零），`bound` 一律 409 |

**当前状态**：客户端半已由 HMR 生效；宿主半**必须重启 3081 才生效**。重启前，老宿主代码仍在跑（`force` 后门还活着），只是客户端已不再发它的用法。

**重启后的回归清单**（提交者已给出可直接执行的脚本，放在任务回报里）：

1. 4000 条 fixture → `after=4000`；再追加一条 → SSE 应推 `4001`（修前会永久静默）
2. 专用 fixture 发一轮要求「输出 ≥100KiB 纯文本」→ 应正常完成且 `running` 归 false（修前会挂死在管道）
3. 发一轮 `sleep 120 &` 记下子进程 PID → `interrupt` → `ps -p <pid>` 应无输出（修前孙子进程残留）
4. 对 `bound:true` 的 herdr 会话发 `prompt`（**即使带 `force:true`**）→ 应 409 `attached-readonly`

---

## 15. 宿主侧生效的自动化通道（2026-11-19 13:33 挂上）

`index.js` 的修复必须重启 3081。实测当时**最近 5 分钟有 12 个会话在写**，硬重启必然打断别人；
而「铁衣·飞书文档评论巡检」每 5 分钟一轮心跳，让「空闲 10 分钟」几乎永远不成立。所以不硬来，改成两条常驻看护：

| 脚本 | 作用 | 参数 | 现状 |
|---|---|---|---|
| `~/yunwan/tools/dsh/idle-restart.py` | 采样所有会话文件的 mtime，**连续 3 次**满足「10 分钟无写入」才 `launchctl kickstart -k` 重启，随后按需续跑 | `--idle-minutes 10 --confirm 3 --interval 30 --snapshot-minutes 5 --max-wait-hours 14` | PID 5393，PPID=1、PGID 独立 |
| `~/yunwan/tools/dsh/post-restart-verify.py` | 盯主实例 pid（**精确匹配 `com.yeisme.dsh-web`，不能误配 `-test`**），一变就换 token/cookie，跑 V1/V2/V3，写 `docs/design/RESTART-REGRESSION.md` 并 `notify.sh` 推送 | `--start-pid 94843 --max-wait-hours 14` | PID 11302，PGID 独立 |

**为什么 `--snapshot-minutes 5` 是刻意的**：重启只在「10 分钟无人写」时触发，所以过去 5 分钟内不可能有活跃会话 → 续跑名单天然为空 → **不会像 2026-11-19 10:46 那次一样把几十个陈旧会话批量唤醒**（那次是裸跑 resume 脚本，10 秒唤醒 53 个）。

**自动回归三项**（不依赖模型回合，30 秒出结论）：
- **V1** `force` 后门：对 `bound:true` 的 herdr 会话 POST `force:true` → 必须 **409**
- **V2** 游标不冻结：造 4000 条 fixture → `after=4000`；追加 1 条 → SSE 必须推 `>4000` 的 append（修前永久静默）
- **V3** 只读边界：列表里 `bound:true` 仍存在且带 pane 号

两个脚本都用 `os.setsid()` 脱离 DSH 进程组（macOS 没有 `setsid` 二进制，`nohup setsid ...` 会直接报错——这条已实测），否则重启时会被一起带走。

---

## 16. 实测：四态状态点只有 `running` 能用（P1 教训，2026-11-19 13:50）

浏览器实测（真页面、真回合）：

| 态 | 结果 | 说明 |
|---|---|---|
| `running` | ✅ 能用 | 发出消息后 100ms 采样 5 秒，抓到 `data-dsh-pane-state="running"` |
| 活标题 | ✅ 能用 | tab 标题自动跟到宿主生成的会话标题「11-19 13:46 · 仅回复 OK 的指令」 |
| `ready` | ❌ 从不出现 | 判定读的是 `status.completionUnread` |
| `blocked` / `waiting` | ❌ 未观察到 | 同样依赖宿主状态位 |
| `⌘⌥Y` 跳待处理 | ❌ 无目标 | 三条待处理态都出不来，注意力队列恒空 |

**根因**：`completionUnread` 是给**侧栏会话行**用的「未读」概念。嵌入在面板里的会话一直挂着渲染，宿主很快把它算成已读 → `ready` 条件恒假。**面板要用自己的 `lastSeenSeq`**：每个 tab 记「上次聚焦时的 `turn/end` seq」，之后再有 `turn/end` 且 seq 更大、且当前不在跑 → `ready`；聚焦即刷新。

**可复用结论**：`conversation.content` 的 embedded 变体只保证「渲染 + 原生输入」，**不保证宿主侧未读/注意力语义**；凡是「有没有新东西」的判断，面板必须自持游标，不能借宿主的 unread 位。

已在 `TASK-P1.md` §6 立 P1b 修正规格（`097d160`）并派单。

---

## 17. P1b 结果（2026-11-19 14:05）：`ready` 仍未在真页面出现

提交 `817f885 fix: 按面板焦点确认会话完成状态`（`completionUnread` 已彻底删掉，改自持 `lastSeenSeq` 游标，`client.js` +99/−71）。

**浏览器复验（真页面，精确时序）**：

1. 点 panechat tab → 点进 `[data-sidebar-right-panel] [contenteditable]` → 输入 → 回车 → 等「已完成」→ 切到另一个 tab → 查 `[data-dsh-pane-state]`
2. 结果：**仍然是 `null`**（该 tab 的 `ready` 未出现；`running` 在采样中仍正常）

**当前最可能的判断**（留给下一轮验证，不要再盲改）：`lastSeenSeq` 游标是在**面板体组件**里维护的（`client.js:315-332` 用 `tab.signal`/`cursor`），而 `tabCaption` 在**标题槽**里读同一个 Map。两者是同一槽树的不同渲染点，若 body 尚未挂载或先于 title 渲染，title 侧读到的游标就是 `undefined` → `ready` 条件（要求 `lastSeenSeq !== undefined`）恒假。

**下一轮的正确做法**：把游标提升到模块级、以 `contentId` 为键**在 title 侧也能自愈初始化**（没有游标时先用「当前 turn/end seq」初始化，不要再要求非 undefined），或在宿主侧确认 title 槽能否拿到 `useTabInfo().tab.signal`。这一步值得先花 10 分钟读槽契约，而不是再改一版。

### 状态盘点（14:05）

| 项 | 状态 |
|---|---|
| P0-① 面板 + 原生会话 | ✅ 实测通过 |
| P0-② `⌥⌘J` 开面板 + 自动聚焦 | ✅ 实测通过 |
| P0-③ 只读动作条 + 接着问入草稿 | ✅ 实测通过 |
| P1 `running` 点 + 活标题 | ✅ 实测通过 |
| P1 `ready` / `blocked` / `waiting` 点 | ❌ 未出现（`ready` 已定位到标题槽拿不到游标） |
| P1 `⌘⌥A/Y` 跳待处理 | ⚠️ 逻辑在，但因三条待处理态不出而无可跳目标 |
| HOST-1 六坑 + 删 `force` | ✅ 代码落地，等空闲窗口自动重启生效 |
| 自动回归（V1/V2/V3） | ✅ 已挂常驻看护，重启后自动出报告 |

---

## 18. HOST-1 已在真宿主上验证通过（2026-11-19 15:13）

宿主在 **14:17:44 重启**（pid 94843 → 38013，**不是**我挂的空闲看护干的，它当时还在守候），HOST-1 的 `index.js` 修复随之生效。

回归结果（`post-restart-verify.py --now`，报告见 [`RESTART-REGRESSION.md`](RESTART-REGRESSION.md)）：

| 项 | 结果 | 证据 |
|---|---|---|
| V1 `force` 后门已删 | ✅ | 对 `bound:true` 会话 POST `force:true` → **409 `attached-readonly`** |
| V2 游标到顶后仍推送 | ✅ | 4000 条 fixture 初始 `after=4000`，追加 1 条 → SSE 推 **`after=4001`**（修前会永久静默） |
| V3 只读边界 | ✅ | `threads=80`，`bound=80` |

### 18.1 踩坑：curl 的 HttpOnly cookie 被当成注释跳过（两个脚本共有）

自动回归第一次跑失败在「拿不到 cookie」，和今早 02:51 那次重启失败是**同一个原因**：

- 鉴权 cookie 名是**动态的**（`dsh-auth-<实例随机后缀>`），且带 `HttpOnly`；
- `curl -c` 把 HttpOnly cookie 写成以 **`#HttpOnly_`** 开头的行；
- 两个脚本都写了 `if line.startswith("#"): continue` → **把真 cookie 当注释丢掉** → cookie 恒空。

**修法**（已同步修进 `post-restart-verify.py` 与 `idle-restart.py`）：先剥 `#HttpOnly_` 前缀再解析，只有剩余以 `#` 开头的才当注释。

**可复用教训**：凡是用 `curl -c` 换 cookie 再带 `cookie:` 头调本地 API 的脚本，先 `grep -c '^#HttpOnly_' jar` 确认自己没跳过它。

### 18.2 空闲看护的收尾

`idle-restart.py`（PID 5393）的使命是「把 HOST-1 送上线」，重启已发生，重启后它会在夜里再来一次、纯粹多打扰一次，已停掉。`post-restart-verify.py` 用完即退（`--now` 模式无残留）。

---

## 19. 更正：P1 四态其实是**对的**——错的是我的验收方法（2026-11-19 15:26）

**必须先更正 §17 的结论。** §17 写「`ready` 仍未出现，定位到标题槽拿不到游标」，那是**错的**。真相：

1. `ready` 的判定依赖「回合在**失焦**状态下结束」。我的三轮测试都是「在 A 发消息 → 留在 A 等完成 → 切走 → 查点」——回合**结束时 A 仍在聚焦**，`paneCursors.observe()` 立刻把游标推到该 `turn/end` 的 seq，于是 `turn.seq > lastSeenSeq` 永假。这是**正确行为**（你正看着它，不该给你红点提醒），不是缺陷。
2. 正确测法：发消息后 **0.4 秒内切到另一个 tab**，让回合在后台结束。实测随即出现 `data-dsh-pane-state="ready"`，且 `⌥⌘Y` 从别的 tab 一跳命中。
3. `turn/end.reason` 在契约里是**必填**（`dsh-session/lib/types/types.d.ts:170-216`，正常完成 = `{kind:'completed'}`），所以 §17 里「reason 可能 undefined」的推测也不成立。

**证据**：[`shots/verify-p1-ready.png`](shots/verify-p1-ready.png)（tab strip 上绿点 + 已切走的新会话 tab）。

### 19.1 教训（比代码值钱）

- **验收设计错了，会看起来像代码错了。** 状态点的语义是「你不在看的时候有东西变了」，用「一直盯着」的方式测它，必然测不到——这不是实现的 bug，是测试的反模式。
- 以后验这类「注意力」功能，固定套路：**发 → 0.4s 内失焦 → 等完成 → 查**。这条已写进本文件，P1 后续不用再猜。
- 我因此在 P1b、P1c 两轮里让面板白改了一遍（`completionUnread` 的替换本身是必要的加固，但 `ready` 从未坏过）。**下一次遇到「逻辑对但现象不符」，先怀疑自己的复现步骤，再怀疑代码。**

### 19.2 当前真实状态（P1 全部可用）

| 项 | 状态 |
|---|---|
| `running` 蓝点 | ✅ 采样可捕获 |
| `ready` 绿点 | ✅ 回合在失焦下结束时出现 |
| `⌥⌘Y` 跳待处理 | ✅ 实测从别 tab 一跳命中 |
| 活标题 | ✅ 跟随宿主会话标题 |
| `blocked` / `waiting` | 逻辑在，未见真实触发（需要审批/提问场景），未验 |

---

## 20. 状态快照（2026-11-19 15:50）

### 已上线并真机验证

| 能力 | 证据 |
|---|---|
| 面板 = 真 DSH 会话，自带**原生 composer** | 拖图/`/`命令/`@`引用/权限档/模型/语音全在；真发一轮 1 秒完成、29.4K tok |
| `⌥⌘J` 一步开面板 + **自动聚焦** | 不点任何位置，真键盘输入直接落进 composer |
| 只读线程面板**零输入框** | 只剩徽标 + 三键动作条 |
| 「接着问」上下文入**草稿**（不自动发送） | `<外部会话上下文>` 前缀逐条 `[user]/[assistant]` |
| 四态点中的 `running` / `ready` | `running` 采样命中；`ready` 需**回合在失焦下结束**（这是正确语义，见 §19） |
| `⌥⌘Y` 跳待处理 | 从别的 tab 一跳命中绿点 tab |
| 活标题 | tab 标题跟随宿主会话标题 |
| 右栏拓扑持久化 | 整页刷新后 3 个 tab 原样恢复（宿主 per-session 布局红利） |
| HOST-1 六坑 + 删 `force` 后门 | 真机回归 V1/V2/V3 全 PASS（[`RESTART-REGRESSION.md`](RESTART-REGRESSION.md)） |

### 已知边界（写清楚，不要当成 bug 反复改）

1. **`ready` 只在失焦时出现**——设计如此。验收必须「发 → 0.4s 内切走 → 等完成 → 查」，否则永远测不到（§19 教训）。
2. **刷新后状态点清零**：`lastSeenSeq` 游标是内存态。若要跨刷新保留，属 P3（把游标按会话持久化）。
3. **`blocked` / `waiting` 未见真实触发**：需要审批/提问场景，逻辑在但未验。
4. **只读线程不可写**：`sessions.retain` 只认 DSH 会话 id，pi/herdr 会话永远进不了原生会话页（架构结论，不是缺陷）。

### 在飞

- **P2 起手胶囊**：规格 `TASK-P2.md`，面板已写完 +58 行但卡在「点击后聚焦」细节上超时，未提交。下一轮要么让它收口提交，要么砍掉聚焦要求（`setDraft` 后由用户点一下就够）。

---

## 21. 面板改为「分叉当前对话」，目录输入彻底删除（2026-11-19 17:55）

**主人的两句话定了设计**：「目前 btw 还会需要选择目录，给我直接改为默认当前工作区目录设计」→「btw 直接就是 fork 对话，然后开始新对话」。

旧实现（§12）是「guide 胶囊 → 启动页 → 填目录 → 创建空白会话」。目录这一步被删掉，换成 DSH 原生 fork：

| 项 | 旧 | 新 |
|---|---|---|
| 入口 | 右栏「新会话面板」胶囊 / `⌥⌘J` / `/panechat` | 同一批入口，改名「分叉面板」 |
| 中间步骤 | 填目录表单 + 点创建 | 无步骤，直接 fork 并替换 tab |
| 目录 | 手填（默认当前会话 cwd） | 不询问，随 fork 继承源会话 cwd |
| 上下文 | 空会话 | 源会话已完成轮次的完整上下文 |

实现要点（只改 `client.js`，`index.js` 零改动）：

1. `openContinuedPane(scope, sourceId, open)`：`sessions.fork({ sessionId, increaseTitle: true })` → `open(paneAddress(childId))`。fork 的 `meta.cwd` 由宿主从 `source.header.cwd` 复制（`dsh-api-session-controller/lib/index.js` 的 `fork()`），所以「默认当前工作区目录」是宿主保证，不是客户端猜的。
2. 空白会话没有已完成轮次，宿主会拒 `session/fork-unavailable`；此时降级为 `sessions.create({ cwd: source.cwd })` —— 同目录的空白面板，仍然不问目录。
3. **坑**：降级分支最初用 `const UNFORKABLE = new Set([...])` 判错误码，真机命中 `Cannot access 'UNFORKABLE' before initialization`（TDZ，HMR 换 bundle 后由旧组件回调触发）。改成会提升的函数声明 `isUnforkable(code)` 后消失。教训：**组件里能走到、但声明在函数体后段的常量，一律用函数声明兜住**。

**真机验证**（`127.0.0.1:3081`，未重启宿主，HMR 自动换 bundle：rev `59bd0396a8f7` → `a2ae14628115`）：

| 验收项 | 结果 |
|---|---|
| 右栏胶囊文案变「分叉面板」，无目录输入框 | ✅ |
| 有历史的会话点胶囊 → tab 立即变「<原标题> (1)」，面板内是本会话完整历史 + 原生 composer | ✅ |
| `⌥⌘J` → 再开一条「(2)」，同样带历史 | ✅ 快捷键走同一 `openContinuedPane` |
| 空白会话兜底 → tab 变「新会话」空白面板，起手胶囊按 cwd 命中「看当前 diff」 | ✅ 走 `create({cwd})` 降级 |
| 全程目录不被询问，fork 会话归到源会话同一工作区组 | ✅ |
| 失败时面板显示错误 + 「重试」按钮 | ✅（TDZ 那次就是这个 UI 抓到的） |

副作用（有意接受）：fork 出来的会话是**普通会话**，会出现在左侧会话列表里（原生 fork 语义如此），不再像旧子代理方案那样隐藏。测试产生的两条 fork 与一条空白会话已用 UI 归档。
