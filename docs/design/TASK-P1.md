# TASK P1 · 状态点四态 + ⌘⌥A 跳待处理 + 标题单一数据源（只改 client.js）

> 前置：P0-①②③ 已落地（`1eec8c7`、`b486f99`）；HOST-1 已落地待重启（`01928f2`）。
> 本任务**只改 `client.js`**，改完由 HMR 自动生效，不重启宿主。依据 `PANE-NATIVE.md` §5.1/§5.2/§6。

## 1. 三件事

### A. tab 上的四态状态点

在 `panechat` 与 `thread` 两种 tab 的标题旁渲染一个 6px 圆点，只染点不染行：

| 态 | 判定（以真实 API 为准，下面是我的理解） | 颜色 |
|---|---|---|
| 等你 | 有未处理交互（审批 / 提问 / 计划审批） | `#FF9F0A` |
| 卡住 | 最近一轮以失败结束（`promptError` 之类） | `#FF453A` |
| 就绪 | 已完成且有未读 | `#30D158` |
| 运行中 | 正在跑 | `#0A84FF` |

优先级 **等你 > 卡住 > 就绪 > 运行中**。实现入口优先用 `sidebar.right.pane.tab.title` 槽（把点渲染进标题里），或宿主已暴露的 `useSessionStatus` / `sessions.list` 快照；**以源码里的真实状态字段为准**，若拿不到「未读」概念，就把「就绪」退化为「刚完成、尚未被查看」（可用 tab 是否聚焦近似），并在回报里说明退化依据。

### B. `⌘⌥A` 跳到下一个待处理的面板

- 注册快捷键（id `panechat.attention`），`primary+alt+KeyA`；若冲突回退 `primary+alt+KeyY`。
- 行为：在当前窗口的右栏 tab 里，按「等你 > 卡住 > 就绪」优先级找**下一个**（相对当前 tab 环状前进）并 `focus(tabId)` + 切到它所在 pane。
- 没有任何待处理时：给一条轻提示（不要弹模态），例如在 composer 的 notice 通道或 1.5s toast。

### C. 标题单一数据源

面板标题与侧栏会话名一致：会话标题变化时 tab 标题跟着变（现在 `title(address)` 只在开 tab 时快照一次）。用 `sidebar.right.pane.tab.title` 槽做活标题（该槽就是为此存在的），`title()` 只作为兜底。

## 2. 硬约束

1. 只改 `client.js`（locale 可选）；不动 `index.js`；不重启宿主。
2. 不新增自绘 composer、不接管 guide、不动 `panechat` 资源协议与 `thread` 只读视图的数据路径。
3. 纯 JS ESM；禁止 `git add -A`；一个 commit。
4. 颜色禁用色阶/渐变，只允许上述四个纯色点；`prefers-reduced-motion` 下不呼吸。

## 3. 验收（自查 + 回报）

| # | 断言 |
|---|---|
| P1 | `node --check client.js` |
| P2 | `grep -n "panechat.attention\|KeyA\|KeyY" client.js` |
| P3 | `grep -n "sidebar.right.pane.tab.title" client.js`（活标题已用） |
| P4 | 四态颜色常量存在且只出现在点样式里：`grep -c "FF9F0A\|FF453A\|30D158\|0A84FF" client.js` ≥ 4 |
| P5 | 既有 P0 功能未回退：`grep -c "data-dsh-thread-actions"` ≥ 1、`grep -c "data-dsh-thread-input"` = 0、`grep -c "setDraft"` ≥ 1 |
| P6 | 一个 commit，仅 `client.js`（+ locale） |

浏览器端（四个点是否真按状态变、`⌘⌥A` 是否跳对 tab、标题是否随会话名变）**由我验收**。

## 4. 回报格式

1. commit sha
2. P1–P6 逐条证据
3. 「未读 / 失败 / 等我」三态你实际用的是哪些字段（贴源码路径:行号）—— 这条最重要
4. 与本文档不一致的真实 API
5. 没做完的 + 原因

---

## 6. P1b 修正（实测后追加，2026-11-19 13:50）

浏览器实测结论：**`running` 点渲染正常**（采样到 `data-dsh-pane-state="running"`）、**活标题正常**（tab 标题自动跟到宿主的「11-19 13:46 · 仅回复 OK 的指令」）；但 **`ready` / `blocked` / `waiting` 三条实际不出现**，因此 `⌘⌥Y` 也永远找不到「下一个待处理」。

判断：`status.completionUnread` 在**嵌入式会话**里不可靠——面板一直挂着渲染，宿主侧很快就把它算成「已读」，所以 `ready` 条件恒假。

### 要做

1. **`ready` 自己数，不要读 `completionUnread`**：
   - 每个 panechat tab 记一个 `lastSeenSeq`（该 tab 上次处于聚焦状态的时刻，取当时 `latestTurnEvent(...)` 的 `turn/end` seq）。
   - 当 `turn/end` 的 seq > `lastSeenSeq` 且当前未运行 → `ready`。
   - `lastSeenSeq` 存在 tab 局部状态即可（内存），不需要持久化。
2. **`blocked`**：以 `session.promptError`/`lastAgentError` 或 `turn/end.reason.kind ∈ {error, interrupted}` 为准（现在这条链路保留即可），并**验证它真的会出现**。
3. **`waiting`**：`pendingInteraction != null` 为准，同样要验证。
4. `⌘⌥Y`：在①修好后，用「两个 panechat tab，一个跑完失焦」验证能跳过去；无待处理时给轻提示（已有）。
5. 三条状态都要在回报里给**可复现的验证步骤**（我需要照着点一遍）。

### 验收

| # | 断言 |
|---|---|
| F1 | `node --check client.js` |
| F2 | 不再依赖 `completionUnread` 判 ready（`grep -c completionUnread` 只在非 ready 路径，回报里说明） |
| F3 | 有「聚焦即清 ready」的逻辑（`lastSeen`/`seenSeq` 之类，`grep` 给证据） |
| F4 | 一个 commit，仅 `client.js` |
