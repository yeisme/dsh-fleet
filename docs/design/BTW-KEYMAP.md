# BTW 键位设计 v1（参考 Codex）

> 2026-11-19 20:40。对象：`@local/dsh-threads` 的分叉面板（BTW）全部可键盘操作。
> 两份事实来源：① DSH 客户端包里 `shortcuts.register` 的默认绑定（机器提取）；② Codex CLI 0.170 二进制里的 `TuiGlobalKeymap` 动作名与 `/side` 会话语义。

## 0. 结论先行

**采用「⌥⌘ 家族 + 方向/字母」的分层，不引入 leader 键，不占用任何 ⌘ 单键。**

- 分叉/合流/跳回这类**会话级**动作放 `⌥⌘` 层（`J K L` 三连，Codex 的 `toggle_side_conversation` 语义）。
- 面板间移动放**方向键 + ⌥⌘**（Codex 的 `focus_pane_left/right`、`sidebar_up/down` 同构）。
- 每个绑定都必须**可被用户覆盖**，并在注册时做冲突检测 + 兜底链（已在本插件 `panechat.new` 里用的模式）。
- 已占用键一律不碰：`⌘N / ⌥⌘N / ⌘, / ⌥⌘, / ⌘/ / ⌘B / ⌥⌘B / ⌘⇧B / ⌥⌘P / ⌘T / ⌃\` / Esc / ⌘↵ / ⇧⌘A / ⌥⌘A / ⇧⌘F`。

## 1. 现在已生效的绑定（本插件）

| id | 动作 | 键位 | 兜底 | 备注 |
|---|---|---|---|---|
| `panechat.new` | 分叉当前对话 → 右栏新面板 | `⌥⌘J` | `⌥⌘U`（若 `KeyJ` 冲突） | `client.js:1579` 起注册，`describeBinding` 冲突时自动降级 |
| `threads.attention.next` | 跳到下一个待处理面板 | `⌥⌘Y` | — | 四态状态点驱动 |

已实测可用（2026-11-19 18:5x，宿主 95094）：`⌥⌘J` 能建分叉并聚焦新面板 composer。

## 2. DSH 已占用键位（机器提取，勿撞）

