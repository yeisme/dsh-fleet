# TASK P2 · 起手胶囊（只改 client.js）

> 前置：P0-①②③ 已上线并实测；HOST-1 已真机回归通过；P1 的 `running` 点 + 活标题可用，`ready/blocked/waiting` 在 P1c 修。
> 依据 `PANE-NATIVE.md` §5.3「hero（空态）」与 §14「白捡的能力」。

## 1. 目标

新建的 panechat 面板在**还没发消息**时，composer 上方给 3 个起手胶囊，点一下把提示词填进草稿（**不自动发送**）。

## 2. 关键约束（先读，别踩）

1. **不要走 hero**：panechat 为了避开「没有 Workspace 标签时 hero 禁用输入」的问题，固定传 `phase:'active', hero:false`（`client.js` 的 `PaneConversation`）。所以胶囊不能画在 hero 区。
2. **挂在 `conversation.composer.dock` 槽**：这是 session 作用域的 list 槽，composer 上方，专为此类附加件准备。用 `ctx.slots.inject('conversation.composer.dock', ...)` 注册；只在**该会话为空白**（没有 turn、草稿为空）时返回内容，否则返回 `null`（不要常驻占位）。
3. 点胶囊 = 往草稿里塞文字，用 `inputActions.setDraft(text)`（已在 P0-③ 用过，别再造一套）。

## 3. 三个胶囊怎么定

按会话 cwd 推断，最多 3 个，命中不了就给通用三条（不要为凑数编造路径）：

| 优先级 | 条件（cwd 里有什么） | 胶囊文案 | 塞入的草稿 |
|---|---|---|---|
| 1 | `package.json` 存在 | 跑一遍测试 | `跑一遍测试，失败项贴出来并说明原因。` |
| 2 | git 仓库（`.git`） | 看当前 diff | `看一下当前未提交的 diff，指出风险最大的三处改动。` |
| 3 | `README*` 存在 | 读 README 摘要 | `读一遍 README，用 5 行说明这个项目做什么、怎么跑。` |
| 兜底 | 都不命中 | 通用三条 | `先看一下当前目录结构，告诉我这是什么项目。` / `列出这个目录里最值得先看的三个文件。` / `有什么明显的坑？` |

判定需要目录信息：能用 `workspaceFiles` / `file` 资源就优先用；拿不到就**只给兜底三条**，不要发请求去猜。

## 4. 视觉与交互

- 胶囊：高 30px、圆角 7px、0.5px 发丝线、hover 时背景 `rgba(10,132,255,.08)`；文字 12px，左侧 14px 的小方块图标（不要 emoji）。
- 点击后胶囊**消失**（草稿非空），composer 获得焦点，光标在文末。
- `prefers-reduced-motion` 下不加任何过渡。
- 三个胶囊在窄面板（< 360px）自动换行，不出现横向滚动。

## 5. 硬约束

1. 只改 `client.js`（locale 可选）；不动 `index.js`；不重启宿主。
2. 不自绘 composer、不接管 guide、不新增路由请求。
3. 纯 JS ESM；禁止 `git add -A`；一个 commit。

## 6. 验收

| # | 断言 |
|---|---|
| S1 | `node --check client.js` |
| S2 | `grep -n "conversation.composer.dock" client.js` 有注册 |
| S3 | `grep -n "setDraft" client.js` 仍在使用（复用，不是新造） |
| S4 | 胶囊 DOM 带 `data-dsh-pane-starter` 属性（便于我断言） |
| S5 | 空白会话才出现：非空会话/有草稿时不渲染（回报里给判断条件） |
| S6 | 一个 commit，仅 `client.js`（+ locale） |

浏览器端（三个胶囊是否按 cwd 变、点击是否只填草稿、焦点是否到位）由我验收。
