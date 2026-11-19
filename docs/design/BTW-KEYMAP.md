# BTW 键位设计 v1（参考 Codex）

> 2026-11-19 20:40。对象：`@local/dsh-threads` 的分叉面板（BTW）全部可键盘操作。
> 三份事实来源：① DSH `⌘/` 速查面板读出的**真实占用表**（权威，含用户覆盖）；② 客户端包里 `shortcuts.register` 的默认绑定（机器提取，用于找 id 命名习惯）；③ Codex CLI 0.170 二进制里的 `TuiGlobalKeymap` 动作名与 `/side` 会话语义。

## 0. 结论先行

**采用「⌥⌘ 家族 + 方向/字母」的分层，不引入 leader 键，不占用任何 ⌘ 单键。**

- 分叉/合流/跳回这类**会话级**动作放 `⌥⌘` 层：`J` 分叉、`⇧J` 强制另开、`L` 合流、`R` 跳回（`⌥⌘K` 被搜索会话占用，原本想要的 `J K L` 连号只能断在 K）。
- 面板间移动放**方向键 + ⌥⌘**（Codex 的 `focus_pane_left/right`、`sidebar_up/down` 同构）。
- 每个绑定都必须**可被用户覆盖**，并在注册时做冲突检测 + 兜底链（已在本插件 `panechat.new` 里用的模式）。
- 已占用键一律不碰：`⌘N / ⌥⌘N / ⌘, / ⌥⌘, / ⌘/ / ⌘B / ⌥⌘B / ⌘⇧B / ⌥⌘P / ⌘T / ⌃\` / Esc / ⌘↵ / ⇧⌘A / ⌥⌘A / ⇧⌘F`。

## 1. 现在已生效的绑定（本插件）

| id | 动作 | 键位 | 兜底 | 备注 |
|---|---|---|---|---|
| `panechat.new` | 分叉当前对话 → 右栏新面板 | `⌥⌘J` | `⌥⌘U`（若 `KeyJ` 冲突） | `client.js:1579` 起注册，`describeBinding` 冲突时自动降级 |
| `threads.attention.next` | 跳到下一个待处理面板 | `⌥⌘Y` | — | 四态状态点驱动 |

已实测可用（2026-11-19 18:5x，宿主 95094）：`⌥⌘J` 能建分叉并聚焦新面板 composer。

## 2. DSH 真实占用表（`⌘/` 速查面板读出的权威清单，2026-11-19 21:0x）

> 这一版是**界面读出来的**，不是 grep 猜的。凡在此表出现的键，一律不得复用。

