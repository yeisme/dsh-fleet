# dsh-fleet

**在 DSH 里管理 herdr 的 agent 舰队。**

DSH（DeepSeek Harness）插件。把 herdr 工作区里跑着的 agent —— 它们的会话、状态、卡点 —— 收进 DSH 的界面：一屏看全谁在干活、谁在等你、下一步推谁，并且能直接派活、答审批、中断、重启。

> 状态：早期开发中。P0（构建管线 / 契约 / 宿主层）已完成，P1（舰队页）进行中。

---

## 为什么

在 herdr 里开十几个 agent 面板是最常见的用法，但 herdr 是终端 TUI：你看得见每个 pane，看不见全局。

- 哪个 agent 卡在审批上等你？
- 哪个刚跑完但你没注意到？
- 上一个 agent 的结论，怎么接着喂给下一个？

dsh-fleet 把这些搬进 DSH 的 Web 界面：左栏是舰队名册，中间是选中 agent 的实时对话或屏幕，右栏是详情。herdr 继续管进程，DSH 管"看和推"。

## 能力

| 能力 | 状态 |
|---|---|
| 读 herdr 里 agent 的会话（pi / claude / codex 三种 transcript） | ✅ |
| 实时状态（working / blocked / idle / done，以及 `stalled` 派生态） | ✅ |
| 从 DSH 向 agent 发消息、答审批、中断 | ✅ |
| 可写策略（`all` / `dsh-only` / `read-only`，服务端强制） | ✅ |
| 舰队页（名册 / 舞台 / 派活） | 🚧 P1 |
| `@bot` 召唤、回执卡、终态唤醒 | 计划 P3 |

## 设计上的几个硬选择

**1. herdr 是唯一真相源，插件不复制状态。**
插件是 herdr socket 的客户端，`session.snapshot` + `events.subscribe` 是数据源。不做本地状态机，不做双写。

**2. 写操作必须带 `expectRevision`，屏幕变了就拒绝。**
你看到的界面和实际终端必须一致才允许输入。代价是 agent 正在输出时会返回 `screen-changed` 要你重试；收益是永远不会"以为在答 A 的审批，实际打进了 B 的输入框"。这是有意的，不是 bug。

**3. 危险动作要二次确认。**
`close` / `restart` / `worktree.remove` 必须显式 `confirm`。`send_keys` 走白名单。日志不记 prompt 内容。

**4. 不 fork 宿主。**
DSH 的输入框、消息渲染、会话机制都是宿主的。插件用宿主提供的 slot 和组件，不复制一份。

## 安装

需要 DSH（`@deepseek-ai/dsh`）和 [herdr](https://github.com/yeisme/herdr)。

```bash
git clone https://github.com/yeisme/dsh-fleet.git
cd dsh-fleet
bun install
bun run build
```

在你的 DSH profile 里 link：

```bash
cd ~/.dsh/profiles/web
bun add link:/path/to/dsh-fleet
```

然后在 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: fleet
      name: dsh-fleet
```

重启 DSH 生效。

## 开发

### 打开本地钩子（每个 clone 一次）

```bash
git config core.hooksPath .githooks
```

两道闸，各自拦一类真出过的事：

| 钩子 | 拦什么 | 为什么不换个位置 |
|---|---|---|
| `pre-commit` | `client.js` 与 `src/` 漂移、`fixtures/` 过期、暂存文件语法错、**个人路径/内网地址** | 这些都是几秒能查完的；放进 CI 就太晚——公开仓的泄露 push 出去就撤不回 |
| `pre-push` | 全量测试套件 | 套件跑几秒。放在每次提交会逼人用 `--no-verify`，放在 push 只付一次 |


```bash
bun run build        # 构建 src/ → dist/client.js
bun run build:client # 构建并写回 client.js（宿主 HMR 会热替换）
bun run dev          # watch 模式
bun run test         # 跑测试
bun run check        # 校验构建产物与 fixtures 没有漂移
```

**构建必须确定性**：同样源码两次构建逐字节一致。`bun run check` 会拦。

### 三条硬规则（来自实测，不是风格偏好）

1. **构建必须 `development: false`** —— 宿主的 require 种子表里有 `react/jsx-runtime`，但没有 `jsx-dev-runtime`，开着 dev 会在加载时断言失败。
2. **不要用 `state-done-*` 色** —— 暗色主题下它的值和 working 相同（都是 `#0A84FF`），状态点分不出来。用 `state-success`。
3. **按键用加号和弦 `ctrl+c`** —— herdr 只认 `ctrl+c` 形式，`ctrl-c` 会被当成字面量。

## 架构

```
src/          客户端源码（构建成 client.js）
lib/          宿主侧：herdr socket 客户端、transcript 解析、状态模型
lib/fleet/    状态存储、注意力模型、写操作、错误
test/         契约测试 + 单元测试 + 变异检查
fixtures/     确定性测试数据（由脚本生成，勿手改）
docs/design/  FLEET-API.md（契约）、FLEET-HOST.md（宿主设计）、PANE-NATIVE.md（面板模型）
```

契约写在 [`docs/design/FLEET-API.md`](docs/design/FLEET-API.md)，代码和测试都以它为准。

## 测试

```bash
bun run test
```

契约测试会对 fixture 的每个场景断言 schema；另有一组**变异检查**：故意破坏实现里的关键保护，确认测试会红。加新测试时请一并验它会失败 —— 抓不住 bug 的测试等于没有。

## 许可证

MIT