| 键位 | 归属 id | 包 |
|---|---|---|
| `⌘N` / `⌥⌘N` | 新建会话 | ui-workspace |
| `⌘,` / `⌥⌘,` | `settings.open` | ui-settings-general |
| `⌘/` | `shortcuts.open` | ui-shortcuts |
| `⌘B` / `⌥⌘B` | `sidebar.left.toggle` | ui-layout |
| `⌥⌘B` / `⌘⇧B` | `sidebar.right.toggle` | ui-sidebar-right |
| `⌥⌘P` | `workspace.files` | ui-sidebar-files |
| `⌘T` / `⌥⌘T` | `browser.new` | ui-sidebar-browser |
| `⌃\`` | `terminal.new` | ui-sidebar-terminal |
| `⌘⇧,` / `⌘⇧.` | 设置内的列表翻页/调序 | client-shortcuts |
| `⌘\` | 右栏分栏（`sidebar.right`） | ui-sidebar-right |
| `⌥⌘↵` | 右栏新面板（`sidebar.right`） | ui-sidebar-right |
| `Esc` | `response.stop` / 审批拒绝 / 关闭浮层 | conversation、approval |
| `⌘↵` | 发送（替代行为：排队发送） | conversation |
| `↵` / `⇧↵` | 补全确认 / 换行 | conversation |
| `⌘?` 家族 | 行内补全（`fixed.slash` / `fixed.mention` / `fixed.complementary`） | conversation |
| `⇧⌘A` / `⌥⌘A` | 归档会话（会话右键菜单展示） | ui-workspace |
| `⇧⌘F` | 分叉会话（原生 fork，会话右键菜单展示） | ui-workspace |
| `⌥⌘O` / `⌘⇧O` | 在应用内打开（`open-in-app`） | ui-open-in-app |
| `⌘P` | 工作区文件（部分平台） | ui-sidebar-files |

> 说明：`⌘J` 未被 DSH 占用（Codex 里 `⌘J` 也是「侧对话」语义），但**单 ⌘ 层留给宿主**，本插件只用 `⌥⌘`。

## 3. Codex 对照（动作名取自 Codex CLI 0.170 二进制）

| Codex 动作 | Codex 语义 | 我们对应 | 说明 |
|---|---|---|---|
| `toggle_side_conversation` + `/side` | 开/回侧对话 | `panechat.new`（`⌥⌘J`） | 已对齐：都是「在当前会话旁开一条能继续对话的支线」 |
| `focus_sidebar_content` / `focus_sidebar_tabs` | 焦点进侧栏内容/标签 | `⌥⌘→`（内容）、`⌥⌘↑↓`（切 tab） | 新增 |
| `focus_pane_left` / `focus_pane_right` | 左右 pane 切换 | `⌥⌘←` / `⌥⌘→` | 新增，直接复用 DSH 右栏焦点模型 |
| `close_sidebar_tab` | 关当前 tab | `⌥⌘W` | 新增（不占 `⌘W`） |
| `sidebar_up` / `sidebar_down` | 上下移动游标 | `⌥⌘↑` / `⌥⌘↓` | 新增 |
| `toggle_pane_zoom` | 单 pane 放大 | `⌥⌘F` | 新增（`⌘⇧F` 已被 fork 占用） |
| `open_agents` | 打开 agent 面板/切换会话 | `⌥⌘O`→ 改为 `⌥⌘A`（agents） | 新增；`⌥⌘O` 已被 open-in-app 占用 |
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
| `panechat.new` | 分叉当前对话（有则聚焦，无则新建） | `⌥⌘J` | `⌃⌥J` | `⌥⌘U` → `⌥⌘⇧J` | page, editable, terminal |
| `panechat.newBranch` | 强制再开一条分叉（不聚焦旧的） | `⌥⌘⇧J` | `⌃⌥⇧J` | 无（可只在命令面板） | page |
| `panechat.merge` | 把当前分叉的结论送回主线草稿（不自动发） | `⌥⌘L` | `⌃⌥L` | `⌥⌘I` | page |
| `panechat.return` | 跳回源会话（分叉 → 主线） | `⌥⌘K` | `⌃⌥K` | — | page |

### 4.2 焦点与导航（P0）

| id | 动作 | 键位 | 说明 |
|---|---|---|---|
| `pane.focusLeft` / `pane.focusRight` | 主线 ↔ 右栏分叉 互切 | `⌥⌘←` / `⌥⌘→` | 已在 DSH 有同类动作，先查 `describeBinding`，冲突则只保留「右栏内」层 |
| `pane.nextTab` / `pane.prevTab` | 右栏分叉 tab 上/下 | `⌥⌘↓` / `⌥⌘↑` | 对齐 Codex `sidebar_down/up` |
| `pane.closeTab` | 关当前分叉 tab（会话保留） | `⌥⌘W` | 不删会话，只关面板 |
| `pane.zoom` | 分叉面板占满右栏 | `⌥⌘F` | 对齐 `toggle_pane_zoom` |

### 4.3 辅助（P1）

| id | 动作 | 键位 | 备注 |
|---|---|---|---|
| `panechat.ask` | 选区 → 问 BTW（选中文本直接开分叉并预填） | `⌥⌘'`（单引号） | 与 Codex `/side` 的「随手问」对齐；也可只用浮动条不设键 |
| `panechat.transcript` | 打开/收起分叉的历史折叠 | `⌥⌘H` | 折叠态默认收起，这个键是快速展开 |
| `panechat.list` | 列出本会话所有分叉（命令面板式浮层） | `⌥⌘Y`（复用现有跳转，扩展为列表） | — |
| `panechat.help` | BTW 键位速查浮层 | `⌥⌘/` | 内容从 `shortcuts.catalog` 生成，不手写 |

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

## 7. 待决策（需要你一句话）

- `⌥⌘←/→` 与 DSH 自身是否已有右栏焦点键冲突，需要真机 `describeBinding` 跑一遍再定；若冲突，焦点组退化为 `⌥⌘⇧←/→`。
- `⌥⌘⇧A`（权限档循环）默认不做：误切权限档的代价比便利大。
