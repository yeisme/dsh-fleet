# TASK P0-1 · 面板即会话：`panechat` 面板类型

> 这是一份**可直接执行的任务规格**。开工前先读 [`PANE-NATIVE.md`](PANE-NATIVE.md) 的第 2、3 节（裁决与架构），再动代码。
> 仓库：`/Users/yeisme/workspace/dsh-threads`（已 `git init`，基线提交 `a9a2345`）。

## 1. 目标（本轮只做这一件事）

给插件加一种新的右栏面板类型 `panechat`：**面板体直接渲染 DSH 原生会话**（`conversation.content` Factory 的 `embedded` 变体），因此面板里出现的是**原生 composer**（附件、@引用、斜杠命令、模型、权限、Plan、排队/插话、审批全都自带，一行 composer 代码都不要写）。

外加**一个可点的入口**：一个「新会话面板」启动页，选目录 → 点创建 → 变成会话面板。

**不要做的事**：不要动 `thread`（只读线程）那条既有路径；不要动 `index.js` 的宿主路由；不要自绘 composer；不要引入 npm 依赖或构建步骤。

## 2. 现状（先读这三个文件）

| 文件 | 作用 |
|---|---|
| `client.js` | 客户端半：`window.__ModuleLoader__.load({id:'@local/dsh-threads', factory(require){…}})`；现有 `thread` tab 类型 + 面板体 + 自绘输入框 |
| `index.js` | 宿主半：`/plugin/threads*` 路由、pi 子进程、SSE |
| `package.json` | `dsh.client` 段（`platform`/`immediately`/`inject`） |

现有 `thread` 类型注册在 `client.js:480-515`（`sidebarRightTabs.register` + `sidebar.right.pane.tab` + `.title`），资源地址前缀 `dsh-resource://thread/pi/`。

## 3. 要改的文件（只有这两个 + locale 可选）

### 3.1 `package.json` — 补 `dsh.client.inject`

现在只有 `platform`/`immediately`。必须补上这两个包，否则 `resources` 服务与 `conversation.content` Factory 不会到位：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": [
      "@deepseek-ai/dsh-client-resources",
      "@deepseek-ai/dsh-client-ui-conversation"
    ]
  }
}
```

### 3.2 `client.js` — 追加三段（不动既有代码）

**(a) 资源协议 `panechat`**

地址格式（唯一约定）：`dsh-resource://panechat/session/<encodeURIComponent(sessionId)>`

```js
const PANE_PREFIX = 'dsh-resource://panechat/session/'
const paneAddress = (id) => PANE_PREFIX + encodeURIComponent(id)
function parsePaneAddress(value) {
  if (typeof value !== 'string' || !value.startsWith(PANE_PREFIX)) return undefined
  try { const id = decodeURIComponent(value.slice(PANE_PREFIX.length)); return id === '' ? undefined : id }
  catch { return undefined }
}
```

资源 provider（**照抄** `@deepseek-ai/dsh-client-ui-subagent` 的 `sidebar-chat` 范式）：

```js
ctx.inject(['resources'], (scope) => {
  scope.effect(() => scope.resources.register({
    protocol: 'panechat',
    async *open(address, { signal }) {
      const id = parsePaneAddress(address)
      if (id === undefined) throw new Error(`dsh-threads: invalid panechat address "${address}"`)
      const reference = scope.sessions.retain(id, { source: 'paneChat', signal })
      try {
        yield { ok: true, value: { id, reference } }
        await new Promise((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      } finally { reference.release() }
    },
  }), 'threads: panechat resource')
})
```

**(b) tab 类型 `panechat` + 面板体**

```js
ctx.inject(['sidebarRightTabs'], (scope) => {
  scope.effect(() => scope.sidebarRightTabs.register({
    id: PANECHAT_ID,                 // '@local/dsh-threads/panechat'
    kind: 'panechat',
    patterns: [`${PANE_PREFIX}**`],
    priority: 'extension',
    canOpen: (a) => parsePaneAddress(a) !== undefined,
    title: () => t('paneTitle'),     // locale 里加：'会话' / 'Chat'
  }), 'threads: panechat tab type')
})

ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: PANECHAT_ID,
  children: { 'panechat.conversation': { kind: 'single', scope: 'session' } },
}, function PaneChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
  const { tab } = useTabInfo()
  const resource = useResource('panechat')(tab.contentId)
  if (resource.value === undefined) return null
  return h(SessionProvider, { session: resource.value.reference },
    renderSlot('panechat.conversation', {}))
}))

ctx.slots.inject('panechat.conversation', () => ctx.slots.register({
  name: 'panechat.conversation',
}, function PaneConversation(props) {
  const session = props.useSession((s) => s)
  const active = session.running === true || session.blank !== true
  const phase = active ? 'active' : 'hero'
  return props.renderFactorySlot('conversation.content',
    { variant: 'embedded', phase, hero: phase === 'hero' },
    { slots: { views: (p) => p.renderSlot('conversation.session', { view: 'chat' }) } })
}))
```

