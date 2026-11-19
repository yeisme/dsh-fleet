# 线程挂载（Attached threads）

> **下一版设计见 [`design/PANE-NATIVE.md`](design/PANE-NATIVE.md)**（面板即会话：面板改用原生 DSH 会话 + 原生输入框；「+」启动台参考 Codex Desktop；本文描述的是 v1 现状，将被它取代）。

把**终端里跑着的 agent 会话**读进 DSH Web UI，用 DSH 自己的界面看历史、追问、分叉。不做 TUI 页面，不做 DSH 子代理。

## 它做什么

- **发现**：扫描 `~/.config/herdr/session.json` 里每个 pane 绑定的 `agent_session`（当前 7 个 pi 面板），以及 `~/.pi/agent/sessions/**` 的磁盘会话与 DSH 自建侧线，最多 80 条（按 mtime）。
- **读取**：pi 会话 JSONL → 规范化消息（user / assistant+thinking+toolCall / toolResult / usage / 耗时），走带鉴权的插件路由 `GET /plugin/threads`、`/plugin/threads/messages`、`/plugin/threads/stream`（SSE，600ms 轮询增量）。
- **渲染**：右栏 `线程` tab：标题用会话真实标题，徽标标来源（herdr / 磁盘会话 / 侧线），消息含 markdown、推理折叠、工具调用与结果卡、耗时。
- **交互**：
  - 侧线（DSH 自建）可追问：`POST /plugin/threads/prompt` → `pi -p --session <file>`，SSE 增量回传；运行中可 `interrupt`。
  - `POST /plugin/threads/fork`：复制 JSONL 到 `~/.dsh/threads/pi/` 并换 header id —— 零模型调用、零污染的分叉。
  - 入口命令 `/threads [问题]`：给问题 = 开一条侧线并自动开栏；不给 = 返回线程统计。
- **不碰外部进程**：herdr 面板里的会话标记 `bound`，只读；要写就先分叉。这是有意的边界，不是缺陷。

## 已验证（本机实测）

- 线程列表 80 条，herdr 面板正确标记 `bound: true`。
- herdr 线程渲染完整：118 条消息、推理折叠、bash 工具卡与结果、耗时。
- 侧线端到端：`/threads 问题` → 精确打开**该**线程（回执带短 id，客户端等真实 id 再开）→ 栏内追问 → 答案 SSE 自动出现（4.1s）。
- **主线零污染**：新测试会话日志 `subagent-settled` 计数 = 0（旧子代理方案的会话为 93）。

## 边界与未做

1. **herdr live pane 只读**：写入需要 herdr 的 socket/插件协议（Ovis 是其编译产物插件），不逆向。要写 → 分叉。
2. **`claude` CLI 本机未安装**：适配器未实现，不承诺。
3. **codex 适配器**（`codex exec --json` / `resume`）尚未接；当前只接 pi。
4. **agent 工具未接**：`threads_list/read/fork/prompt` 工具（P3）待做；接口已按「一个操作、两个调用方」预留（同一路由函数）。
5. **`/btw` 名字**：旧子代理插件卸载后仍需宿主重启才释放命令名；期间 `/btw` 由旧插件响应，新引擎用 `/threads`。重启后 `/btw` 自动归本插件（代码已注册，冲突时静默跳过）。
6. 大会话（>8MB 增量 / >4000 条）会截断窗口；分页读取未做。
