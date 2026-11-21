/**
 * Client half of `@local/dsh-threads`.
 *
 * The right Sidebar hosts native DSH chats and read-only pi threads streamed
 * from the host routes (herdr panes, disk sessions, or DSH-owned side threads).
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-threads',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const TAB_ID = '@local/dsh-threads'
    const PREFIX = 'dsh-resource://thread/pi/'
    const PANECHAT_ID = '@local/dsh-threads/panechat'
    const PANE_START_ID = '@local/dsh-threads/panechat-start'
    const PANE_PREFIX = 'dsh-resource://panechat/session/'
    const ATTENTION_ORDER = ['waiting', 'blocked', 'ready']
    const PaneChatSession = React.createContext(undefined)
    const GENERIC_STARTERS = [
      ['先看目录结构', '先看一下当前目录结构，告诉我这是什么项目。'],
      ['找三个重点文件', '列出这个目录里最值得先看的三个文件。'],
      ['找明显的坑', '有什么明显的坑？'],
    ]

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

    /** @param key - thread key. */
    async function forkThread(key) {
      return await call('/plugin/threads/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      })
    }

    const EMPTY_THREAD = { meta: {}, messages: [], loaded: false, error: '', unread: false, ending: undefined }
    const emptySnapshot = () => undefined
    const emptySubscription = () => () => {}

    // Both title and body share the same transcript and stream, even when the body is hidden.
    function threadFeed(key) {
      let state = EMPTY_THREAD
      let stop
      const listeners = new Set()
      function publish(next) {
        state = next
        for (const listener of listeners) listener()
      }
      function update(data, initial = false) {
        const incoming = Array.isArray(data.messages) ? data.messages : []
        let { messages, ending, unread } = state
        if (incoming.length > 0) {
          if (initial) {
            const ids = new Set(incoming.map(({ id }) => id))
            messages = [...incoming, ...messages.filter(({ id }) => !ids.has(id))]
          } else {
            const ids = new Set(messages.map(({ id }) => id))
            messages = [...messages, ...incoming.filter(({ id }) => !ids.has(id))]
          }
          ending = messages.findLast(({ role }) => role === 'user' || role === 'assistant')
        }
        const { title, cwd, source, running } = { ...state.meta, ...data }
        const meta = { title, cwd, source, running }
        const stopped = state.meta.running === true && meta.running === false
        const completed = ending?.stopReason === 'stop' || ending?.stopReason === 'length'
        if (meta.running || (ending !== state.ending && !completed)) unread = false
        else if (!initial && state.loaded && completed && (stopped || ending.id !== state.ending?.id)) unread = true
        publish({ meta, messages, ending, unread, loaded: initial || state.loaded, error: initial ? '' : state.error })
      }
      function start() {
        let live = true
        let liveRunning
        void readMessages(key, 0).then((payload) => {
          if (!live) return
          if (payload?.ok !== true) throw new Error(payload?.reason ?? 'thread-read-failed')
          update({ ...payload, running: liveRunning ?? payload.running }, true)
        }).catch((error) => {
          if (live) publish({ ...state, error: String(error?.message ?? error) })
        })
        const stream = new EventSource('/plugin/threads/stream?key=' + encodeURIComponent(key) + '&after=0')
        const receive = (event) => {
          if (!live) return
          const data = JSON.parse(event.data)
          liveRunning = data.running ?? liveRunning
          update(data)
        }
        stream.addEventListener('ready', receive)
        stream.addEventListener('append', receive)
        return () => { live = false; stream.close() }
      }
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) stop = start()
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0) return
            stop()
            // A remount reconciles history by id, without turning the baseline into new activity.
            state = { ...state, messages: [], loaded: false }
          }
        },
        acknowledge() { if (state.unread) publish({ ...state, unread: false }) },
      }
    }

    function threadAttention(state) {
      if (state === undefined) return undefined
      if (state.meta.running === true) return 'running'
      if (state.ending?.stopReason === 'error') return 'blocked'
      if (state.unread) return 'ready'
      return undefined
    }

    const latestTurns = new WeakMap()

    function latestTurnEvents(source) {
      const snapshot = source.getSnapshot()
      const prior = latestTurns.get(source)
      if (prior?.revision === snapshot.revision) return prior
      const isEnd = ({ event }) => event.type === 'turn/end'
      const isBoundary = (entry) => entry.event.type === 'turn/start' || isEnd(entry)
      const { change, revision } = snapshot
      const previous = prior?.revision === revision - 1 && change.kind !== 'replace' ? prior : undefined
      const entries = previous === undefined ? snapshot.entries
        : change.kind === 'settle-assistant' ? [] : change.entries
      const boundary = entries.findLast(isBoundary)?.event
      const ending = entries.findLast(isEnd)?.event
      const latest = change.kind === 'prepend'
        ? { revision, boundary: previous?.boundary ?? boundary, ending: previous?.ending ?? ending }
        : { revision, boundary: boundary ?? previous?.boundary, ending: ending ?? previous?.ending }
      latestTurns.set(source, latest)
      return latest
    }

    function paneAttention(status, summary, binding, lastSeenSeq, resource) {
      if (status?.pendingInteraction != null) return 'waiting'
      if (resource?.status === 'failed') return 'blocked'
      const session = binding?.session.getSnapshot()
      const running = status?.running ?? session?.running ?? summary?.running
      const turn = binding && latestTurnEvents(binding.eventSource).boundary
      const reason = turn?.type === 'turn/end' ? turn.data.reason : undefined
      if (session?.promptError != null || session?.lastAgentError != null
        || reason?.kind === 'error' || reason?.kind === 'interrupted'
        || (reason?.kind === 'aborted' && reason.reason?.kind === 'hook'
          && reason.reason.reason === 'deepseek-account/signed-out')) return 'blocked'
      if (running === false && reason !== undefined && turn.seq > (lastSeenSeq ?? -1)) return 'ready'
      if (running) return 'running'
      return undefined
    }

    function useObservable(source) {
      // Bind the receiver: Session and event sources expose instance methods.
      const subscribe = React.useCallback((listener) => source?.subscribe(listener) ?? emptySubscription(), [source])
      const getSnapshot = React.useCallback(() => source?.getSnapshot(), [source])
      return React.useSyncExternalStore(subscribe, getSnapshot)
    }

    /** Branch glyph used by the continuation card and the fork tab chip. */
    function ForkGlyph({ attribute, size }) {
      const mark = attribute ?? 'data-dsh-fork-mark'
      return h('svg', {
        [mark]: '',
        width: size ?? 14,
        height: size ?? 14,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { flex: 'none', width: `${size ?? 14}px`, height: `${size ?? 14}px` },
      },
        h('path', {
          d: 'M4 3.2v5.4c0 1.3 1.1 2.4 2.4 2.4H12',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinecap: 'round',
        }),
        h('circle', { cx: '4', cy: '2.6', r: '1.5', fill: 'currentColor' }),
        h('circle', { cx: '12.6', cy: '11', r: '1.5', fill: 'currentColor' }))
    }

    function tabCaption(title, state, t, forked) {
      return h('span', { 'data-dsh-pane-title': '', title },
        forked === true && h(ForkGlyph, { attribute: 'data-dsh-fork-tabmark', size: 11 }),
        state && h('span', { 'data-dsh-pane-state': state, role: 'img', 'aria-label': t(state), title: t(state) }),
        h('span', { 'data-dsh-pane-title-text': '' }, title))
    }

    function nextAttention(tabs, currentId, statusOf) {
      const index = tabs.findIndex(({ id }) => id === currentId)
      const ordered = [...tabs.slice(index + 1), ...tabs.slice(0, index + 1)]
      const candidates = ordered.map((tab) => ({ tab, state: statusOf(tab) }))
      for (const state of ATTENTION_ORDER) {
        const next = candidates.find((candidate) => candidate.state === state && candidate.tab.id !== currentId)
        if (next !== undefined) return next.tab
      }
      return candidates.find(({ state }) => ATTENTION_ORDER.includes(state))?.tab
    }

    function renderedTabControls(owner) {
      const controls = new Map()
      for (const element of document.querySelectorAll('[data-sidebar-right-tab]')) {
        const control = element.closest('[data-dockkit-tab], [data-dockkit-float-title]')
        if (control?.closest('[data-sidebar-right-session]')?.dataset.sidebarRightSession !== owner) continue
        controls.set(element.dataset.sidebarRightTab, control)
      }
      return controls
    }

    function registerAttentionShortcut(ctx, t, paneCursors, feeds) {
      ctx.inject(['sidebarRight', 'shortcuts', 'uiSession', 'resources'], (scope) => {
        const { sidebarRight, shortcuts, uiSession, sessions, resources } = scope
        let notice, timer, focusFrame
        const clearNotice = () => { clearTimeout(timer); notice?.remove(); notice = undefined }
        function showNotice() {
          clearNotice()
          notice = document.createElement('div')
          notice.setAttribute('data-dsh-pane-notice', '')
          notice.setAttribute('role', 'status')
          notice.textContent = t('noAttention')
          document.body.appendChild(notice)
          timer = setTimeout(clearNotice, 1500)
        }

        function resolve({ target }) {
          const owner = sidebarRight.mounted.getSnapshot()
          return { status: 'handled', run: () => {
            cancelAnimationFrame(focusFrame)
            if (sidebarRight.mounted.getSnapshot() !== owner) return
            if (owner === undefined) return showNotice()
            const controls = renderedTabControls(owner)
            const committed = sidebarRight.tabsIn(owner)
            const byId = new Map(committed.map((tab) => [tab.id, tab]))
            const firstChat = new Map()
            for (const { id, kind, contentId } of committed) {
              if (kind === 'panechat' && !firstChat.has(contentId)) firstChat.set(contentId, id)
            }
            const ids = new Set([...controls.keys(), ...byId.keys()])
            const tabs = Array.from(ids, (id) => byId.get(id)).filter(Boolean)
            const current = sidebarRight.focusedTarget(target)?.tabId ?? sidebarRight.active()?.id
            const statuses = uiSession.sessionStatus.getSnapshot()
            const summaries = sessions.list.getSnapshot().byId
            const next = nextAttention(tabs, current, ({ id: tabId, kind, contentId }) => {
              if (kind === 'thread') return threadAttention(feeds.get(parseThreadAddress(contentId))?.getSnapshot())
              if (kind !== 'panechat') return undefined
              const id = parsePaneAddress(contentId)
              if (id === undefined || id === owner || firstChat.get(contentId) !== tabId) return undefined
              const resource = resources.source(contentId).getSnapshot()
              return paneAttention(statuses.get(id), summaries[id], sessions.binding(id),
                paneCursors.get(owner, tabId, contentId), resource)
            })
            if (next === undefined) return showNotice()
            clearNotice()
            // The host focuses both the tab and its pane; expanding then reveals a docked target.
            sidebarRight.focus(next.id)
            if (!sidebarRight.isExpanded() && sidebarRight.commandTarget(null)?.tabId === next.id) sidebarRight.toggleExpanded()
            focusFrame = requestAnimationFrame(() => {
              if (sidebarRight.mounted.getSnapshot() !== owner || sidebarRight.active()?.id !== next.id
                || sidebarRight.focusedTarget()?.tabId === next.id) return
              const control = renderedTabControls(owner).get(next.id)
              const destination = control?.matches('[data-dockkit-float-title]')
                ? control.closest('[data-dockkit-float]') : control
              destination?.focus({ preventScroll: true })
            })
          } }
        }

        scope.effect(() => {
          const primary = { code: 'KeyA', modifiers: ['primary', 'alt'] }
          const fallback = { ...primary, code: 'KeyY' }
          const register = (desktop) => shortcuts.register({
            id: 'panechat.attention',
            label: () => t('attention'),
            aliases: ['next attention panel', 'next pending chat'],
            // Web reserves the primary combination for session.archive.
            defaults: { 'desktop:macos': desktop, 'desktop:windows': desktop, 'web:macos': fallback, 'web:windows': fallback },
            regions: ['page', 'editable', 'terminal'],
            modals: [],
            resolve,
          })
          let desktop = primary
          if (shortcuts.runtime === 'desktop' && shortcuts.platform !== 'linux') {
            const { issue, conflicts } = shortcuts.describeBinding(primary)
            if (issue !== null || conflicts.length > 0) desktop = fallback
          }
          let dispose
          try { dispose = register(desktop) } catch (error) {
            if (desktop === fallback || !String(error?.message ?? error).startsWith('Conflicting shortcut defaults:')) throw error
            dispose = register(fallback)
          }
          return () => { cancelAnimationFrame(focusFrame); clearNotice(); dispose() }
        }, 'threads: next attention panel')
      })
    }

    function paneReadCursors() {
      const cursors = new Map()
      return {
        get(owner, tabId, contentId) {
          const cursor = cursors.get(contentId)
          return cursor?.owner === owner && cursor.tabId === tabId ? cursor.lastSeenSeq : undefined
        },
        observe(owner, tab, seq, focused) {
          if (tab.signal.aborted) return undefined
          let cursor = cursors.get(tab.contentId)
          if (cursor?.signal !== tab.signal || cursor.owner !== owner || cursor.tabId !== tab.id) {
            // Existing history is the baseline when a tab first acquires its event window.
            cursor = { signal: tab.signal, owner, tabId: tab.id, lastSeenSeq: seq }
            cursors.set(tab.contentId, cursor)
            tab.signal.addEventListener('abort', () => {
              if (cursors.get(tab.contentId) === cursor) cursors.delete(tab.contentId)
            }, { once: true })
          } else if (focused) {
            cursor.lastSeenSeq = Math.max(cursor.lastSeenSeq, seq)
          }
          return cursor.lastSeenSeq
        },
      }
    }

    function threadContext(messages) {
      const head = '<外部会话上下文>\n'
      const tail = '</外部会话上下文>\n\n以下是接着上面这条外部会话继续的工作：'
      const limit = 8000
      const lines = messages.filter(({ role, text }) => (role === 'user' || role === 'assistant') && text.trim() !== '')
        .slice(-20).map(({ role, text }) => '[' + role + '] ' + text.trim() + '\n')
      let body = lines.join('')
      if (head.length + body.length + tail.length <= limit) return head + body + tail

      const note = () => '\n（已截断，仅保留最近 ' + lines.length + ' 条）'
      while (lines.length > 1 && head.length + body.length + tail.length + note().length > limit) {
        body = body.slice(lines.shift().length)
      }
      const available = limit - head.length - tail.length - note().length
      if (body.length > available) {
        const label = body.slice(0, body.indexOf('] ') + 2)
        const end = body.slice(-(available - label.length)).replace(/^[\uDC00-\uDFFF]/u, '')
        body = label + end
      }
      return head + body + tail + note()
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
        readonly: '只读',
        fork: '分叉继续',
        follow: '接着问 → 开新会话',
        copy: '复制上下文',
        copied: '已复制',
        unavailable: '会话面板当前不可用',
        thinking: '推理过程',
        tools: '工具调用',
        result: '结果',
        error: '失败',
        herdr: 'herdr',
        session: '磁盘会话',
        side: '侧线',
        running: '运行中',
        waiting: '等你',
        blocked: '卡住',
        ready: '就绪',
        attention: '跳到下一个待处理面板',
        noAttention: '没有待处理的面板',
      },
      en: {
        pane: 'Threads',
        threads: 'Threads',
        empty: 'Pick a thread to watch.',
        loading: 'Loading…',
        readonly: 'Read-only',
        fork: 'Fork & continue',
        follow: 'Follow up → New chat',
        copy: 'Copy context',
        copied: 'Copied',
        unavailable: 'Chat panels are unavailable',
        thinking: 'Reasoning',
        tools: 'Tool calls',
        result: 'Result',
        error: 'Failed',
        herdr: 'herdr',
        session: 'on disk',
        side: 'side',
        running: 'running',
        waiting: 'Needs input',
        blocked: 'Blocked',
        ready: 'Ready',
        attention: 'Go to the next panel needing attention',
        noAttention: 'No panels need attention',
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
[data-dsh-thread-actions]{flex:none;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 10px 10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
[data-dsh-thread-notice]{flex-basis:100%;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);}
[data-dsh-thread-error]{font-size:11.5px;color:var(--dsw-alias-state-error-primary);}
[data-dsh-thread-action]{min-height:28px;padding:3px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;}
[data-dsh-thread-action="primary"]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-weight:500;}
[data-dsh-thread-action]:disabled{opacity:.45;cursor:default;}
[data-dsh-thread-picker]{position:absolute;inset:auto 10px auto 10px;top:44px;z-index:30;max-height:60%;overflow-y:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.28);padding:4px;}
[data-dsh-thread-row]{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;border:none;background:transparent;color:inherit;font:inherit;font-size:12.5px;padding:7px 8px;border-radius:7px;cursor:pointer;}
[data-dsh-thread-row]:hover{background:var(--dsw-alias-bg-layer-2);}
[data-dsh-thread-row] span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
[data-dsh-thread-row] span:last-child{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none;}
[data-dsh-pane-title]{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;}
[data-dsh-pane-title-text]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-dsh-pane-state]{width:6px;height:6px;flex:0 0 6px;border-radius:50%;}
[data-dsh-pane-state="waiting"]{background:#FF9F0A;}
[data-dsh-pane-state="blocked"]{background:#FF453A;}
[data-dsh-pane-state="ready"]{background:#30D158;}
[data-dsh-pane-state="running"]{background:#0A84FF;}
@media (prefers-reduced-motion:no-preference){[data-dsh-pane-state="running"]{animation:dsh-pane-pulse 2s ease-in-out infinite;}}
@keyframes dsh-pane-pulse{50%{opacity:.45;}}
[data-dsh-pane-notice]{position:fixed;inset:auto 16px 16px auto;z-index:1000;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);pointer-events:none;}
[data-dsh-pane-starter-seat]{width:100%;max-width:var(--dsh-composer-card-max-width);}
[data-dsh-pane-starter-group]{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding-bottom:6px;}
[data-dsh-pane-starter]{box-sizing:border-box;max-width:100%;height:30px;display:inline-flex;align-items:center;gap:6px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;}
[data-dsh-pane-starter]:hover{background:rgba(10,132,255,.08);color:var(--dsw-alias-label-primary);}
[data-dsh-pane-starter-icon]{width:14px;height:14px;flex:0 0 14px;border:1px solid currentColor;border-radius:3px;box-sizing:border-box;}
@media (prefers-reduced-motion:reduce){[data-dsh-pane-starter]{transition:none;}}
`

    /* -------------------------------------------------------------------- plugin */

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        const t = (key) => ctx.locale.resolveText({ zh: T.zh[key], en: T.en[key] })

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-threads', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'threads: styles')

        /** Right-column controller, captured once the service exists. */
        let sidebarRight
        const feeds = new Map()
        function useThread(key) {
          const feed = React.useMemo(() => {
            if (key === undefined) return undefined
            if (!feeds.has(key)) feeds.set(key, threadFeed(key))
            return feeds.get(key)
          }, [key])
          const state = React.useSyncExternalStore(feed?.subscribe ?? emptySubscription, feed?.getSnapshot ?? emptySnapshot)
          return { feed, state: state ?? EMPTY_THREAD }
        }

        ctx.inject(['sidebarRight'], (scope) => {
          sidebarRight = scope.sidebarRight
          scope.effect(() => () => { sidebarRight = undefined }, 'threads: sidebar handle')
          const { openTabs } = scope.sidebarRight
          scope.effect(() => openTabs.subscribe(() => {
            const keys = new Set(openTabs.getSnapshot().filter(({ kind }) => kind === 'thread')
              .map(({ contentId }) => parseThreadAddress(contentId)))
            for (const key of feeds.keys()) if (!keys.has(key)) feeds.delete(key)
          }), 'threads: prune closed thread status')
        })

        let openFollowUp
        ctx.inject(['conversation', 'remote'], (scope) => {
          openFollowUp = (tab, cwd, draft) => openPane(scope, cwd || '~',
            (address) => tab.actions.openResource(address), { draft, signal: tab.signal })
          scope.effect(() => () => { openFollowUp = undefined }, 'threads: follow-up action')
        })

        /** One attached thread, streamed from the host. */
        function ThreadPane(props) {
          const tab = props.useTabInfo().tab
          const key = parseThreadAddress(tab.contentId)
          const { feed, state: { meta, messages, loaded, error } } = useThread(key)
          const [threads, setThreads] = useState([])
          const [listOpen, setListOpen] = useState(false)
          const [notice, setNotice] = useState('')
          const [failure, setFailure] = useState('')
          const [opening, setOpening] = useState(false)
          const scrollRef = useRef(null)
          const stickRef = useRef(true)
          const copyTimer = useRef(undefined)

          useEffect(() => () => clearTimeout(copyTimer.current), [])
          useEffect(() => { if (tab.visible) feed?.acknowledge() }, [feed, tab.visible, messages, meta.running])

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

          const followUp = async () => {
            if (opening || !loaded) return
            setOpening(true)
            setFailure('')
            try {
              if (openFollowUp === undefined) throw new Error(t('unavailable'))
              await openFollowUp(tab, meta.cwd, threadContext(messages))
            } catch (error) {
              if (!tab.signal.aborted) setFailure(String(error?.message ?? error))
            } finally {
              if (!tab.signal.aborted) setOpening(false)
            }
          }

          const copyContext = async () => {
            if (!loaded) return
            setFailure('')
            try {
              await navigator.clipboard.writeText(threadContext(messages))
              if (tab.signal.aborted) return
              clearTimeout(copyTimer.current)
              setNotice(t('copied'))
              copyTimer.current = setTimeout(() => setNotice(''), 1500)
            } catch (error) {
              if (!tab.signal.aborted) setFailure(String(error?.message ?? error))
            }
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

          const source = meta.source === 'herdr' ? t('herdr') : meta.source === 'side' ? t('side') : t('session')

          return h('div', { 'data-dsh-thread': '', style: { position: 'relative' } },
            h('div', { 'data-dsh-thread-head': '' },
              h('div', { 'data-dsh-thread-title': '', title: meta.cwd }, meta.title || t('pane')),
              h('span', { 'data-dsh-thread-badge': '', 'data-tone': meta.running ? 'run' : '' },
                ['⧉ ' + t('readonly'), source, ...(meta.running ? [t('running')] : [])].join(' · ')),
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
            !loaded && messages.length === 0 ? h('div', { 'data-dsh-thread-meta': '' }, t('loading')) : null,
            messages.map((message) => h(Message, { key: `${message.seq}-${message.id}`, message, t }))),
            h('div', { 'data-dsh-thread-actions': '' },
              h('button', { type: 'button', 'data-dsh-thread-action': 'primary', disabled: opening || !loaded,
                onClick: () => { void followUp() } }, t('follow')),
              h('button', { type: 'button', 'data-dsh-thread-action': '', disabled: !loaded,
                onClick: () => { void copyContext() } }, t('copy')),
              h('button', { type: 'button', 'data-dsh-thread-action': '', onClick: () => { void doFork() } }, t('fork')),
              (failure || error) && h('div', { role: 'alert', 'data-dsh-thread-error': '' }, t('error') + '：' + (failure || error)),
              notice !== '' && h('div', { role: 'status', 'data-dsh-thread-notice': '' }, notice)))
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
          const { state } = useThread(parseThreadAddress(tab.contentId))
          return tabCaption('⧉ ' + (state.meta.title || tab.title || t('pane')), threadAttention(state), t)
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

        const paneCursors = paneReadCursors()
        registerPaneChat(ctx, t, paneCursors)
        registerAttentionShortcut(ctx, t, paneCursors, feeds)
      },
    }

    function paneAddress(id) {
      return PANE_PREFIX + encodeURIComponent(id)
    }

    function parsePaneAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(PANE_PREFIX)) return undefined
      try {
        const id = decodeURIComponent(address.slice(PANE_PREFIX.length))
        return id !== '' && paneAddress(id) === address ? id : undefined
      } catch {
        return undefined
      }
    }

    function waitForAbort(signal) {
      if (signal.aborted) return Promise.resolve()
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    }

    function FixedPaneChatView({ renderSlot }) {
      return renderSlot('conversation.session', { view: 'chat' })
    }

    function PaneConversation({ sessionId, renderFactorySlot }) {
      // Sessions created by directory are ungrouped; the Hero composer requires a Workspace.
      return h(PaneChatSession.Provider, { value: sessionId },
        renderFactorySlot('conversation.content',
          { variant: 'embedded', phase: 'active', hero: false },
          { slots: { views: FixedPaneChatView } }))
    }

    function paneStarterEntries(files) {
      const starters = []
      if (files.some(({ name, type }) => name === 'package.json' && type === 'file')) {
        starters.push(['跑一遍测试', '跑一遍测试，失败项贴出来并说明原因。'])
      }
      if (files.some(({ name, type }) => name === '.git' && (type === 'directory' || type === 'file'))) {
        starters.push(['看当前 diff', '看一下当前未提交的 diff，指出风险最大的三处改动。'])
      }
      if (files.some(({ name, type }) => type === 'file' && name.startsWith('README'))) {
        starters.push(['读 README 摘要', '读一遍 README，用 5 行说明这个项目做什么、怎么跑。'])
      }
      return starters.length === 0 ? GENERIC_STARTERS : starters
    }

    function PaneStarter({ scope, sessionId, cwd, inputActions }) {
      const anchor = useRef(null)
      const [seat, setSeat] = useState(null)
      const [starters, setStarters] = useState(GENERIC_STARTERS)

      React.useLayoutEffect(() => {
        // The host mounts this slot below the card. Give only our row a seat above it.
        const card = anchor.current?.closest('[data-composer-dock]')?.previousElementSibling
        if (!card?.matches('[data-composer-card]')) return
        const container = card.ownerDocument.createElement('div')
        container.setAttribute('data-dsh-pane-starter-seat', '')
        card.before(container)
        setSeat(container)
        return () => container.remove()
      }, [])

      useEffect(() => {
        const workspaceFiles = scope.get('remote.workspaceFiles')
        if (!cwd || typeof workspaceFiles?.list !== 'function') return
        const controller = new AbortController()
        const { signal } = controller
        void (async () => {
          try {
            const result = await workspaceFiles.list(sessionId, '.', signal)
            if (!signal.aborted && result.ok) setStarters(paneStarterEntries(result.value.entries))
          } catch { /* keep the generic prompts when the directory is unavailable */ }
        })()
        return () => controller.abort()
      }, [scope, sessionId, cwd])

      function choose(text) {
        const sessionScope = scope.sessions.scope(sessionId)
        if (sessionScope === undefined) return
        const input = scope.conversation.input.for(sessionScope)
        inputActions.setDraft(text)
        input.focus()
      }

      const buttons = h('div', { 'data-dsh-pane-starter-group': '', role: 'group', 'aria-label': '起手提示词' },
        starters.map(([label, text]) => h('button', {
          key: label, type: 'button', 'data-dsh-pane-starter': '', onClick: () => choose(text),
        }, h('span', { 'data-dsh-pane-starter-icon': '', 'aria-hidden': 'true' }), label)))
      return h(React.Fragment, null, h('span', { ref: anchor, hidden: true }),
        seat === null ? buttons : createPortal(buttons, seat))
    }

    async function createPaneSession(scope, cwd) {
      const directory = cwd.trim()
      if (directory === '~' || directory.startsWith('~/')) {
        const home = scope.remote.$host.home
        if (home === undefined) throw new Error(scope.locale.resolveText({
          zh: '宿主主目录尚不可用', en: 'The host home directory is unavailable',
        }))
        return scope.sessions.create({ cwd: home + directory.slice(1) })
      }
      return scope.sessions.create({ cwd: directory })
    }

    async function openPane(scope, cwd, open, { draft, signal } = {}) {
      signal?.throwIfAborted()
      const id = await createPaneSession(scope, cwd)
      const address = paneAddress(id)
      if (draft === undefined) {
        open(address)
        return
      }
      // Keep the exact target scope alive until its editor owns the draft.
      await scope.sessions.using(id, { source: 'paneChat', signal }, (reference) => {
        signal?.throwIfAborted()
        const input = scope.conversation.input.for(reference.binding.ctx)
        open(address)
        input.setDraft(draft)
      })
    }

    /**
     * Whether a fork refusal only means "this chat has no completed turn to
     * carry over". Declared as a hoisted function (not a const) so a freshly
     * hot-replaced bundle can never observe it before initialization.
     * @param code - RPC error code reported by the fork.
     * @returns true when a fresh chat in the same directory is the right fallback.
     */
    function isUnforkable(code) {
      return code === 'session/fork-unavailable' || code === 'session/not-found'
    }

    /* ------------------------------------------------------------ fork registry */

    // Factory scope runs before the plugin is applied, but a hot-swapped bundle
    // can invoke `apply` while this body is still on the stack: everything the
    // apply path may touch stays a hoisted `var` or a function declaration, never
    // a `const`/`let` (two TDZ crashes proved this the hard way).
    /**
     * localStorage key holding the panels this plugin forked. A function, not a
     * `var`: Cordis may call `apply` before the factory body reaches a `var`
     * initializer, and a hoisted-but-unassigned key made every save land under
     * the literal key "undefined" while the real key stayed empty.
     */
    function forkStoreKey() {
      return 'dsh-threads:forks:v1'
    }

    /** Oldest records beyond this count are dropped (a function for the same reason). */
    function forkStoreLimit() {
      return 200
    }

    /**
     * Fold records stranded under the literal key "undefined" (written while the
     * store key was an unassigned `var`) into the real key. The stray key is
     * removed only when everything in it is a fork record; anything else there
     * belongs to someone else and stays.
     */
    function adoptStrayForks() {
      try {
        const raw = localStorage.getItem('undefined')
        if (raw === null) return
        const stray = JSON.parse(raw)
        if (!Array.isArray(stray)) return
        const ours = stray.filter((row) => typeof row?.id === 'string' && typeof row.parentId === 'string' && Number.isFinite(row.at))
        if (ours.length === 0) return
        const merged = new Map()
        const current = JSON.parse(localStorage.getItem(forkStoreKey()) ?? '[]')
        for (const row of Array.isArray(current) ? current : []) if (typeof row?.id === 'string') merged.set(row.id, row)
        for (const row of ours) {
          const kept = merged.get(row.id)
          if (kept === undefined || (row.touched ?? row.at) > (kept.touched ?? kept.at)) merged.set(row.id, row)
        }
        const rows = [...merged.values()].sort((left, right) => right.at - left.at).slice(0, forkStoreLimit())
        localStorage.setItem(forkStoreKey(), JSON.stringify(rows))
        if (ours.length === stray.length) localStorage.removeItem('undefined')
      } catch { /* unreadable stray data stays where it is */ }
    }

    /**
     * Panels this plugin forked: child Session id -> where it came from.
     * The host does not expose `header.isSeeded` on the session list, so the
     * plugin records its own forks; unknown Sessions simply render natively.
     * Lazily materialized so no caller can observe it before initialization.
     */
    var forkRegistry

    /** @returns the fork registry, loaded from storage on first use. */
    function forks() {
      if (forkRegistry === undefined) {
        adoptStrayForks()
        forkRegistry = loadForks()
      }
      return forkRegistry
    }

    /** Registry subscribers, and a revision that moves on every change. */
    var forkListeners
    var forkRevision

    /**
     * @param listener - called after any fork record changes, in this tab or another.
     * @returns unsubscribe.
     */
    function subscribeForks(listener) {
      if (forkListeners === undefined) forkListeners = new Set()
      forkListeners.add(listener)
      return () => { forkListeners.delete(listener) }
    }

    /** @returns a value that changes whenever the registry does. */
    function forkSnapshot() {
      return forkRevision ?? 0
    }

    function notifyForks() {
      forkRevision = (forkRevision ?? 0) + 1
      if (forkListeners === undefined) return
      for (const listener of [...forkListeners]) {
        try { listener() } catch { /* one broken subscriber must not starve the rest */ }
      }
    }

    /**
     * Read the persisted fork records.
     * @returns the registry, empty when storage is unavailable or corrupt.
     */
    function loadForks() {
      const records = new Map()
      try {
        const raw = localStorage.getItem(forkStoreKey())
        if (raw === null) return records
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return records
        for (const row of parsed) {
          if (typeof row?.id !== 'string') continue
          const record = {
            parentId: typeof row.parentId === 'string' ? row.parentId : '',
            title: typeof row.title === 'string' ? row.title : '',
            turns: Number.isFinite(row.turns) ? row.turns : 0,
            at: Number.isFinite(row.at) ? row.at : 0,
            expanded: row.expanded === true,
            planMode: row.planMode === true,
          }
          // Fold point: turns numbered at or below it are the history a folded panel hides.
          if (Number.isSafeInteger(row.cutoff) && row.cutoff >= 0) record.cutoff = row.cutoff
          // Last write, so two tabs saving the same record keep the newer one.
          if (Number.isFinite(row.touched)) record.touched = row.touched
          records.set(row.id, record)
        }
      } catch { /* storage unavailable or unparsable: keep the in-memory registry */ }
      return records
    }

    /**
     * Persist the registry, dropping the oldest records past the limit. Another
     * tab may have written since this one loaded, so merge by id and keep the
     * record touched last: writing the in-memory map blindly erased every record
     * another tab had added.
     */
    function saveForks() {
      try {
        const merged = loadForks()
        for (const [id, record] of forks()) {
          const stored = merged.get(id)
          if (stored === undefined || (record.touched ?? record.at) >= (stored.touched ?? stored.at)) merged.set(id, record)
        }
        for (const [id, record] of merged) if (!forks().has(id)) forks().set(id, record)
        const rows = [...merged].map(([id, record]) => ({ id, ...record }))
        rows.sort((left, right) => right.at - left.at)
        localStorage.setItem(forkStoreKey(), JSON.stringify(rows.slice(0, forkStoreLimit())))
      } catch { /* a full or absent storage must never break forking */ }
    }

    /** Adopt what another tab wrote. */
    function reloadForks() {
      forkRegistry = loadForks()
      notifyForks()
    }

    /**
     * Record one fork so its panel can show the continuation card.
     * @param childId - the forked Session.
     * @param record - where it came from: parent Session, title, inherited turns, fold point.
     */
    function rememberFork(childId, record) {
      forks().set(childId, { expanded: false, ...record, touched: Date.now() })
      saveForks()
      notifyForks()
    }

    /**
     * @param sessionId - any Session.
     * @returns its fork record, or undefined when this plugin did not fork it.
     */
    function forkOf(sessionId) {
      return forks().get(sessionId)
    }

    /**
     * Fold or show one fork panel's history. Only the card button and the fold
     * shortcut call this; talking in the panel never does.
     * @param sessionId - the forked Session.
     * @param folded - true to hide the history.
     * @param cutoff - when folding: the newest turn that counts as history.
     */
    function setForkFolded(sessionId, folded, cutoff) {
      const record = forks().get(sessionId)
      if (record === undefined) return
      const next = { ...record, expanded: !folded, touched: Date.now() }
      if (folded && Number.isSafeInteger(cutoff) && cutoff >= 0) next.cutoff = cutoff
      forks().set(sessionId, next)
      saveForks()
      notifyForks()
    }

    /**
     * Pin the fold point of a record written before fold points existed.
     * @param sessionId - the forked Session.
     * @param cutoff - the newest turn the panel showed when it mounted.
     */
    function setForkCutoff(sessionId, cutoff) {
      const record = forks().get(sessionId)
      if (record === undefined || !Number.isSafeInteger(cutoff) || record.cutoff === cutoff) return
      forks().set(sessionId, { ...record, cutoff, touched: Date.now() })
      saveForks()
      notifyForks()
    }

    /**
     * Fold point of a fresh fork: the last turn the source completed. A native
     * fork copies the completed turns with their turn numbers, so in the child
     * exactly these are the carried-over history and every later turn is new.
     * @param sessions - client session controller.
     * @param sessionId - the source Session.
     * @returns that turn number, or undefined when the source has none loaded.
     */
    function lastCompletedTurn(sessions, sessionId) {
      let entries
      try { entries = sessions.binding(sessionId)?.eventSource.getSnapshot()?.entries } catch { return undefined }
      if (!Array.isArray(entries)) return undefined
      let open
      let done
      for (const entry of entries) {
        const event = entry?.event
        if (event?.type === 'turn/start') {
          const turn = Number(event.data?.turn)
          open = Number.isSafeInteger(turn) ? turn : undefined
        } else if (event?.type === 'turn/end' && open !== undefined) {
          done = done === undefined ? open : Math.max(done, open)
        }
      }
      return done
    }

    /**
     * Count the completed turns carried into a fork.
     * @param sessions - client session controller.
     * @param sessionId - the source Session.
     * @returns completed turns visible in the source's loaded window.
     */
    function countTurns(sessions, sessionId) {
      const entries = sessions.binding(sessionId)?.eventSource.getSnapshot()?.entries
      if (!Array.isArray(entries)) return 0
      let turns = 0
      for (const entry of entries) {
        if (entry?.event?.type === 'turn/start') turns += 1
      }
      return turns
    }

    function planPlaceholder(value) {
      if (typeof value !== 'string') return false
      return value.includes('描述你的任务以生成计划')
        || /describe your task.*(?:generate|make).*plan/i.test(value)
    }

    /**
     * Read the small set of session/composer projections that can identify Plan
     * mode. Keep this deliberately structural: a session title or transcript
     * mentioning "plan" must not make the warning appear.
     */
    function planProjection(value, key = '', seen = new Set(), depth = 0) {
      if (value === undefined || value === null || depth > 6) return undefined
      if (typeof value === 'string') {
        if (planPlaceholder(value)) return { available: true, plan: true }
        if (/mode|phase/i.test(key)) return { available: true, plan: /plan|planning|计划/i.test(value) }
        return undefined
      }
      if (typeof value === 'boolean') {
        if (/plan/i.test(key)) return { available: true, plan: value }
        return undefined
      }
      if (typeof value === 'number') {
        if (/badge/i.test(key)) return { available: true, plan: value > 0 }
        return undefined
      }
      if (typeof value !== 'object') return undefined
      if (seen.has(value)) return undefined
      seen.add(value)
      const keyIsPlan = /plan/i.test(key)
      const keyIsPlaceholder = /placeholder/i.test(key)
      const keyIsMode = /mode|phase/i.test(key)
      let available = keyIsPlan || keyIsPlaceholder || keyIsMode
      let plan = false
      if (keyIsPlan && typeof value === 'object' && value !== null) {
        if (value.enabled === true || value.active === true || value.value === true) plan = true
      }
      for (const name of Object.keys(value).slice(0, 100)) {
        const result = planProjection(value[name], name, seen, depth + 1)
        if (result === undefined) continue
        available = true
        plan = plan || result.plan
      }
      return available ? { available: true, plan } : undefined
    }

    function projectionSnapshot(value) {
      if (value === undefined || value === null) return undefined
      try {
        return typeof value.getSnapshot === 'function' ? value.getSnapshot() : value
      } catch {
        return undefined
      }
    }

    /** @returns Plan mode, false for a known non-Plan projection, or undefined when unavailable. */
    function inspectPlanMode(deps, sessionId, reference) {
      let binding
      try { binding = reference?.binding ?? deps.sessions.binding(sessionId) } catch { binding = undefined }
      const candidates = [binding?.session]
      try {
        const sessionScope = binding?.ctx ?? deps.sessions.scope?.(sessionId)
        const input = sessionScope === undefined ? undefined : deps.conversation?.input?.for(sessionScope)
        candidates.push(input)
      } catch { /* an unretained session may have no composer projection yet */ }
      for (const candidate of candidates) {
        const result = planProjection(projectionSnapshot(candidate))
        if (result?.available) return result.plan
      }
      return undefined
    }

    async function forkPlanMode(deps, childId, sourceId, signal) {
      let result = inspectPlanMode(deps, childId)
      if (result === undefined && typeof deps.sessions.using === 'function') {
        try {
          await deps.sessions.using(childId, { source: 'paneChat', signal }, (reference) => {
            result = inspectPlanMode(deps, childId, reference)
          })
        } catch { /* fall back to the source projection below */ }
      }
      if (result !== undefined) return result
      return inspectPlanMode(deps, sourceId) ?? false
    }

    /**
     * Explain why a fork panel could not take a pane of its own.
     * @param t - zh/en resolver of the calling scope.
     * @param block - the refusal reported by the sidebar.
     * @returns the sentence shown above the source composer.
     */
    function splitHint(t, block) {
      if (block === 'width') {
        return t('右栏太窄，分叉已开在同一栏的新标签里（拖宽后可分栏）',
          'Column too narrow: the fork opened as a tab here (widen the column to split)')
      }
      if (block === 'budget') {
        return t('右栏已占满两个栏位，分叉已开在同一栏的新标签里',
          'The column already holds two panes: the fork opened as a tab here')
      }
      if (block === 'collapsed') {
        return t('右栏未打开，已展开右栏并把分叉开在新标签里',
          'The right sidebar was closed: it is open now, with the fork in a new tab')
      }
      // The fork simply fills an empty pane; nothing to explain.
      if (block === 'empty') return undefined
      if (block === 'float') {
        return t('目标是浮动面板，分叉已开在同一面板的新标签里',
          'The target pane is floating: the fork opened as a tab in it')
      }
      // 'stale': the target moved while forking. The column itself is open, so
      // never claim it is closed (that misreport is what v2.1b removes).
      return t('右栏布局刚刚变了，分叉已开在新标签里',
        'The sidebar layout changed meanwhile: the fork opened as a tab')
    }

    /**
     * A live target for one tab of the on-screen sidebar, resolved through the
     * tab's own element so the host checks the pane, its visibility and the tab
     * lifetime exactly as it does for focus.
     * @param sidebarRight - the sidebar service.
     * @param tabId - the tab; undefined yields undefined.
     * @returns that tab's pane target, or undefined when it is not on screen.
     */
    function tabTarget(sidebarRight, tabId) {
      const sessionId = sidebarRight.mounted.getSnapshot()
      if (tabId === undefined || sessionId === undefined) return undefined
      const id = CSS.escape(String(tabId))
      for (const seat of document.querySelectorAll('[data-sidebar-right-session]')) {
        if (seat.getAttribute('data-sidebar-right-session') !== sessionId || seat.getClientRects().length === 0) continue
        const element = seat.querySelector(`[data-dockkit-tab="${id}"], [data-sidebar-right-tab="${id}"]`)
        const target = element === null ? undefined : sidebarRight.focusedTarget(element)
        if (target !== undefined) return target
      }
      return undefined
    }

    /**
     * Where a fork lands when nothing is focused: the pane that asked, the
     * focused or command pane, the active tab's pane, and last the pane holding
     * the first panel chat of the on-screen Session.
     * @param sidebarRight - the sidebar service.
     * @param anchor - the element that asked, if any.
     * @returns a pane target, or undefined when the column has nothing on screen.
     */
    function forkTarget(sidebarRight, anchor) {
      const element = anchor ?? null
      const direct = sidebarRight.focusedTarget(element) ?? sidebarRight.commandTarget(element)
      if (direct !== undefined) return direct
      // `active()` is a tab record, not a target: resolve it through its element.
      const fromActive = tabTarget(sidebarRight, sidebarRight.active()?.id)
      if (fromActive !== undefined) return fromActive
      const owner = sidebarRight.mounted.getSnapshot()
      const first = sidebarRight.openTabs.getSnapshot().find((entry) => entry.kind === 'panechat' && entry.sessionId === owner)
      return tabTarget(sidebarRight, first?.tabId)
    }

    /**
     * Continue one conversation in a new Session: a native fork keeps the
     * completed turns as context and inherits the workspace directory, so a side
     * panel never asks for a directory. A chat with no completed turn has no
     * prefix to fork; it degrades to a fresh chat in the same directory.
     * @param deps - client services carrying `sessions`.
     * @param sourceId - the conversation to continue.
     * @param options - optional cancellation signal.
     * @returns the new Session id and whether it really carries context.
     */
    async function continueConversation(deps, sourceId, { signal } = {}) {
      signal?.throwIfAborted()
      const source = deps.sessions.list.getSnapshot().byId[sourceId]
      const cwd = source?.cwd
      const turns = countTurns(deps.sessions, sourceId)
      const cutoff = lastCompletedTurn(deps.sessions, sourceId)
      let id
      let forked = true
      try {
        id = await deps.sessions.fork({ sessionId: sourceId, increaseTitle: true })
      } catch (error) {
        if (!isUnforkable(error?.rpcError?.code) || typeof cwd !== 'string') throw error
        id = await deps.sessions.create({ cwd })
        forked = false
      }
      signal?.throwIfAborted()
      if (forked) {
        const planMode = await forkPlanMode(deps, id, sourceId, signal)
        rememberFork(id, {
          parentId: sourceId,
          title: source?.displayTitle ?? source?.title ?? '',
          turns,
          planMode,
          at: Date.now(),
          ...(cutoff === undefined ? {} : { cutoff }),
        })
      }
      return { id, forked }
    }

    /**
     * Continue one conversation in a panel placed beside it: split the docked
     * pane to its right and land the panel in the new pane. When the column
     * cannot split (width, pane budget, no live target) the panel opens as one
     * more tab in the source pane — never in place of the tab already there.
     * @param deps - client services carrying `sessions`, `sidebarRight`, `conversation`.
     * @param sourceId - the conversation the new panel continues.
     * @param options - optional cancellation signal and the element that asked.
     * @returns the new Session id, whether it was split, and the block reason when it was not.
     */
    async function openForkPaneBeside(deps, sourceId, { signal, anchor } = {}) {
      const { sidebarRight } = deps
      const target = forkTarget(sidebarRight, anchor)
      const live = target !== undefined && sidebarRight.isTargetCurrent(target) ? target : undefined
      const block = live === undefined ? 'stale' : sidebarRight.splitBlock(live)
      const { id } = await continueConversation(deps, sourceId, { signal })
      signal?.throwIfAborted()
      const address = paneAddress(id)
      const split = live === undefined ? undefined : sidebarRight.split(live.paneId)
      // Report the reason that actually held: the pre-check may pass while the
      // split itself still declines (layout or width moved while forking).
      const refusal = split !== undefined
        ? undefined
        : (live === undefined ? block : sidebarRight.splitBlock(live) ?? block)
      if (split !== undefined) sidebarRight.openResource(address, { paneId: split })
      else if (live !== undefined) sidebarRight.openResource(address, { paneId: live.paneId })
      else sidebarRight.openResource(address)
      // The panel is the new conversation; put the caret in it.
      try {
        await deps.sessions.using(id, { source: 'paneChat', signal }, (reference) => {
          deps.conversation.input.for(reference.binding.ctx).focus()
        })
      } catch { /* focus is an affordance, never a failure of the fork */ }
      return { id, split: split !== undefined, block: refusal }
    }

    function registerPaneChat(ctx, statusText, paneCursors) {
      const t = (zh, en) => ctx.locale.resolveText({ zh, en })
      const workspaceText = ctx.locale.bind('workspace')
      function titleFor(summary, fallback) {
        if (summary === undefined) return fallback
        const key = summary.blank ? 'session.new' : 'session.untitled'
        const stored = summary.blank ? '' : summary.title?.trim()
        if (stored) return stored
        const label = workspaceText(key)
        return label === key ? fallback : label
      }
      const startTitle = () => t('分叉面板', 'Fork panel')
      const description = () => t('把这边的对话分叉到右栏新面板，目录沿用当前工作区', 'Fork this chat into a new panel in the same directory')
      const failureText = (error) => String(error?.message ?? error)

      const CSS = `
[data-dsh-pane-chat]{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;}
[data-dsh-pane-body]{display:flex;flex:1;min-width:0;min-height:0;}
[data-dsh-pane-start]{display:grid;align-content:start;gap:10px;width:100%;max-width:26rem;margin-inline:auto;padding:16px;box-sizing:border-box;}
[data-dsh-pane-start] button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;}
[data-dsh-pane-start] button{justify-self:start;cursor:pointer;}
[data-dsh-pane-start] button:disabled{opacity:.55;cursor:default;}
[data-dsh-pane-start-lead]{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);}
[data-dsh-pane-error]{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;margin:0;}
[data-dsh-pane-chat]>[role]{padding:12px;}
/* Folded fork panel: only rows of carried-over turns hide. The fold engine marks
   them with an attribute (an inline style would be overwritten by React); turns
   said in this panel never carry the mark, and the composer is never a turn row. */
[data-dsh-fork-hid]{display:none !important;}
[data-dsh-fork-planwarn]{display:flex;flex:none;align-items:flex-start;gap:8px;padding:9px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1);background:rgba(255,196,0,.12);color:var(--dsw-alias-label-primary);
  font-size:12px;line-height:1.4;}