| 键位 | 动作 |
|---|---|
| `⌘/` | 快捷键速查 |
| `⌥⌘N` | 新会话 |
| `⌥⌘B` | 展开／收起左侧栏 |
| `⌥⌘K` | **搜索会话** |
| `⌥⌘O` | **添加工作区** |
| `⌥⌘G` | **重命名会话** |
| `⇧⌘F` | 分叉会话（原生） |
| `⌥⌘A` | **归档会话** |
| `⌥⌘,` | 打开设置 |
| `⇧⌘O` | 在本地打开 |
| `⇧⌘B` | 展开／收起右侧栏 |
| `⌥⌘P` | 工作区文件 |
| `⌃\`` | 新建终端 |
| `⌘\` | 分栏 |
| `⌥⌘↵` | 面板全屏／退出全屏 |
| `⌥⌘W` | **关闭当前页面／窗口** |
| `⇧⌘.` | 展开或收起 NodeJS 诊断 |
| `⌥⌘Y` | 跳到下一个待处理面板 |
| **`⌥⌘J`** | **分叉面板（本插件，已上线并出现在速查表内）** |
| `⌘↵` | 互补的 Queue／Steer 发送 |
| `↵` / `⇧↵` | 发送 / 换行 |
| `/` / `@` | 命令菜单 / 引用菜单 |
| `Esc` | 停止生成 / 关闭浮层 / 拒绝审批 |
| `↑` `↓` `↵` | 菜单移动与确认 |

**由此推翻的三个提案**：`⌥⌘K`（想给「跳回源会话」）→ 撞搜索会话；`⌥⌘O`（想给「打开 agents」）→ 撞添加工作区；`⌥⌘W`（想给「关分叉 tab」）→ 撞关闭页面/窗口。已在下表改掉。


## 3. Codex 对照（动作名取自 Codex CLI 0.170 二进制）

| Codex 动作 | Codex 语义 | 我们对应 | 说明 |
|---|---|---|---|
| `toggle_side_conversation` + `/side` | 开/回侧对话 | `panechat.new`（`⌥⌘J`） | 已对齐：都是「在当前会话旁开一条能继续对话的支线」 |
| `focus_sidebar_content` / `focus_sidebar_tabs` | 焦点进侧栏内容/标签 | `⌥⌘→`（内容）、`⌥⌘↑↓`（切 tab） | 新增 |
| `focus_pane_left` / `focus_pane_right` | 左右 pane 切换 | `⌥⌘←` / `⌥⌘→` | 新增，直接复用 DSH 右栏焦点模型 |
| `close_sidebar_tab` | 关当前 tab | `⌥⌘W` | 新增（不占 `⌘W`） |
| `sidebar_up` / `sidebar_down` | 上下移动游标 | `⌥⌘↑` / `⌥⌘↓` | 新增 |
| `toggle_pane_zoom` | 单 pane 放大 | `⌥⌘F` | 新增（`⌘⇧F` 已被 fork 占用） |
| `open_agents` | 打开 agent 面板/切换会话 | `⌥⌘⇧O` | `⌥⌘O` 是添加工作区、`⌥⌘A` 是归档会话、`⇧⌘O` 是在本地打开，只剩这个组合可用；P2 再说 |
| `open_transcript` / `find_transcript` | 看/搜全文 | `⌥⌘T` | 新增（对齐右栏「轨迹」tab） |
| `interrupt_turn` | 中断当前回合 | 沿用 `Esc` | 不新增 |
| `edit_queued_message` | 编辑排队消息 | 沿用宿主能力 | 不新增 |
| `decrease/increase_reasoning_effort` | 调推理档 | 不做快捷键 | 交给模型菜单，避免误触 |
| `previous/next_permission_mode` | 切权限档 | `⌥⌘⇧A` 循环 | P2，风险高（权限档误切），默认关闭 |
| `leader` | 前缀键 | **不引入** | DSH 没有 leader 概念，用户不认识，反而难发现 |
| `fork` / `queue` / `archive`（CLI 子命令） | 会话生命周期 | 见 `BTW-FEATURES.md` F3/F7/F8 | 概念对齐，不占键位 |

## 4. 建议绑定表（v1 交付范围）

分三组，**P0 必做**是前三行 + 焦点组。

### 4.1 会话级（P0）

| id | 动作 | macOS | Windows/Linux | 兜底链 | regions |
|---|---|---|---|---|---|
| `panechat.new` | 分叉当前对话（已开则聚焦，无则新建） | `⌥⌘J` | `⌃⌥J` | `⌥⌘U` → `⌥⌘⇧J` | page, editable, terminal |
| `panechat.branch` | 强制再开一条分叉（不动已开的） | `⌥⌘⇧J` | `⌃⌥⇧J` | 无（仅命令面板） | page |
| `panechat.merge` | 最近一条分叉结论 → 主线草稿（不自动发） | `⌥⌘L` | `⌃⌥L` | `⌥⌘I` | page, editable |
| `panechat.return` | 跳回源会话（分叉 → 主线） | `⌥⌘R` | `⌃⌥R` | 无 | page |

> `⌥⌘K` 是搜索会话、`⌥⌘O` 是添加工作区，都不能用，故 return 落 `⌥⌘R`。

### 4.2 焦点与导航（P0）

| id | 动作 | 键位 | 说明 |
|---|---|---|---|
| `pane.focusLeft` / `pane.focusRight` | 主线 ↔ 右栏分叉 互切 | `⌥⌘←` / `⌥⌘→` | 速查表里无占用，实测注册时再跑一次 `describeBinding` 兜底 |
| `pane.nextTab` / `pane.prevTab` | 右栏分叉 tab 上/下 | `⌥⌘↓` / `⌥⌘↑` | 对齐 Codex `sidebar_down/up` |
| `pane.closeTab` | 只关分叉面板、不归档会话 | `⌥⌘⌫` | `⌥⌘W` 已被「关闭页面/窗口」占用，让开 |
| `pane.zoom` | 分叉面板占满右栏 | `⌥⌘F` | 已有 `⌥⌘↵` 是面板全屏（宿主级），本键是「单 pane 放大」，不重复 |

### 4.3 辅助（P1）

| id | 动作 | 键位 | 备注 |
|---|---|---|---|
| `panechat.ask` | 选区 → 问 BTW（开分叉并预填引用块） | `⌥⌘'` | 也可只用浮动条，不占键 |
| `panechat.fold` | 展开/收起分叉历史 | `⌥⌘H` | 折叠态默认收起，此键快速展开 |
| `panechat.list` | 分叉列表浮层 | 复用 `⌥⌘Y` | 不新增键：把「跳到下一个待处理」扩展成「待处理列表」，行为向后兼容 |
| ~~`panechat.help`~~ | ~~键位速查~~ | 删掉 | `⌘/` 已是宿主的快捷键速查，本插件注册进去即可，不另造浮层 |


