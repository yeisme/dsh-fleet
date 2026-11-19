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
