# TASK HOST-1 · 宿主侧六个坑 + 删 `force` 后门（只改代码，不重启）

> 范围：`index.js`（宿主半）。**本任务不重启宿主**——重启是独立步骤，由发单方另行安排。
> 依据：`PANE-NATIVE.md` §9「现在就该顺手修掉的 6 个坑」+ §9 R5（`force` 后门）。
> 相关代码都在 `index.js`，行号为当前 HEAD（`89c0e46`）附近，改动前请自行核对。

## 1. 六个必须修的坑

### 1.1 `MAX_MESSAGES` 到顶后流静默冻结

`readMessages()` 追加后 `slice(-MAX_MESSAGES)`，而 SSE `push()` 的判据是 `messages.length > after`。到 4000 条后 `length` 恒等于 4000 == `after`，`append` 永不再发。

**要求**：进度用**单调绝对序号**判断，不要用截断后数组长度。例如缓存里记 `total`（已解析的绝对条数），`after` 与 `total` 比较；返回给客户端的 `after` 也用绝对序号，客户端去重逻辑保持不变。

### 1.2 超长单行让偏移永不前进

分块读时 `length = min(size - offset, 8MB)`，`rest = lines.pop()`，`offset += bytesRead - byteLength(rest)`。若某一行本身 > 8MB（巨型 toolResult），整块都是残行 → `rest` 吃满 → 偏移不前进 → 每 600ms 重读 8MB 且永不推进。

**要求**：检测「本块没有任何换行」时把块大小翻倍重试（设上限，例如 64MB），或按字节找到下一个换行再切；无论如何**保证 offset 单调前进**，并在日志里 warn 一次「超大行」。

### 1.3 `spawn` 的 stdout 接了不读 → 管道满 → `running` 永不清

`stdio: ['ignore','pipe','pipe']` 但只监听 `stderr`。`pi -p` 的最终回答写 stdout，超过管道缓冲（~64KB）后子进程阻塞，`exit` 永不到来，`running` 里这条会话永远显示「运行中」。

**要求**：stdout 要么 `'ignore'`，要么显式消费（`child.stdout.resume()`）。改完要保证 `exit`/`close` 能可靠触发清理。

### 1.4 prompt 当 argv 传

`spawn('pi', ['-p','--session', path, text])`：以 `-` 开头的问题会被当选项解析；超长粘贴撞 `ARG_MAX`（E2BIG），错误只进宿主日志。

**要求**：用 `--` 终止选项解析（`['-p','--session',path,'--',text]`），并加长度保护（超限时截断并 warn，或改走 stdin，若 pi 支持）。以 `pi --help` 为准。

### 1.5 `interrupt` 只杀直接子进程

`state.child.kill('SIGTERM')` 之后，pi 派生的孙子进程继续写同一份 JSONL；UI 立刻显示可发送，文件仍被写。

**要求**：spawn 时 `detached: true`，interrupt 时杀进程组（`process.kill(-child.pid, 'SIGTERM')`，超时后 `SIGKILL`），并对 `ESRCH` 容错。

### 1.6 `bound` 判定不看 `agent_session.kind`

`herdrPanes()` 只取 `agent_session.value` 当路径，不看 `kind`。claude 的 pane 记录是 `{kind:'id', value:'<uuid>'}`，被当成路径塞进 `panes`（永不匹配，无害但也无用）；更危险的是符号链接/相对路径差异会让真正被占用的会话判成 `bound:false`，于是变成「可写」，两个写者并发改同一 JSONL。

**要求**：只接受 `kind === 'path'` 的绑定；路径比较前做 `realpath`（失败则退回原字符串），任何不确定都**偏向只读**（宁可误只读，不可误写）。

## 2. 必须删掉的后门

`POST /plugin/threads/prompt` 里 `if (thread.bound && payload?.force !== true)` —— 客户端**从未**发送 `force`，但任何同源 POST 都能带 `force:true` 对 herdr 正在写的会话并发起 `pi -p`。**删掉 `force` 放行分支**，`bound` 一律 409。

## 3. 硬约束

1. **不要重启宿主**，不要 `launchctl`，不要 kill 进程。改完只提交代码并说明「需要重启才生效」。
2. 不动客户端 `client.js`（另有任务在改，避免同文件冲突）。
3. 不改既有路由路径与响应字段名（客户端在跑）；只改内部实现与错误码语义。
4. 纯 JS ESM；禁止 `git add -A`。
5. 现有行为里**有意的**只读边界（herdr 面板只读、DSH 侧线可写）保留，只修上面 7 项。

## 4. 验收

| # | 断言 | 怎么查 |
|---|---|---|
| H1 | 语法 | `node --check index.js` |
| H2 | 无 `force` 放行 | `grep -c "force !== true\|payload?.force" index.js` = 0 |
| H3 | 绝对序号 | `grep -n "total" index.js`（diff 说明里解释单调性） |
| H4 | stdout 不裸接 | `grep -n "stdio" index.js` 且确认没有「只监听 stderr」 |
| H5 | 进程组 | `grep -n "detached\|process.kill(-" index.js` |
| H6 | realpath/kind | `grep -n "realpath\|kind === 'path'" index.js` |
| H7 | 提交范围 | 一个 commit，仅 `index.js` |

**运行时验证**（1.1/1.3/1.5 三条需要真跑）由发单方在**重启之后**做；本轮只要代码正确 + 静态自查。

## 5. 回报格式

1. commit sha
2. H1–H7 逐条证据
3. 每一条坑的「改前行为 → 改后行为」一句话（我需要能据此写回归验证）
4. 需要重启才生效的确认 + 你建议的验证命令（越具体越好）
5. 没做完的 + 原因