## 5. 注册实现要点（照现有模式写）

1. **一律走 `ctx.shortcuts.register`**，不要自己 `addEventListener`：只有这样才会出现在「设置 → 编辑快捷键」里、可被用户改写、并参与冲突检测。
2. **冲突处理用兜底链**，照 `client.js:1579` 的写法：
   ```js
   const { issue, conflicts } = shortcuts.describeBinding(binding)
   if (issue !== null || conflicts.length > 0) return register(fallback)
   try { return register(binding) } catch (e) { if (String(e).startsWith('Conflicting shortcut defaults:')) return register(fallback); throw e }
   ```
3. **`resolve()` 返回 `{status:'blocked', reason}` 而不是静默 return**，理由用 `t()` 本地化（Codex 会在 footer 显示「Wait for the current turn to finish」这类原因，我们照做）。
4. **`regions` 必填**：分叉键要在 `['page','editable','terminal']` 都生效（用户在 composer 里打字时也要能按）；纯导航键只给 `['page','editable']`，避免抢终端输入。
5. **不做 leader**：与本机用户习惯（Codex Desktop 是 ⌘ 家族）不一致，且 DSH 无 leader 基础设施。

## 6. 验收（可判定）

| # | 断言 |
|---|---|
| K1 | `node --check client.js` 通过；无新增 `addEventListener('keydown')` |
| K2 | 设置 → 编辑快捷键 里能看到本插件全部新 id，且能改键并立即生效 |
| K3 | 故意把 `⌥⌘J` 改成 `⌘B`（与左栏冲突）后插件自动走兜底，不抛错、不吞掉宿主快捷键 |
| K4 | 焦点在 composer 时按 `⌥⌘J` 能分叉（regions 覆盖 editable） |
| K5 | 焦点在终端 tab 时按 `⌥⌘←/→` 不被吞（导航键不进 terminal region） |
| K6 | `⌥⌘W` 只关面板不归档会话（会话列表数量不变） |

## 7. 已定 / 待定

- ✅ 已定：`⌥⌘J` 复用（已上线）、`⌥⌘⇧J` 强制另开、`⌥⌘L` 合流、`⌥⌘R` 跳回源会话、`⌥⌘↑↓` 切 tab、`⌥⌘←→` 切 pane、`⌥⌘H` 折叠、`⌥⌘'` 选区即问、`⌥⌘⌫` 只关面板。
- ✅ 已否：`⌥⌘K/O/W`（真实占用）、`⌥⌘/` 自造速查（宿主 `⌘/` 已够）、权限档循环键（误切代价大）。
- ⏳ 待真机：`⌥⌘←/→` 与 `⌥⌘⌫` 注册时的 `describeBinding` 结果；若报冲突，焦点组退 `⌥⌘⇧←/→`，关面板退 `⌥⌘⇧⌫`。
- 说明：每条都要在注册前跑 `describeBinding` + 兜底链，**设计表定的是首选位，不是硬编码**。
