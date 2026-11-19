# TASK P0-23 · 快捷键开面板 + 只读面板动作条

> 前置：P0-① 已落地（提交 `6b3b039`，`panechat` 面板类型可用，浏览器实测通过）。
> 本任务**只改 `client.js`**（+ locale 可选），因此改完由 HMR 自动生效，**不需要重启宿主**。
> 开工前读 [`PANE-NATIVE.md`](PANE-NATIVE.md) §4.3（只读面板的「接着问」）与 §6（键盘）。

## 1. 目标（两件事，一个 commit）

### A. `⌥⌘J` 直接开一个「会话面板」

现状：只能 `+` → 胶囊「新会话面板」→ 填目录 → 创建（三步）。要做成一步。

- 用 `ctx.shortcuts.register({ id, label, aliases, defaults, regions, modals, resolve })` 注册：
  - `id: 'panechat.new'`，`label: () => '新会话面板'`，`aliases: ['new pane', 'new chat panel']`
  - `defaults`：`desktop:macos/windows/linux` 与 `web:macos/windows` **都用** `{ code: 'KeyJ', modifiers: ['primary', 'alt'] }`
  - `regions: ['page', 'editable', 'terminal']`，`modals: []`
  - `resolve`：拿不到「当前主视图会话的 cwd」时返回 `{ status:'blocked', reason }`，否则 `{ status:'handled', run }`
- 键位选择依据（别再试已被占的）：`⌘N`/`⌥⌘N` = `session.new`，`⌘P`/`⌥⌘P` = 工作区文件，`⌘K`/`⌥⌘K` = 搜索会话，`⌘T`/`⌥⌘T` = 新浏览器 tab，`⌘W` = 关页，`⌘⇧B` = 右栏开关，`⌘\` 分屏，`⌘⌥↵` 全屏。**`⌥⌘J` 实测无占用**。若运行时发现被抢，改用 `⌥⌘U` 并在回报里说明。
- `run` 的行为（复用现有 `createPaneSession` 与 `openFromCommand` 的逻辑，别复制两份）：
  1. cwd：取当前会话 `useSessions` 的 cwd；取不到退化 `~`。
  2. `await createPaneSession(...)` 拿 sessionId。
  3. `openResource(paneAddress(id))` 打开面板（新建 tab，不要 `replaceTab`）。
  4. **焦点落在该面板的 composer，可直接打字**。先验证原生会话挂载后 composer 是否自动获焦；若没有，再补最小实现（不要 hack 别人的 DOM 结构，优先找受支持的聚焦入口），并把结论写进回报。

### B. 只读线程面板：删掉输入框，换动作条

现状：`thread` 面板底部是一个自绘 `textarea` + 发送/停止（`client.js` 里 `data-dsh-thread-input` 那一段）。P0-① 之后这条路线的语义已经站不住：面板要么是「真会话（原生输入框）」，要么是「只读视图」。

- **彻底移除该 textarea 及其发送/停止按钮**（`bound` 与否都移除；`~/.dsh/threads/pi` 的侧线也走同一条只读视图）。
- 底部换成动作条（新增 DOM 属性 `data-dsh-thread-actions`）：
  - 主按钮「接着问 → 开新会话」：把该线程**最近 20 条**消息拼成一段上下文前缀（用既有 `readMessages`/已渲染的数据，不要新路由），`sessions.create({ cwd: thread.cwd })` 建真会话 → `openResource(paneAddress(id))` 开 panechat 面板 → 用该会话的 `inputActions.setDraft(前缀)` 把上下文放进**草稿**（**绝不自动发送**）。
  - 次按钮「复制上下文」：同样的前缀写剪贴板，1.5s 提示「已复制」。
  - 保留既有「分叉」按钮作为第三入口（现状逻辑不动）。
  - 前缀格式固定：
    ```
    <外部会话上下文>
    [user] …
    [assistant] …
    </外部会话上下文>

    以下是接着上面这条外部会话继续的工作：
    ```
    超过 8000 字符从**最早**的消息开始截断，并在前缀末尾加一行 `（已截断，仅保留最近 N 条）`。
- 只读标识要常显：消息流顶部保留 `⧉ 只读 · 来源` 徽标（已有则复用）。

## 2. 硬约束

1. **只改 `client.js`（locale 可选）**；不动 `index.js`（宿主侧 6 个坑与 `force` 后门另开任务）。
2. 不要重启宿主；改完页面会自动热替换（HMR 500ms stat 轮询）。
3. 不要动 `panechat` 面板类型与资源协议的既有实现，除非为了复用抽函数。
4. 不能把只读线程塞进原生会话（`sessions.retain` 只认 DSH 会话 id，这条路是死的）。
5. 语言纯 JS ESM，无构建步骤；禁止 `git add -A`。

## 3. 验收（逐条自查 + 回报证据）

| # | 断言 | 怎么查 |
|---|---|---|
| B1 | 语法 | `node --check client.js` |
| B2 | 快捷键已注册 | `grep -n "panechat.new" client.js`，且 `grep -n "KeyJ" client.js` |
| B3 | 只读面板不再有输入框 | `grep -c "data-dsh-thread-input" client.js` = 0 |
| B4 | 动作条存在 | `grep -n "data-dsh-thread-actions" client.js` |
| B5 | 草稿注入用的是 setDraft | `grep -n "setDraft" client.js` |
| B6 | 既有线程功能未回退 | `git diff` 里 `dsh-resource://thread/pi/`、`/plugin/threads/stream`、分叉逻辑仍在 |
| B7 | 提交范围 | 一个 commit，仅 `client.js`（+ locale） |

浏览器端（`⌥⌘J` 是否开面板、composer 是否获焦、只读面板是否只剩动作条、接着问是否只进草稿）**由我验收**。

## 4. 回报格式

1. commit sha
2. B1–B7 逐条证据
3. composer 自动获焦的结论（原生就有 / 需要补 / 补了什么）
4. 与本文档不一致的真实 API（签名、服务名），以源码为准并指出
5. 没做完的 + 原因