[data-dsh-fork-planwarn] span{flex:1;min-width:0;}
[data-dsh-fork-planwarn] button{flex:none;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;
  background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap;}
[data-dsh-fork-planwarn] button:hover{background:rgba(255,196,0,.16);}
[data-dsh-fork-planwarn] button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
[data-dsh-fork-card]{display:flex;flex:none;flex-wrap:wrap;align-items:flex-start;gap:8px 10px;padding:9px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}
[data-dsh-fork-card-main]{display:flex;flex:1 1 11rem;flex-direction:column;gap:3px;min-width:0;}
[data-dsh-fork-card-title]{margin:0;font-size:13px;line-height:1.35;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-dsh-fork-card-meta]{margin:0;font-size:12px;line-height:1.35;color:var(--dsw-alias-label-secondary);}
[data-dsh-fork-card-actions]{display:flex;flex:none;flex-wrap:wrap;align-items:center;gap:6px;margin-left:auto;}
[data-dsh-fork-action]{display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;
  transition:color 120ms ease,border-color 120ms ease,background-color 120ms ease;}
[data-dsh-fork-action]:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);
  background:rgba(10,132,255,.08);}
[data-dsh-fork-action]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
[data-dsh-fork-mark]{flex:none;width:14px;height:14px;margin-top:1px;color:var(--dsw-alias-label-tertiary);}
[data-dsh-fork-tabmark]{flex:none;width:11px;height:11px;margin-right:4px;color:var(--dsw-alias-label-tertiary);}
[data-dsh-fork-guide]{display:flex;flex-direction:column;align-items:flex-start;gap:4px;width:100%;height:100%;
  box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer;
  transition:background-color 120ms ease,border-color 120ms ease;}