> 上面 `views` 的写法来自范本 `.../dsh-client-ui-subagent/src/client/sidebar-chat/index.tsx` 的 `FixedChatConversationView`——**去读那一份**（本机路径：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-subagent/src/client/sidebar-chat/index.tsx`，看 `:105-198`）。它是同一件事的官方实现，照它的注册次序抄。

**(c) 启动页 `panechat-start`（page 类型，可点入口）**

- 无 `patterns`（page 类型），`title: () => t('paneStart')`。
- body：一个窄表单——目录输入框（默认取 `props.useSession` 的当前会话 cwd，取不到就用 `'~'`）+ 「创建」按钮。
- 点创建：`const id = await ctx.sessions.create({ cwd })` → `ctx.sidebarRight.openResource(paneAddress(id), { replaceTab: true })`（把启动页替换成会话面板）。
- 失败要显示原因（不要把异常吞掉）。
- 注册到 `sidebarRightTabs`，并在 `guide` 里给一个 capsule：`{ id: 'new-pane', order: 10, title: () => '新会话面板', description: () => '选目录，开一个带原生输入框的面板' }`。

**(d) 命令（备用入口）**：`/panechat` → 在当前 cwd 建会话并开面板。参考现有命令注册（`index.js:615-637` 是 `/threads`；客户端命令用 `ctx.commands.register`）。

## 4. 硬约束

1. **不要重启 DSH 宿主**（会中断其他会话）。只改客户端文件，改完刷新页面即可生效。
2. **不要动 `index.js`**，除非为了加 `/panechat` 命令——即使加也只加新路由/新命令，不改既有路由行为。
3. 语言是**纯 JS ESM**，没有 TS、没有构建步骤：`declare module` 之类的类型合并不需要也不能用。
4. 插件注入的服务必须先 `inject` 再用（Cordis 会抛错）；`ctx.inject([...], fn)` 用于非必选服务。
5. 所有新样式加 `[data-dsh-pane…]` 属性前缀或独立 class 前缀，禁止裸类名（会被宿主主题 token 覆盖）。
6. 保持既有 `thread` 类型行为不变：它的 tab 类型、地址前缀、面板体一律不动。

## 5. 验收（逐条自查，回报时附证据）

| # | 断言 | 怎么查 |
|---|---|---|
| A1 | 语法通过 | `node --check client.js && node --check index.js` |
| A2 | 两个新类型已注册 | `grep -c "panechat" client.js` ≥ 6；`grep -n "kind: 'panechat'" client.js` |
| A3 | 用上原生会话工厂 | `grep -n "renderFactorySlot('conversation.content'" client.js` 有命中 |
| A4 | 声明了包依赖 | `python3 -c "import json;print(json.load(open('package.json'))['dsh']['client']['inject'])"` 含 `dsh-client-resources` 与 `dsh-client-ui-conversation` |
| A5 | 既有线程路径未回退 | `git diff --stat` 里 `thread` 相关行只增不改；`grep -c "dsh-resource://thread/pi/" client.js` ≥ 1 |
| A6 | 提交 | 一个 commit，仅含本轮文件；`git show --stat HEAD` 输出贴回 |

刷新页面后**由我**做浏览器验收（面板里出现原生 composer、`/` 出命令菜单、拖图能发）。你只负责代码 + 自查 + 提交。

## 6. 回报格式（缺一项算未完成）

1. commit sha
2. A1–A6 逐条证据（命令 + 关键输出）
3. 你实际用到的宿主 API 与**与本文档不一致**的地方（这条最有价值：我按文档写的规格可能有偏差，请指出真实签名）
4. 没做完的 + 原因
