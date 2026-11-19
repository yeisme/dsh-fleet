/**
 * Client half of `@local/dsh-threads`.
 *
 * One right-Sidebar tab type renders an attached thread: the conversation of a
 * `pi` session (herdr pane, disk session, or a DSH-owned side thread) streamed
 * from the host routes. The pane is the only UI; there is no terminal page.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-threads',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const TAB_ID = '@local/dsh-threads'
    const PREFIX = 'dsh-resource://thread/pi/'

    /* ---------------------------------------------------------------- addresses */

    /** @param key - `pi:<session id>`. @returns the Sidebar address for it. */
    function threadAddress(key) {
      return PREFIX + encodeURIComponent(key)
    }

    /** @param value - possible address. @returns the thread key, or undefined. */
    function parseThreadAddress(value) {
      if (typeof value !== 'string' || !value.startsWith(PREFIX)) return undefined
      try {
        const key = decodeURIComponent(value.slice(PREFIX.length))
        return key.startsWith('pi:') ? key : undefined
      } catch {
        return undefined
      }
    }

    /* ------------------------------------------------------------------ fetches */

    /** @param path - route path. @param init - fetch init. */
    async function call(path, init) {
      const response = await fetch(path, { credentials: 'same-origin', ...init })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = { ok: false, reason: `http-${response.status}` }
      }
      return payload
    }

    /** @returns every discovered thread. */
    async function listThreads() {
      const payload = await call('/plugin/threads')
      return payload?.ok === true ? payload.threads ?? [] : []
    }

    /** @param key - thread key. @param after - message offset. */
    async function readMessages(key, after) {
      return await call(`/plugin/threads/messages?key=${encodeURIComponent(key)}&after=${after}`)
    }

    /** @param key - thread key. @param text - prompt body. @param force - continue an attached session. */
    async function sendPrompt(key, text, force) {
      return await call('/plugin/threads/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, text, force: force === true }),
      })
    }

    /** @param key - thread key. */
    async function forkThread(key) {
      return await call('/plugin/threads/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      })
    }

    /** @param key - thread key. */
    async function interruptThread(key) {
      return await call('/plugin/threads/interrupt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      })
    }

    /* ----------------------------------------------------------------- markdown */

    /**
     * Render the subset of markdown these conversations actually contain.
     * @param text - message body.
     * @param keyPrefix - stable key prefix for React children.
     * @returns rendered nodes.
     */
    function markdown(text, keyPrefix) {
      const blocks = String(text ?? '').split(/```/u)
      const nodes = []
      blocks.forEach((block, index) => {
        if (index % 2 === 1) {
          const [first, ...rest] = block.split('\n')
          const language = /^[a-zA-Z0-9_+-]{1,20}$/u.test(first.trim()) ? first.trim() : ''
          const code = (language === '' ? block : rest.join('\n')).replace(/\n$/u, '')
          nodes.push(h('pre', { key: `${keyPrefix}-c${index}`, 'data-dsh-thread-code': '' },
            h('code', { 'data-lang': language }, code)))
          return
        }
        for (const chunk of block.split(/\n{2,}/u)) {
          if (chunk.trim() === '') continue
          nodes.push(h('p', { key: `${keyPrefix}-p${index}-${nodes.length}` }, ...inline(chunk, `${keyPrefix}-${nodes.length}`)))
        }
      })
      return nodes
    }

    /**
     * Split one paragraph into text and inline-code runs.
     * @param chunk - paragraph text.
     * @param prefix - child key prefix.
     * @returns rendered nodes.
     */
    function inline(chunk, prefix) {
      const parts = chunk.split(/(`[^`]+`)/u)
      return parts.map((part, index) => (part.startsWith('`') && part.endsWith('`') && part.length > 2
        ? h('code', { key: `${prefix}-i${index}` }, part.slice(1, -1))
        : h(React.Fragment, { key: `${prefix}-t${index}` }, part)))
    }

    /** @param value - milliseconds or seconds. @returns a short duration. */
    function duration(value) {
      const ms = Number(value ?? 0)
      if (!Number.isFinite(ms) || ms <= 0) return ''
      return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
    }

    /* ------------------------------------------------------------------ strings */

    const T = {
      zh: {
        pane: '线程',
        threads: '线程列表',
        empty: '选择一个线程开始查看。',
        loading: '读取中…',
        readonly: '该线程由外部终端持有：只读。可「分叉」出一条自己接管的线程继续聊。',
        fork: '分叉继续',
        stop: '停止',
        send: '发送',
        sent: '已发送',
        thinking: '推理过程',
        tools: '工具调用',
        result: '结果',
        error: '失败',
        placeholder: '追问这个线程…',
        cwd: '目录',
        herdr: 'herdr',
        session: '磁盘会话',
        side: '侧线',
        running: '运行中',
        attached: '外部持有',
        noComposer: '该会话不能从这里写入。',
      },
      en: {
        pane: 'Threads',
        threads: 'Threads',
        empty: 'Pick a thread to watch.',
        loading: 'Loading…',
        readonly: 'An external terminal owns this thread: read-only. Fork it to take over.',
        fork: 'Fork & continue',
        stop: 'Stop',
        send: 'Send',
        sent: 'Sent',
        thinking: 'Reasoning',
        tools: 'Tool calls',
        result: 'Result',
        error: 'Failed',
        placeholder: 'Ask this thread…',
        cwd: 'cwd',
        herdr: 'herdr',
        session: 'on disk',
        side: 'side',
        running: 'running',
        attached: 'external',
        noComposer: 'This session cannot be driven from here.',
      },
    }

    const CSS = `
[data-dsh-thread]{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);}
[data-dsh-thread-head]{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;}
[data-dsh-thread-title]{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;}
[data-dsh-thread-badge]{font-size:11px;line-height:1;padding:3px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;}
[data-dsh-thread-badge][data-tone="run"]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);}
[data-dsh-thread-list-btn]{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:6px;flex:none;}
[data-dsh-thread-list-btn]:hover{color:var(--dsw-alias-label-primary);}
[data-dsh-thread-scroll]{flex:1;min-height:0;overflow-y:auto;padding:10px 12px 4px;display:flex;flex-direction:column;gap:14px;}
[data-dsh-thread-msg]{display:flex;flex-direction:column;gap:6px;max-width:100%;}
[data-dsh-thread-msg][data-role="user"]{align-items:flex-end;}
[data-dsh-thread-msg][data-role="user"] [data-dsh-thread-body]{align-self:flex-end;background:var(--dsw-alias-bg-layer-2);border-radius:12px;padding:8px 11px;max-width:88%;}
[data-dsh-thread-role]{font-size:11px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);}
[data-dsh-thread-body]{font-size:13px;line-height:1.65;min-width:0;overflow-wrap:anywhere;}
[data-dsh-thread-body] p{margin:0 0 8px;}
[data-dsh-thread-body] p:last-child{margin-bottom:0;}
[data-dsh-thread-body] code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);padding:1px 4px;border-radius:4px;}
[data-dsh-thread-code]{margin:6px 0;padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);overflow-x:auto;}
[data-dsh-thread-code] code{background:none;padding:0;font-size:12px;line-height:1.5;white-space:pre;}
[data-dsh-thread-fold]{font-size:12px;color:var(--dsw-alias-label-secondary);}
[data-dsh-thread-fold] summary{cursor:pointer;list-style:none;}
[data-dsh-thread-fold] summary::-webkit-details-marker{display:none;}
[data-dsh-thread-fold] summary:hover{color:var(--dsw-alias-label-primary);}
[data-dsh-thread-fold-body]{margin-top:6px;padding-left:9px;border-left:2px solid var(--dsw-alias-border-l1);font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow-y:auto;}
[data-dsh-thread-tool]{font-size:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 9px;background:var(--dsw-alias-bg-layer-1);}
[data-dsh-thread-tool][data-error]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);}
[data-dsh-thread-tool] summary{cursor:pointer;list-style:none;display:flex;gap:6px;align-items:center;color:var(--dsw-alias-label-secondary);}
[data-dsh-thread-tool] summary::-webkit-details-marker{display:none;}
[data-dsh-thread-tool] b{font-weight:500;color:var(--dsw-alias-label-primary);}
[data-dsh-thread-tool] pre{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow-y:auto;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);}
[data-dsh-thread-meta]{font-size:11px;color:var(--dsw-alias-label-secondary);}
[data-dsh-thread-composer]{flex:none;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 10px 10px;display:flex;flex-direction:column;gap:6px;}
[data-dsh-thread-notice]{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
[data-dsh-thread-error]{font-size:11.5px;color:var(--dsw-alias-state-error-primary);}
[data-dsh-thread-box]{display:flex;align-items:flex-end;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:6px 6px 6px 10px;}
[data-dsh-thread-box]:focus-within{border-color:var(--dsw-alias-border-l2);}
[data-dsh-thread-input]{flex:1;min-width:0;border:none;outline:none;resize:none;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.55;max-height:240px;padding:4px 0;}
[data-dsh-thread-send]{flex:none;height:28px;min-width:28px;padding:0 10px;border-radius:9px;border:none;
  background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:12px;
  font-weight:500;cursor:pointer;}
[data-dsh-thread-send][disabled]{opacity:.45;cursor:default;}
[data-dsh-thread-stop]{flex:none;height:28px;padding:0 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;}
[data-dsh-thread-picker]{position:absolute;inset:auto 10px auto 10px;top:44px;z-index:30;max-height:60%;overflow-y:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.28);padding:4px;}
[data-dsh-thread-row]{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;border:none;background:transparent;color:inherit;font:inherit;font-size:12.5px;padding:7px 8px;border-radius:7px;cursor:pointer;}
[data-dsh-thread-row]:hover{background:var(--dsw-alias-bg-layer-2);}
[data-dsh-thread-row] span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
[data-dsh-thread-row] span:last-child{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none;}
@media (prefers-reduced-motion:reduce){[data-dsh-thread-send]{transition:none;}}
`

    /* -------------------------------------------------------------------- plugin */

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        const lang = (ctx.locale.getLocale?.()?.id ?? 'zh').startsWith('en') ? 'en' : 'zh'
        const t = (key) => T[lang][key] ?? T.zh[key] ?? key

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-threads', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'threads: styles')

        /** Right-column controller, captured once the service exists. */
        let sidebarRight
        ctx.inject(['sidebarRight'], (scope) => {
          sidebarRight = scope.sidebarRight
          scope.effect(() => () => { sidebarRight = undefined }, 'threads: sidebar handle')
        })

        /** One attached thread, streamed from the host. */
        function ThreadPane(props) {
          const tab = props.useTabInfo().tab
          const key = parseThreadAddress(tab.contentId)
          const [threads, setThreads] = useState([])
          const [listOpen, setListOpen] = useState(false)
          const [meta, setMeta] = useState({ title: '', source: '', bound: false, running: false, cwd: '' })
          const [messages, setMessages] = useState([])
          const [draft, setDraft] = useState('')
          const [notice, setNotice] = useState('')
          const [failure, setFailure] = useState('')
          const [sending, setSending] = useState(false)
          const scrollRef = useRef(null)
          const stickRef = useRef(true)
          const draftKey = key === undefined ? 'thread' : `dsh.threads.draft:${key}`

          // Draft survives tab switches and reloads.
          useEffect(() => {
            try { setDraft(window.localStorage.getItem(draftKey) ?? '') } catch { setDraft('') }
          }, [draftKey])
          useEffect(() => {
            try {
              if (draft === '') window.localStorage.removeItem(draftKey)
              else window.localStorage.setItem(draftKey, draft)
            } catch { /* storage may be disabled */ }
          }, [draft, draftKey])

          // Initial read plus the live stream.
          useEffect(() => {
            if (key === undefined) return undefined
            let after = 0
            let closed = false
            setMessages([])
            void readMessages(key, 0).then((payload) => {
              if (closed || payload?.ok !== true) return
              after = payload.after ?? 0
              setMeta({ title: payload.title ?? '', source: payload.source ?? '', bound: payload.bound === true, running: payload.running === true, cwd: payload.cwd ?? '' })
              setMessages(payload.messages ?? [])
            })
            const source = new EventSource(`/plugin/threads/stream?key=${encodeURIComponent(key)}&after=0`)
            source.addEventListener('ready', (event) => {
              const data = JSON.parse(event.data)
              after = data.after ?? after
              setMeta({ title: data.title ?? '', source: data.source ?? '', bound: data.bound === true, running: data.running === true, cwd: data.cwd ?? '' })
            })
            source.addEventListener('append', (event) => {
              const data = JSON.parse(event.data)
              if (Array.isArray(data.messages) && data.messages.length > 0) {
                setMessages((previous) => {
                  const seen = new Set(previous.map((message) => message.id))
                  const added = data.messages.filter((message) => !seen.has(message.id))
                  return added.length === 0 ? previous : [...previous, ...added]
                })
              }
              after = data.after ?? after
              setMeta((previous) => ({ ...previous, running: data.running === true }))
            })
            source.onerror = () => { /* reconnect is automatic */ }
            return () => {
              closed = true
              source.close()
            }
          }, [key])

          // Keep the transcript pinned unless the reader scrolled up.
          useEffect(() => {
            const node = scrollRef.current
            if (node === null || stickRef.current !== true) return
            node.scrollTop = node.scrollHeight
          }, [messages])

          const loadList = () => {
            setListOpen((previous) => {
              const next = !previous
              if (next) void listThreads().then(setThreads)
              return next
            })
          }

          const openThread = async (threadKey) => {
            setListOpen(false)
            try {
              sidebarRight?.openResource(threadAddress(threadKey), { kind: 'thread', revealIfOpened: true })
            } catch (error) {
              setFailure(String(error?.message ?? error))
            }
          }

          const submit = async (force) => {
            const text = draft.trim()
            if (text === '' || key === undefined) return
            setSending(true)
            setFailure('')
            const result = await sendPrompt(key, text, force)
            setSending(false)
            if (result?.ok === true) {
              setDraft('')
              setNotice(t('sent'))
              setMeta((previous) => ({ ...previous, running: true }))
              window.setTimeout(() => { setNotice('') }, 1500)
              return
            }
            setFailure(result?.detail ?? result?.reason ?? 'failed')
          }

          const stop = async () => {
            if (key === undefined) return
            await interruptThread(key)
            setMeta((previous) => ({ ...previous, running: false }))
          }

          const doFork = async () => {
            if (key === undefined) return
            const result = await forkThread(key)
            if (result?.ok !== true) {
              setFailure(result?.reason ?? 'fork-failed')
              return
            }
            await openThread(result.thread.key)
          }

          if (key === undefined) {
            return h('div', { 'data-dsh-thread': '' }, h('div', { 'data-dsh-thread-head': '' }, t('empty')))
          }

          const readonly = meta.bound === true

          return h('div', { 'data-dsh-thread': '', style: { position: 'relative' } },
            h('div', { 'data-dsh-thread-head': '' },
              h('div', { 'data-dsh-thread-title': '', title: meta.cwd }, meta.title === '' ? t('pane') : meta.title),
              h('span', { 'data-dsh-thread-badge': '', 'data-tone': meta.running ? 'run' : '' },
                meta.running ? t('running') : meta.source === 'herdr' ? t('herdr') : meta.source === 'side' ? t('side') : t('session')),
              h('button', { type: 'button', 'data-dsh-thread-list-btn': '', onClick: loadList }, t('threads')),
            ),
            listOpen && h('div', { 'data-dsh-thread-picker': '' },
              threads.map((thread) => h('button', {
                key: thread.key,
                type: 'button',
                'data-dsh-thread-row': '',
                onClick: () => { void openThread(thread.key) },
              },
              h('span', null, thread.title === '' ? thread.id.slice(0, 8) : thread.title),
              h('span', null, thread.source)))),
            h('div', {
              'data-dsh-thread-scroll': '',
              ref: scrollRef,
              onScroll: (event) => {
                const node = event.currentTarget
                stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
              },
            },
            messages.length === 0 ? h('div', { 'data-dsh-thread-meta': '' }, t('loading')) : null,
            messages.map((message) => h(Message, { key: `${message.seq}-${message.id}`, message, t }))),
            h('div', { 'data-dsh-thread-composer': '' },
              readonly && h('div', { 'data-dsh-thread-notice': '' },
                h('span', null, t('readonly')),
                h('button', { type: 'button', 'data-dsh-thread-list-btn': '', onClick: () => { void doFork() } }, t('fork'))),
              failure !== '' && h('div', { 'data-dsh-thread-error': '' }, `${t('error')}：${failure}`),
              notice !== '' && h('div', { 'data-dsh-thread-notice': '' }, notice),
              h('div', { 'data-dsh-thread-box': '' },
                h('textarea', {
                  'data-dsh-thread-input': '',
                  rows: 1,
                  value: draft,
                  placeholder: readonly ? t('noComposer') : t('placeholder'),
                  disabled: readonly,
                  onChange: (event) => {
                    setDraft(event.target.value)
                    const node = event.target
                    node.style.height = 'auto'
                    node.style.height = `${Math.min(node.scrollHeight, 240)}px`
                  },
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter' || event.shiftKey) return
                    if (event.nativeEvent?.isComposing === true || event.isComposing === true) return
                    event.preventDefault()
                    if (!readonly) void submit(false)
                  },
                }),
                meta.running
                  ? h('button', { type: 'button', 'data-dsh-thread-stop': '', onClick: () => { void stop() } }, t('stop'))
                  : h('button', {
                    type: 'button',
                    'data-dsh-thread-send': '',
                    disabled: readonly || sending || draft.trim() === '',
                    onClick: () => { void submit(false) },
                  }, t('send')))))
        }

        /** One transcript row. */
        function Message(props) {
          const { message, t } = props
          if (message.role === 'user') {
            return h('div', { 'data-dsh-thread-msg': '', 'data-role': 'user' },
              h('div', { 'data-dsh-thread-body': '' }, ...markdown(message.text, `u${message.seq}`)))
          }
          if (message.role === 'tool') {
            return h('div', { 'data-dsh-thread-msg': '' },
              h('details', { 'data-dsh-thread-tool': '', 'data-error': message.isError ? '' : undefined },
                h('summary', null,
                  h('b', null, message.toolName === '' ? 'tool' : message.toolName),
                  h('span', null, message.isError ? t('error') : t('result'))),
                h('pre', null, String(message.text ?? '').slice(0, 8000))))
          }
          if (message.role === 'assistant') {
            const usage = message.usage ?? {}
            const meta = [duration(message.durationMs), usage.outputTokens ? `${usage.outputTokens} tok` : ''].filter(Boolean).join(' · ')
            return h('div', { 'data-dsh-thread-msg': '' },
              message.thinking !== undefined && h('details', { 'data-dsh-thread-fold': '' },
                h('summary', null, t('thinking')),
                h('div', { 'data-dsh-thread-fold-body': '' }, message.thinking)),
              message.text !== '' && h('div', { 'data-dsh-thread-body': '' }, ...markdown(message.text, `a${message.seq}`)),
              (message.tools ?? []).map((tool) => h('details', { key: tool.callId, 'data-dsh-thread-tool': '' },
                h('summary', null, h('b', null, tool.name), h('span', null, t('tools'))),
                h('pre', null, typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args, null, 2)))),
              meta !== '' && h('div', { 'data-dsh-thread-meta': '' }, meta))
          }
          return h('div', { 'data-dsh-thread-msg': '' }, h('div', { 'data-dsh-thread-body': '' }, message.text ?? ''))
        }

        ctx.inject(['sidebarRightTabs'], (scope) => {
          scope.effect(() => scope.sidebarRightTabs.register({
            id: TAB_ID,
            kind: 'thread',
            patterns: [`${PREFIX}**`],
            priority: 'extension',
            canOpen: (address) => parseThreadAddress(address) !== undefined,
            title: () => t('pane'),
          }), 'threads: tab type')
        })

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
        }, ThreadPane))

        /** Live chip title: the thread's own name instead of the shared "线程". */
        function ThreadTitle(props) {
          const tab = props.useTabInfo().tab
          const key = parseThreadAddress(tab.contentId)
          const [title, setTitle] = useState('')
          useEffect(() => {
            if (key === undefined) return undefined
            let live = true
            void readMessages(key, 0).then((payload) => {
              if (live && payload?.ok === true) setTitle(String(payload.title ?? ''))
            })
            return () => { live = false }
          }, [key])
          return h(React.Fragment, null, title === '' ? t('pane') : title)
        }

        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
        }, ThreadTitle))

        // A completed /btw or /threads entry reveals the newest side thread.
        ctx.on('command/executed', (sessionId, name, result) => {
          if (name !== 'btw' && name !== 'threads') return
          if (result === null || result === undefined || result.kind !== 'success') return
          const shortId = /([0-9a-f]{8})/u.exec(String(result.text ?? ''))?.[1]
          void (async () => {
            // The receipt names one exact thread; wait for it rather than opening a
            // different conversation.
            for (let attempt = 0; attempt < 6; attempt += 1) {
              const threads = await listThreads()
              const exact = shortId === undefined
                ? threads[0]
                : threads.find((thread) => thread.id.startsWith(shortId))
              if (exact !== undefined) {
                try {
                  sidebarRight?.openResource(threadAddress(exact.key), { kind: 'thread', revealIfOpened: true })
                } catch { /* the column may be closed; the user can open it manually */ }
                return
              }
              await new Promise((resolve) => setTimeout(resolve, 400))
            }
          })()
        })
      },
    }
  },
})