[data-dsh-fork-guide]:hover{background:rgba(10,132,255,.08);border-color:var(--dsw-alias-border-l2);}
[data-dsh-fork-guide]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
[data-dsh-fork-guide][data-busy]{opacity:.7;cursor:default;}
[data-dsh-fork-guide-icon]{color:var(--dsw-alias-label-secondary);}
[data-dsh-fork-guide-title]{font-size:13px;line-height:1.3;color:var(--dsw-alias-label-primary);}
[data-dsh-fork-guide-desc]{font-size:11px;line-height:1.35;color:var(--dsw-alias-label-secondary);}
[data-dsh-fork-guide-error]{font-size:11px;line-height:1.35;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;}
@media (prefers-reduced-motion:reduce){[data-dsh-fork-action]{transition:none;}}
`
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-pane-styles', '')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'threads: panechat styles')

      ctx.inject(['resources'], (scope) => {
        scope.effect(() => scope.resources.register({
          protocol: 'panechat',
          async *open(address, { signal }) {
            const id = parsePaneAddress(address)
            if (signal.aborted) return
            if (id === undefined) {
              yield { ok: false, error: { code: 'gateway/bad-request', message: `Invalid panechat address: ${address}` } }
              return
            }
            let reference
            try {
              // Restored tabs may be pinned before the initial Session catalog arrives.
              const catalog = scope.sessions.list.getSnapshot()
              if (catalog.phase === 'pending' && catalog.byId[id] === undefined) await scope.sessions.refresh()
              if (signal.aborted) return
              reference = scope.sessions.retain(id, { source: 'paneChat', signal })
            } catch (error) {
              if (!signal.aborted) {
                const code = failureText(error).startsWith('sessions.retain: unknown session ')
                  ? 'session/not-found' : 'gateway/internal'
                yield { ok: false, error: { code, message: failureText(error), details: { sessionId: id } } }
              }
              return
            }
            try {
              yield { ok: true, value: { id, reference } }
              await waitForAbort(signal)
            } finally {
              reference.release()
            }
          },
        }), 'threads: panechat resource')
      })

      ctx.inject(['sidebarRightTabs'], (scope) => {
        scope.effect(() => scope.sidebarRightTabs.register({
          id: PANECHAT_ID,
          kind: 'panechat',
          patterns: [PANE_PREFIX + '**'],
          priority: 'extension',
          canOpen: (address) => parsePaneAddress(address) !== undefined,
          title: (address) => titleFor(scope.sessions.list.getSnapshot().byId[parsePaneAddress(address)], t('会话', 'Chat')),
        }), 'threads: panechat tab type')
        scope.effect(() => scope.sidebarRightTabs.register({
          id: PANE_START_ID,
          kind: 'panechat-start',
          title: startTitle,
          guide: [{ id: 'new-pane', order: 10, title: startTitle, description }],
        }), 'threads: panechat launch page')
      })

      ctx.inject(['slots', 'sessions', 'sidebarRight', 'conversation'], (scope) => {
        /**
         * One-click guide card: fork the chat behind the guide into a panel beside
         * it. It replaces the shipped card (which would only open the launcher
         * page) so forking costs exactly one click.
         */
        function ForkGuideCard({ sessionId, title, description: blurb }) {
          const [busy, setBusy] = useState(false)
          const [failure, setFailure] = useState('')
          const owner = sessionId ?? scope.sidebarRight.mounted.getSnapshot()

          async function pick(event) {
            if (busy || owner === undefined) return
            setBusy(true)
            setFailure('')
            try {
              const result = await openForkPaneBeside(scope, owner, { anchor: event.currentTarget })
              if (result.block !== undefined) {
                const actx = scope.sessions.scope(owner)
                const hint = splitHint(t, result.block)
                if (actx !== undefined && hint !== undefined) {
                  scope.conversation.input.for(actx).notify('info', hint)
                }
              }
            } catch (error) {
              setFailure(failureText(error))
            } finally {
              setBusy(false)
            }
          }

          return h('button', {
            type: 'button',
            'data-dsh-fork-guide': '',
            'data-busy': busy ? '' : undefined,
            onClick: pick,
            title: blurb ?? description(),
          },
            h(ForkGlyph, { attribute: 'data-dsh-fork-guide-icon', size: 15 }),
            h('span', { 'data-dsh-fork-guide-title': '' },
              busy ? t('正在分叉…', 'Forking…') : (title ?? startTitle())),
            blurb !== undefined && failure === ''
              ? h('span', { 'data-dsh-fork-guide-desc': '' }, blurb)
              : null,
            failure !== ''
              ? h('span', { 'data-dsh-fork-guide-error': '', role: 'alert' }, failure)
              : null)
        }

        scope.effect(() => scope.slots.inject('sidebar.right.tab.guide.entry', () => scope.slots.register({
          name: 'sidebar.right.tab.guide.entry',
          key: PANE_START_ID,
        }, ForkGuideCard)), 'threads: fork guide card')
      })

      ctx.inject(['resources', 'sidebarRight'], (scope) => {
        const { mounted, openTabs } = scope.sidebarRight
        const subscribeMounted = (listener) => mounted.subscribe(listener)
        const getMounted = () => mounted.getSnapshot()
        const subscribeTabs = (listener) => openTabs.subscribe(listener)
        const getTabs = () => openTabs.getSnapshot()

        /**
         * Newest turn number one fork panel knows: its own event stream, plus the
         * rows mounted in the given panel roots.
         * @param paneId - the forked Session.
         * @param roots - panel roots to scan (may be empty).
         * @returns that turn, or undefined while nothing is loaded yet.
         */
        function newestTurn(paneId, roots) {
          let newest
          const consider = (value) => {
            const turn = Number(value)
            if (Number.isSafeInteger(turn) && (newest === undefined || turn > newest)) newest = turn
          }
          try {
            const entries = scope.sessions.binding(paneId)?.eventSource.getSnapshot()?.entries
            if (Array.isArray(entries)) {
              for (const entry of entries) if (entry?.event?.type === 'turn/start') consider(entry.event.data?.turn)
            }
          } catch { /* rendered rows below still count */ }
          for (const root of roots) {
            for (const row of root.querySelectorAll('[data-chat-turn]')) consider(row.getAttribute('data-chat-turn'))
          }
          return newest
        }

        /** @returns the mounted roots of one fork panel (a Session can show in more than one tab). */
        function forkRoots(paneId) {
          return [...document.querySelectorAll('[data-dsh-fork-pane]')]
            .filter((root) => root.getAttribute('data-dsh-fork-pane') === paneId)
        }

        /**
         * Hide the carried-over turns of one folded fork panel, and keep hiding
         * them as rows mount: streaming adds rows, and the windowed transcript
         * mounts older turns when scrolled up. Rows are judged by their turn
         * number against the fold point, never by position — the transcript's
         * nested slots have no fixed depth.
         * @param root - the panel root.
         * @param paneId - the forked Session.
         * @returns teardown: stop observing and reveal every row.
         */
        function foldTranscript(root, paneId) {
          let cutoff = forkOf(paneId)?.cutoff
          // A record written before fold points existed hides everything until the
          // panel's own turns load, then pins the fold point at the newest one.
          const settle = () => {
            if (Number.isSafeInteger(cutoff)) return true
            const newest = newestTurn(paneId, [root])
            if (newest === undefined) return false
            cutoff = newest
            setForkCutoff(paneId, newest)
            return true
          }
          const judge = (row) => {
            const turn = Number(row.getAttribute('data-chat-turn'))
            if (!Number.isSafeInteger(turn)) return
            if (!Number.isSafeInteger(cutoff) || turn <= cutoff) {
              if (!row.hasAttribute('data-dsh-fork-hid')) row.setAttribute('data-dsh-fork-hid', '')
            } else if (row.hasAttribute('data-dsh-fork-hid')) row.removeAttribute('data-dsh-fork-hid')
          }
          const sweep = () => { for (const row of root.querySelectorAll('[data-chat-turn]')) judge(row) }
          settle()
          sweep()
          const observer = new MutationObserver((records) => {
            if (!Number.isSafeInteger(cutoff) && settle()) { sweep(); return }
            for (const record of records) {
              if (record.type === 'attributes') { judge(record.target); continue }
              for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue
                if (node.hasAttribute('data-chat-turn')) judge(node)
                for (const row of node.querySelectorAll('[data-chat-turn]')) judge(row)
              }
            }
          })
          observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-chat-turn'] })
          return () => {
            observer.disconnect()
            for (const row of root.querySelectorAll('[data-dsh-fork-hid]')) row.removeAttribute('data-dsh-fork-hid')
          }
        }

        /**
         * The card button and the fold shortcut share this. Folding pins the fold
         * point at the newest turn the panel has, so everything said so far — the
         * carried-over history and any turns already asked here — folds away, and
         * only what is said next stays visible.
         * @param paneId - the forked Session.
         */
        function toggleForkFold(paneId) {
          const record = forkOf(paneId)
          if (record === undefined) return
          if (record.expanded === true) setForkFolded(paneId, true, newestTurn(paneId, forkRoots(paneId)) ?? 0)
          else setForkFolded(paneId, false)
        }

        /**
         * The fork panel a fold command means: the one holding keyboard focus (the
         * person is usually typing in it), else the focused or active sidebar tab,
         * else the only fork panel on screen. Tabs are not filtered by owner: a
         * restored layout can show a fork whose tab was opened beside another chat.
         * @returns that panel's Session id, or undefined when none is unambiguous.
         */
        function targetForkPane() {
          const here = document.activeElement?.closest?.('[data-dsh-fork-pane]')?.getAttribute('data-dsh-fork-pane')
          if (here && forkOf(here) !== undefined) return here
          let tabs = []
          try { tabs = scope.sidebarRight.openTabs.getSnapshot() ?? [] } catch { /* fall through to the mounted panels */ }
          const candidates = Array.isArray(tabs)
            ? tabs.filter((entry) => entry.kind === 'panechat' && forkOf(parsePaneAddress(entry.contentId)) !== undefined)
            : []
          let focusedId
          let activeId
          try { focusedId = scope.sidebarRight.focusedTarget()?.tabId } catch { /* no focus information */ }
          try { activeId = scope.sidebarRight.active()?.id } catch { /* no active tab */ }
          const chosen = candidates.find((entry) => entry.tabId === focusedId) ?? candidates.find((entry) => entry.tabId === activeId)
          if (chosen !== undefined) return parsePaneAddress(chosen.contentId)
          const mounted = new Set([...document.querySelectorAll('[data-dsh-fork-pane]')].map((root) => root.getAttribute('data-dsh-fork-pane')))
          return mounted.size === 1 ? [...mounted][0] : undefined
        }

        scope.effect(() => {
          // Materialize the registry at startup so stranded records are adopted now,
          // not at the first fork.
          forks()
          const onStorage = (event) => { if (event.key === forkStoreKey()) reloadForks() }
          window.addEventListener('storage', onStorage)
          return () => window.removeEventListener('storage', onStorage)
        }, 'threads: follow fork registry across tabs')

        // The fold command and shortcut are registered here, beside the helpers
        // they call; both do exactly what the card button does. A refusal from
        // either registry must not take anything else down with it.
        scope.inject(['commandUi'], (commands) => {
          commands.effect(() => {
            try {
              return commands.commandUi.register({
                name: 'panechat.fold',
                label: () => t('收起/展开分叉历史', 'Fold or show fork history'),
                description: () => t('只藏分叉带进来的历史，本面板新说的话始终可见', 'Hides only the history carried into the fork; new turns stay visible'),
                available: () => targetForkPane() !== undefined,
                ui: { kind: 'action', run: () => { const paneId = targetForkPane(); if (paneId !== undefined) toggleForkFold(paneId) } },
              })
            } catch { return () => {} }
          }, 'threads: fork fold command')
        })

        scope.inject(['shortcuts'], (keyboard) => {
          keyboard.effect(() => {
            // Live in the editable region too: the person is usually typing in the
            // fork when they want it out of the way. Per-profile defaults, because
            // the host validates every profile at registration and one reserved
            // profile refuses the whole entry: ⌥⌘H on the desktop shell; a browser
            // tab only lets ⌘H chords through with three modifiers, so it gets
            // ⌥⌘⇧H; Linux reserves every Ctrl+H chord and keeps the command only.
            const desktopFold = { code: 'KeyH', modifiers: ['primary', 'alt'] }
            const webFold = { code: 'KeyH', modifiers: ['primary', 'alt', 'shift'] }
            try {
              return keyboard.shortcuts.register({
                id: 'panechat.fold',
                label: () => t('收起/展开分叉历史', 'Fold or show fork history'),
                aliases: ['fold fork history', 'show fork history'],
                defaults: { 'desktop:macos': desktopFold, 'desktop:windows': desktopFold, 'web:macos': webFold, 'web:windows': webFold },
                regions: ['page', 'editable', 'terminal'],
                modals: [],
                resolve: () => {
                  const paneId = targetForkPane()
                  if (paneId === undefined) return { status: 'blocked', reason: t('右栏没有分叉面板', 'No fork panel in the sidebar') }
                  return { status: 'handled', run: () => toggleForkFold(paneId) }
                },
              })
            } catch { return () => {} }
          }, 'threads: fork fold shortcut')
        })

        /**
         * Header of a forked panel: what it continues, how much context it
         * carries, and the two things a person wants next (show or hide the
         * inherited transcript, jump back to the original chat).
         */
        function ForkCard({ sessionId, folded, onToggle, onOpenSource }) {
          const record = forkOf(sessionId)
          if (record === undefined) return null
          const source = record.title.trim() === '' ? t('上一段对话', 'the earlier chat') : record.title
          const turns = record.turns > 0
            ? t(`带入 ${record.turns} 轮对话`, `${record.turns} turns carried over`)
            : t('已带入上下文', 'context carried over')
          const meta = folded
            ? `${turns} · ${t('历史已收起（只显示本轮）', 'history folded (current turn only)')}`
            : `${turns} · ${t('历史已展开', 'history shown')}`
          const planWarning = record.planMode === true && record.parentId !== ''
            ? h('div', { 'data-dsh-fork-planwarn': '', role: 'status' },
              h('span', null, t('源会话在计划模式，此面板会先出计划；要直接回答请先退出计划模式',
                'The source chat is in Plan mode, so this panel will plan first; exit Plan mode in the original chat to answer directly')),
              h('button', { type: 'button', onClick: onOpenSource }, t('跳回原对话', 'Back to original')))
            : null
          return h(React.Fragment, null,
            planWarning,
            h('div', { 'data-dsh-fork-card': '' },
              h(ForkGlyph, {}),
              h('div', { 'data-dsh-fork-card-main': '' },
                h('p', { 'data-dsh-fork-card-title': '', title: source },
                  t(`接续自《${source}》`, `Continued from “${source}”`)),
                h('p', { 'data-dsh-fork-card-meta': '' }, meta)),
              h('div', { 'data-dsh-fork-card-actions': '' },
                h('button', {
                  type: 'button',
                  'data-dsh-fork-action': '',
                  onClick: onToggle,
                }, folded ? t('展开历史', 'Show history') : t('收起历史', 'Fold history')),
                record.parentId === '' ? null : h('button', {
                  type: 'button',
                  'data-dsh-fork-action': '',
                  onClick: onOpenSource,
                }, t('跳回原对话', 'Open original')))))
        }

        function PaneChatTab({ sessionId, useResource, useTabInfo, SessionProvider, renderSlot }) {
          const { tab } = useTabInfo()
          const resource = useResource(tab.contentId)
          const mainSessionId = React.useSyncExternalStore(subscribeMounted, getMounted)
          const tabs = React.useSyncExternalStore(subscribeTabs, getTabs)
          React.useSyncExternalStore(subscribeForks, forkSnapshot)
          const paneId = resource.value?.id
          const record = paneId === undefined ? undefined : forkOf(paneId)
          const forked = record !== undefined
          // The registry is the only fold state. The card button and the fold
          // shortcut change it; talking in the panel never does — a turn said
          // here is newer than the fold point, so it is never hidden.
          const folded = forked && record.expanded !== true
          const cutoff = forked ? record.cutoff : undefined
          const rootRef = useRef(null)
          const first = tabs.find((entry) => entry.sessionId === sessionId
            && entry.kind === 'panechat' && entry.contentId === tab.contentId)

          // Layout effect: carried-over rows get their mark before the first paint.
          // Non-fork panels and unfolded forks are left alone entirely.
          React.useLayoutEffect(() => {
            const root = rootRef.current
            if (!folded || paneId === undefined || root === null) return undefined
            return foldTranscript(root, paneId)
          }, [folded, paneId, cutoff])

          let content
          if (resource.status === 'failed') {
            content = h('p', { role: 'alert', 'data-dsh-pane-error': '' }, resource.failure.message)
          } else if (resource.value === undefined) {
            content = h('p', { role: 'status' }, t('正在打开会话…', 'Opening chat…'))
          } else if (resource.value.id === mainSessionId || (first !== undefined && first.tabId !== tab.id)) {
            content = h('p', { role: 'status' }, t('此会话已在其他位置打开', 'This chat is already open elsewhere'))
          } else {
            content = h(SessionProvider, { session: resource.value.reference }, renderSlot('panechat.conversation', {}))
          }

          function toggle() {
            if (paneId !== undefined) toggleForkFold(paneId)
          }

          function openSource() {
            const record = paneId === undefined ? undefined : forkOf(paneId)
            if (record === undefined || record.parentId === '') return
            try {
              const uiWorkspace = scope.get('uiWorkspace')
              uiWorkspace?.openSession?.(record.parentId)
            } catch { /* navigation is an affordance, never a failure of the panel */ }
          }

          return h('div', {
            ref: rootRef,
            'data-dsh-pane-chat': '',
            'data-dsh-fork': forked ? (folded ? 'folded' : 'open') : undefined,
            'data-dsh-fork-pane': forked ? paneId : undefined,
          },
            forked ? h(ForkCard, { sessionId: paneId, folded, onToggle: toggle, onOpenSource: openSource }) : null,
            h('div', { 'data-dsh-pane-body': '' }, content))
        }

        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
          name: 'sidebar.right.pane.tab',
          key: PANECHAT_ID,
          children: { 'panechat.conversation': { kind: 'single', scope: 'session' } },
        }, PaneChatTab)), 'threads: panechat body')
        const focusListeners = new Set()
        scope.effect(() => {
          const afterFocusChange = () => queueMicrotask(() => {
            for (const listener of focusListeners) listener()
          })
          document.addEventListener('focusin', afterFocusChange)
          document.addEventListener('focusout', afterFocusChange)
          window.addEventListener('focus', afterFocusChange)
          window.addEventListener('blur', afterFocusChange)
          const unsubscribe = mounted.subscribe(afterFocusChange)
          return () => {
            document.removeEventListener('focusin', afterFocusChange)
            document.removeEventListener('focusout', afterFocusChange)
            window.removeEventListener('focus', afterFocusChange)
            window.removeEventListener('blur', afterFocusChange)
            unsubscribe()
            focusListeners.clear()
          }
        }, 'threads: observe panechat focus')

        const focusedTab = {
          getSnapshot: () => document.hasFocus() ? scope.sidebarRight.focusedTarget()?.tabId : undefined,
          subscribe(listener) {
            focusListeners.add(listener)
            return () => focusListeners.delete(listener)
          },
        }

        function PaneTitle({ sessionId: owner, useResource, useSessionStatus, useSessions, useTabInfo }) {
          const { tab } = useTabInfo()
          const id = parsePaneAddress(tab.contentId)
          const resource = useResource(tab.contentId)
          const binding = scope.sessions.binding(id)
          const summary = useSessions((list) => list.byId[id])
          const status = useSessionStatus((statuses) => statuses.get(id))
          const session = useObservable(binding?.session)
          useObservable(binding?.eventSource)
          const focus = useObservable(focusedTab)
          const latestEndSeq = binding === undefined ? -1 : latestTurnEvents(binding.eventSource).ending?.seq ?? -1
          const [, setLastSeenSeq] = useState(() => paneCursors.get(owner, tab.id, tab.contentId))
          React.useLayoutEffect(() => {
            if (session?.openState !== 'open') return
            const focused = mounted.getSnapshot() === owner && focusedTab.getSnapshot() === tab.id
            setLastSeenSeq(paneCursors.observe(owner, tab, latestEndSeq, focused))
          }, [owner, tab.id, tab.contentId, tab.signal, focus, latestEndSeq, session?.openState])
          const lastSeenSeq = paneCursors.get(owner, tab.id, tab.contentId)
          const state = paneAttention(status, summary, binding, lastSeenSeq, resource)
          const forked = id !== undefined && forkOf(id) !== undefined
          return tabCaption(titleFor(summary, tab.title), state, statusText, forked)
        }

        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: PANECHAT_ID,
        }, PaneTitle)), 'threads: panechat title')
        scope.effect(() => scope.slots.inject('panechat.conversation', () => scope.slots.register({
          name: 'panechat.conversation',
        }, PaneConversation)), 'threads: panechat conversation')
      })

      ctx.inject(['conversation'], (scope) => {
        function BlankPaneStarter({ sessionId, useSession, useInput, useSessions, inputActions }) {
          const session = useSession((value) => value)
          const input = useInput((value) => value)
          const cwd = useSessions((list) => list.byId[sessionId]?.cwd)
          if (session?.openState !== 'open' || !session.blank || session.running || session.pendingSubmissions.length > 0
            || input?.phase !== 'plain' || input.draft !== '' || input.attachmentIds.length > 0 || input.queue.length > 0) return null
          return h(PaneStarter, { key: JSON.stringify([sessionId, cwd]), scope, sessionId, cwd, inputActions })
        }

        function PaneStarterSlot(props) {
          const sessionId = React.useContext(PaneChatSession)
          return sessionId !== undefined && sessionId === props.sessionId ? h(BlankPaneStarter, props) : null
        }

        scope.effect(() => scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
          name: 'conversation.composer.dock', id: 'panechat-starter', order: -10,
        }, PaneStarterSlot)), 'threads: panechat starter capsules')
      })

      ctx.inject(['remote', 'sessions', 'sidebarRight', 'conversation'], (scope) => {
        // The launch page no longer forks by itself: restoring an old tab must not
        // mint a Session. It is a single button, and the real entry point is the
        // guide card that forks straight into the pane beside this chat.
        function PaneStart({ sessionId }) {
          const [busy, setBusy] = useState(false)
          const [failure, setFailure] = useState('')

          async function fork() {
            if (busy) return
            setBusy(true)
            setFailure('')
            try {
              await openForkPaneBeside(scope, sessionId, {})
            } catch (error) {
              setFailure(failureText(error))
            } finally {
              setBusy(false)
            }
          }

          return h('div', { 'data-dsh-pane-start': '', 'aria-busy': busy },
            h('p', { 'data-dsh-pane-start-lead': '' },
              t('把当前对话分叉成一个新面板：带上下文、同目录，不打断这边。',
                'Fork this chat into a new panel with its context, in the same directory.')),
            h('button', { type: 'button', disabled: busy, onClick: fork },
              busy ? t('正在分叉…', 'Forking…') : t('分叉对话', 'Fork chat')),
            failure !== '' && h('p', { role: 'alert', 'data-dsh-pane-error': '' }, failure))
        }

        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
          name: 'sidebar.right.pane.tab',
          key: PANE_START_ID,
        }, PaneStart)), 'threads: panechat launch body')
      })

      ctx.inject(['conversation', 'sidebarRight', 'remote', 'uiSession', 'layout'], (scope) => {
        const pending = new Set()

        /**
         * The chat a fork command means: the Session on screen, else the
         * selected one. A global panel over the main column (plugins, a pinned
         * workbench) empties `mounted` while the sidebar keeps drawing that
         * Session's tabs, so `mounted` alone misreads an open column as none.
         * @returns its id, or undefined when no Session is selected at all.
         */
        function mainSession() {
          const mounted = scope.sidebarRight.mounted.getSnapshot()
          if (mounted !== undefined) return mounted
          try {
            const key = scope.uiSession.adapter.current.getSnapshot()?.key
            return typeof key === 'string' && key !== '' ? key : undefined
          } catch { return undefined }
        }

        /**
         * Whether the on-screen chat's sidebar is drawn with something in it:
         * read from the layout, never from focus.
         */
        function sidebarShowing() {
          try {
            return scope.sidebarRight.isExpanded() && scope.sidebarRight.openTabs.getSnapshot().length > 0
          } catch { return false }
        }

        /** Say why, above the chat that asked; a fork command never ends silently. */
        function tell(sessionId, kind, text) {
          const actx = sessionId === undefined ? undefined : scope.sessions.scope(sessionId)
          if (actx === undefined) return
          try { scope.conversation.input.for(actx).notify(kind, text) } catch { /* nowhere to say it */ }
        }

        /**
         * Put the chat back in the main column when a global panel covers it: the
         * sidebar can only open into the on-screen Session.
         * @returns 'here' once `owner` is on screen, 'elsewhere' when another chat
         *   is (replacing it is not this command's call), 'offscreen' otherwise.
         */
        async function bringOnScreen(owner) {
          const { mounted } = scope.sidebarRight
          if (mounted.getSnapshot() === owner) return 'here'
          if (mounted.getSnapshot() !== undefined) return 'elsewhere'
          try { scope.layout.selectPanel(null) } catch { return 'offscreen' }
          for (let tries = 0; tries < 40 && mounted.getSnapshot() === undefined; tries++) {
            await new Promise((settle) => setTimeout(settle, 25))
          }
          const now = mounted.getSnapshot()
          return now === owner ? 'here' : (now === undefined ? 'offscreen' : 'elsewhere')
        }

        /**
         * Fork one conversation into a panel beside the owner chat, in the same
         * directory as the source (no directory prompt anywhere), and say so when
         * the column is too narrow to split.
         * @param owner - the main Session mounted in the right Sidebar.
         * @param sourceId - the conversation to continue.
         * @param noticeSession - where a failure or hint toast lands.
         * @param anchor - the element that asked, for pane targeting.
         */
        function openExistingFork(sourceId) {
          let tabs
          try { tabs = scope.sidebarRight.openTabs.getSnapshot() } catch { return false }
          if (!Array.isArray(tabs)) return false
          const tab = tabs.find((entry) => {
            if (entry.kind !== 'panechat') return false
            const childId = parsePaneAddress(entry.contentId)
            return childId !== undefined && forkOf(childId)?.parentId === sourceId
          })
          if (tab === undefined) return false
          try {
            scope.sidebarRight.openResource(tab.contentId, { revealIfOpened: true })
          } catch { return false }
          // Reusing a fork means going to it: the caret lands in it, as with a new one.
          const childId = parsePaneAddress(tab.contentId)
          scope.sessions.using(childId, { source: 'paneChat' }, (reference) => {
            scope.conversation.input.for(reference.binding.ctx).focus()
          }).catch(() => { /* focus is an affordance, never a failure of the reuse */ })
          return true
        }

        /**
         * The one open path of ⌥⌘J, ⌥⇧⌘J and /panechat: they differ only in
         * `force`, which skips reusing an existing fork. Every early exit says why.
         */
        async function openContinuationFrom(owner, sourceId, noticeSession = owner, anchor, { force = false } = {}) {
          if (owner === undefined) return
          if (pending.has(owner)) {
            tell(noticeSession, 'info', t('正在分叉，请稍候', 'Already forking, one moment'))
            return
          }
          pending.add(owner)
          try {
            const where = await bringOnScreen(owner)
            if (where === 'elsewhere') {
              tell(noticeSession, 'info', t('目标会话已切换，回到要分叉的会话再试', 'The chat on screen changed: go back to the chat to fork and retry'))
              return
            }
            if (where === 'offscreen') {
              tell(noticeSession, 'info', t('主区没有显示这个会话，回到会话后再分叉', 'This chat is not on screen: open it, then fork'))
              return
            }
            const showing = sidebarShowing()
            if (!force && openExistingFork(sourceId)) {
              if (!showing) tell(noticeSession, 'info', t('右栏未打开，已展开右栏并切到已有分叉', 'The right sidebar was closed: it is open now, on the existing fork'))
              return
            }
            const result = await openForkPaneBeside(scope, sourceId, { anchor })
            // A closed column is said as such even when the fork split into it.
            const hint = showing
              ? (result.block === undefined ? undefined : splitHint(t, result.block))
              : (result.split ? t('右栏未打开，已为分叉展开右栏', 'The right sidebar was closed: it is open now, with the fork beside')
                : splitHint(t, 'collapsed'))
            if (hint !== undefined) tell(noticeSession, 'info', hint)
          } catch (error) {
            tell(noticeSession, 'error', failureText(error))
          } finally {
            pending.delete(owner)
          }
        }

        scope.inject(['commandUi'], (commands) => {
          commands.effect(() => {
            // `CommandContribution.label/description` are call signatures, not
            // plain strings: passing a string crashes the command locator
            // ("command.label is not a function") and takes the whole shortcut
            // registration down with it. Coerce here so a caller can never
            // regress into that shape.
            const asThunk = (value, fallback) => typeof value === 'function'
              ? value
              : () => (value === undefined ? fallback : value)
            const register = (name, label, run) => commands.commandUi.register({
              name,
              label: asThunk(label, name),
              description: asThunk(description, ''),
              available: () => mainSession() !== undefined,
              ui: { kind: 'action', run },
            })
            const disposeNew = register('panechat', startTitle, ({ sessionId }) => {
              const owner = mainSession()
              void openContinuationFrom(owner, sessionId ?? owner, sessionId ?? owner)
            })
            const disposeBranch = register('panechat.branch', () => t('强制分叉面板', 'Force fork panel'), ({ sessionId }) => {
              const owner = mainSession()
              void openContinuationFrom(owner, sessionId ?? owner, sessionId ?? owner, undefined, { force: true })
            })
            return () => { disposeNew(); disposeBranch() }
          }, 'threads: /panechat commands')
        })

        scope.inject(['shortcuts'], (keyboard) => {
          keyboard.effect(() => {
            const shortcuts = keyboard.shortcuts
            const binding = { code: 'KeyJ', modifiers: ['primary', 'alt'] }
            const fallback = { ...binding, code: 'KeyU' }
            const branchBinding = { ...binding, modifiers: ['primary', 'alt', 'shift'] }
            const defaults = (value) => ({
              'desktop:macos': value, 'desktop:windows': value, 'desktop:linux': value,
              'web:macos': value, 'web:windows': value,
            })
            const register = (id, label, aliases, value, resolve) => shortcuts.register({
              id,
              // Shortcut labels are call signatures too; a bare string here throws
              // inside the registry and kills every later registration in this
              // effect (symptom: entries silently missing from ⌘/ and a
              // "command.label is not a function" crash from the locale subscriber).
              label: typeof label === 'function' ? label : () => String(label ?? id),
              aliases,
              defaults: defaults(value),
              // Both fork keys are pressed while typing; on the web a key outside its
              // regions is passed through without a trace, which was ⌥⇧⌘J's silence.
              regions: ['page', 'editable', 'terminal'],
              modals: [], resolve,
            })
            const resolve = (force) => () => {
              const owner = mainSession()
              if (owner === undefined) return { status: 'blocked', reason: t('先打开一个会话，再分叉面板', 'Open a chat first to fork it into a panel') }
              return { status: 'handled', run: () => { void openContinuationFrom(owner, owner, owner, undefined, { force }) } }
            }
            const tryRegister = (id, label, aliases, values, run) => {
              for (const value of values) {
                const { issue, conflicts } = shortcuts.describeBinding(value)
                if (issue !== null || conflicts.length > 0) continue
                try { return register(id, label, aliases, value, run) } catch (error) {
                  if (!failureText(error).startsWith('Conflicting shortcut defaults:')) throw error
                }
              }
              return undefined
            }
            // Reserve ⇧J for the explicit force action before ordinary new-pane
            // fallbacks consider it. If it conflicts, the force action is command-only.
            const disposeBranch = tryRegister('panechat.branch', () => t('强制分叉面板', 'Force fork panel'),
              ['force fork pane', 'new fork panel'], [branchBinding], resolve(true))
            const disposeNew = tryRegister('panechat.new', startTitle,
              ['fork pane', 'fork chat panel'], [binding, fallback, branchBinding], resolve(false))
            return () => { disposeNew?.(); disposeBranch?.() }
          }, 'threads: panechat shortcuts')
        })
      })
    }
  },
})
