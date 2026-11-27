# 外部 Agent Bot 接入指南

`dsh-fleet` 支持把你自己的任意 Agent Bot（Node.js / Python / 飞书机器人 / 定时巡检脚本 / 自定义守护进程）接入 Fleet 控制面：统一看状态、看执行帧、发指令、答审批、发中断。

所有外部 Bot 都会在 Fleet 中以 `bot:<id>` 作为 `paneId` 出现，并完全符合 `lib/fleet/contract.schema.json` 契约。

---

## 1. Node.js 5 行快速接入（零依赖 SDK）

仓库内置零外部依赖的 `FleetBotClient`（仅使用 `node:http` 与全局 `fetch`）：

```js
import { FleetBotClient } from './lib/sdk/bot-client.js'

const bot = new FleetBotClient({ id: 'pr-reviewer', name: 'pr-reviewer' })
await bot.start()
await bot.setStatus('working', { summary: 'Reviewing PR #42' })
const answer = await bot.requestApproval('Approve and merge PR #42? (y/n)')
await bot.pushFinal(`Operator decided: ${answer.text.trim() ? 'received' : 'empty'}`)
await bot.stop()
```

### 常用方法

| 方法 | 说明 |
|---|---|
| `await bot.start()` | 启动本地回调服务（默认 `127.0.0.1:0`），向 `/plugin/fleet/bots/register` 注册并开启定时心跳（`.unref()`）。 |
| `await bot.setStatus(status, { summary, screenText })` | 上报状态（`working` / `blocked` / `done` / `idle`）与摘要。 |
| `await bot.pushText(role, text)` | 推送 `text` 帧（`role`: `'user' \| 'assistant' \| 'system'`）。 |
| `await bot.pushWork(summary, rows, tokens)` | 推送 `work` 帧，`rows` 为 `{ verb, object, outcome?, ms? }[]`。 |
| `await bot.pushFinal(text, reason, ms)` | 推送 `final` 终态帧。 |
| `await bot.requestApproval(question, { timeoutMs })` | 推送问题文本并置为 `blocked`，返回 `Promise<{ text, enter }>`，在 DSH UI 点击审批回复后立即 resolve。 |
| `bot.onPrompt(fn)` / `bot.onInterrupt(fn)` | 监听 DSH 发来的 `prompt` 与 `interrupt` 动作，返回取消订阅函数。 |
| `await bot.stop()` | 停止心跳定时器并关闭本地回调服务（幂等，可重复调用）。 |

完整可运行示例见 [`examples/demo-bot.mjs`](../examples/demo-bot.mjs)。

---

## 2. Python / `curl` HTTP 接入

如果你的 Bot 不是 Node.js，直接调用 `/plugin/fleet/bots/*` 的 JSON HTTP 接口即可（所有 `POST` 请求必须带 `Content-Type: application/json`）。

### 端点总览

| 方法与路径 | 用途 |
|---|---|
| `POST /plugin/fleet/bots/register` | 注册或更新 Bot 元信息与 `callbackUrl` |
| `POST /plugin/fleet/bots/heartbeat` | 保活并可选更新 `status` / `summary` / `screenText` / `title` / `cwd` |
| `POST /plugin/fleet/bots/event` | 追加一条符合契约的 `Frame`（`text` / `work` / `final` / `reasoning` / `session`） |
| `GET /plugin/fleet/bots/list` | 查看所有已注册的外部 Bot 状态（不回传 `callbackUrl`） |

### `curl` 示例

```bash
BASE="http://127.0.0.1:3081"

# 1. 注册 Bot
curl -sS -X POST "$BASE/plugin/fleet/bots/register" \
  -H 'content-type: application/json' \
  -d '{
    "id": "patrol-bot",
    "name": "patrol-bot",
    "kind": "daemon",
    "workspaceLabel": "External Bots",
    "status": "working",
    "summary": "Checking cluster health",
    "ttlMs": 60000
  }'

# 2. 推送工作帧
curl -sS -X POST "$BASE/plugin/fleet/bots/event" \
  -H 'content-type: application/json' \
  -d '{
    "id": "patrol-bot",
    "frame": {
      "kind": "work",
      "summary": "Checked 3 services",
      "rows": [
        { "verb": "ping", "object": "api-gateway", "outcome": "ok", "ms": 42 }
      ],
      "tokens": null
    }
  }'

# 3. 定时心跳 + 状态更新
curl -sS -X POST "$BASE/plugin/fleet/bots/heartbeat" \
  -H 'content-type: application/json' \
  -d '{
    "id": "patrol-bot",
    "status": "done",
    "summary": "All services healthy"
  }'
```

### Python 示例（标准库 `urllib`，零第三方依赖）

```python
import json
import urllib.request

BASE = "http://127.0.0.1:3081"


def post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


post("/plugin/fleet/bots/register", {
    "id": "py-analyst",
    "name": "py-analyst",
    "kind": "python-agent",
    "workspaceLabel": "External Bots",
    "status": "working",
    "summary": "Generating daily report",
    "ttlMs": 60000,
})

post("/plugin/fleet/bots/event", {
    "id": "py-analyst",
    "frame": {
        "kind": "text",
        "role": "assistant",
        "text": "Fetched metrics and computed anomaly scores.",
    },
})

post("/plugin/fleet/bots/heartbeat", {
    "id": "py-analyst",
    "status": "done",
    "summary": "Daily report ready",
})
```

> **提示**：超过 `ttlMs`（默认 `60000` ms）未收到心跳或事件，Bot 会被标记为离线（`stale`），且不可写；重新发送心跳或事件后自动恢复在线。

---

## 3. 静态配置 `~/.dsh/fleet/bots.json`

对于常驻服务（例如飞书 Webhook 网关、本地常驻 Agent 守护进程），除了动态调用 `/register`，也可以直接声明在 `~/.dsh/fleet/bots.json` 中，随宿主启动自动加载：

```json
{
  "bots": [
    {
      "id": "feishu-ops",
      "name": "feishu-ops",
      "display": "Feishu Ops Bot",
      "kind": "feishu-bot",
      "workspaceLabel": "External Bots",
      "cwd": "/Users/me/projects/feishu-ops",
      "callbackUrl": "http://127.0.0.1:9101/dsh-callback",
      "capabilities": ["prompt", "answer", "interrupt"],
      "ttlMs": 60000,
      "initialOffline": true
    }
  ]
}
```

也支持顶层直接写成数组 `[ { "id": "...", ... } ]`。

常用字段说明：
- `id`（必填）：Bot 唯一标识，在 Fleet 中会映射为 `bot:<id>`。
- `name`（可选）：符合 `^[a-z][a-z0-9_-]{0,31}$` 的短名。
- `display` / `title` / `workspaceLabel`（可选）：在 UI 展示的名称与分组。
- `callbackUrl`（可选）：接收 DSH 写操作回调的 `http://` 或 `https://` 地址；未配置时该 Bot 为只读。
- `capabilities`（可选）：允许的动作白名单，默认 `["prompt", "answer", "interrupt"]`。
- `initialOffline`（可选）：设为 `true` 时启动默认离线，等待 Bot 发出第一次心跳后上线。

---

## 4. 审批与回调契约（`prompt` / `answer` / `interrupt`）

当用户在 DSH UI 对某个外部 Bot 发消息、答审批或点击中断时，`ExternalBotProvider` 会向该 Bot 注册的 `callbackUrl` 发送 `POST` JSON 请求：

### 1) `prompt`（向非阻塞 Bot 发送新指令）

仅当 Bot 在线且 `status !== 'blocked'` 时允许发送：

```json
{
  "verb": "prompt",
  "pane": "bot:pr-reviewer",
  "botId": "pr-reviewer",
  "text": "Please re-run lint checks"
}
```

### 2) `answer`（回答 `blocked` 状态下的审批问题）

仅当 Bot 在线、处于 `status === 'blocked'`，且客户端提交的 `expectRevision` 与服务端当前 `revision` 严格一致时才会下发（否则返回 `409 screen-changed`，绝不自动重试）：

```json
{
  "verb": "answer",
  "pane": "bot:pr-reviewer",
  "botId": "pr-reviewer",
  "text": "y",
  "enter": true,
  "expectRevision": 4
}
```

### 3) `interrupt`（中断当前任务）

```json
{
  "verb": "interrupt",
  "pane": "bot:pr-reviewer",
  "botId": "pr-reviewer"
}
```

### 回调响应要求与安全约束

- Bot 回调服务应在 `10s` 内返回 `2xx`（推荐 `200 { "ok": true }`）；非 `2xx` 会向 DSH 返回 `herdr-error`，超时返回 `timeout`。
- **禁止在日志或报错信息中打印 `prompt` / `answer` 的明文内容**。
- `callbackUrl` 仅保存在服务端内存中，`/plugin/fleet/bots/list` 与 `Pane` 对象永远不会向浏览器暴露回调地址或其中的密钥。
