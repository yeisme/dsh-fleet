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

    function tabCaption(title, state, t) {
      return h('span', { 'data-dsh-pane-title': '', title },
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
      const startTitle = () => t('新会话面板', 'New chat panel')
      const description = () => t('选目录，开一个带原生输入框的面板', 'Choose a directory and open a chat panel')
      const failureText = (error) => String(error?.message ?? error)

      const CSS = `
[data-dsh-pane-chat]{display:flex;width:100%;height:100%;min-width:0;min-height:0;}
[data-dsh-pane-start]{display:grid;align-content:start;gap:10px;width:100%;max-width:26rem;margin-inline:auto;padding:16px;box-sizing:border-box;}
[data-dsh-pane-start] label{display:grid;gap:6px;min-width:0;}
[data-dsh-pane-start] input,[data-dsh-pane-start] button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;}
[data-dsh-pane-start] button{justify-self:start;cursor:pointer;}
[data-dsh-pane-start] button:disabled{opacity:.55;cursor:default;}
[data-dsh-pane-error]{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;margin:0;}
[data-dsh-pane-chat]>[role]{padding:12px;}
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

      ctx.inject(['resources', 'sidebarRight'], (scope) => {
        const { mounted, openTabs } = scope.sidebarRight
        const subscribeMounted = (listener) => mounted.subscribe(listener)
        const getMounted = () => mounted.getSnapshot()
        const subscribeTabs = (listener) => openTabs.subscribe(listener)
        const getTabs = () => openTabs.getSnapshot()

        function PaneChatTab({ sessionId, useResource, useTabInfo, SessionProvider, renderSlot }) {
          const { tab } = useTabInfo()
          const resource = useResource(tab.contentId)
          const mainSessionId = React.useSyncExternalStore(subscribeMounted, getMounted)
          const tabs = React.useSyncExternalStore(subscribeTabs, getTabs)
          const first = tabs.find((entry) => entry.sessionId === sessionId
            && entry.kind === 'panechat' && entry.contentId === tab.contentId)
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
          return h('div', { 'data-dsh-pane-chat': '' }, content)
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
          return tabCaption(titleFor(summary, tab.title), state, statusText)
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

      ctx.inject(['remote'], (scope) => {
        function PaneStart({ sessionId, useSessions, useTabInfo }) {
          const { tab } = useTabInfo()
          const sessionCwd = useSessions((state) => state.byId[sessionId]?.cwd) || '~'
          const [cwd, setCwd] = useState(undefined)
          const [creating, setCreating] = useState(false)
          const [failure, setFailure] = useState('')
          const directory = cwd ?? sessionCwd

          async function submit(event) {
            event.preventDefault()
            if (creating || directory.trim() === '') return
            setCreating(true)
            setFailure('')
            try {
              const id = await createPaneSession(scope, directory)
              if (!tab.signal.aborted) tab.actions.openResource(paneAddress(id), { replaceTab: true })
            } catch (error) {
              if (!tab.signal.aborted) setFailure(failureText(error))
            } finally {
              if (!tab.signal.aborted) setCreating(false)
            }
          }

          return h('form', { 'data-dsh-pane-start': '', onSubmit: submit, 'aria-busy': creating },
            h('label', null, t('目录', 'Directory'),
              h('input', { type: 'text', value: directory, required: true, disabled: creating,
                onChange: (event) => setCwd(event.target.value) })),
            h('button', { type: 'submit', disabled: creating || directory.trim() === '' },
              creating ? t('正在创建…', 'Creating…') : t('创建', 'Create')),
            failure && h('p', { role: 'alert', 'data-dsh-pane-error': '' }, failure))
        }

        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
          name: 'sidebar.right.pane.tab',
          key: PANE_START_ID,
        }, PaneStart)), 'threads: panechat launch body')
      })

      ctx.inject(['conversation', 'sidebarRight', 'remote'], (scope) => {
        const pending = new Set()
        async function openFromCurrent(owner, cwd, noticeSession = owner) {
          if (scope.sidebarRight.mounted.getSnapshot() !== owner || pending.has(owner)) return
          pending.add(owner)
          try {
            await openPane(scope, cwd, (address) => {
              if (scope.sidebarRight.mounted.getSnapshot() !== owner) {
                throw new Error(t('会话已创建，右栏已切换', 'Chat created, but the active sidebar has changed'))
              }
              scope.sidebarRight.openResource(address)
            })
          } catch (error) {
            const actx = scope.sessions.scope(noticeSession)
            if (actx !== undefined) scope.conversation.input.for(actx).notify('error', failureText(error))
          } finally {
            pending.delete(owner)
          }
        }

        scope.inject(['commandUi'], (commands) => {
          commands.effect(() => commands.commandUi.register({
            name: 'panechat',
            label: startTitle,
            description,
            available: () => scope.sidebarRight.mounted.getSnapshot() !== undefined,
            ui: { kind: 'action', run: ({ sessionId }) => {
              const owner = scope.sidebarRight.mounted.getSnapshot()
              if (owner === undefined) return
              const cwd = scope.sessions.list.getSnapshot().byId[sessionId]?.cwd || '~'
              void openFromCurrent(owner, cwd, sessionId)
            } },
          }), 'threads: /panechat')
        })

        scope.inject(['shortcuts'], (keyboard) => {
          keyboard.effect(() => {
            const shortcuts = keyboard.shortcuts
            const register = (binding) => shortcuts.register({
              id: 'panechat.new',
              label: startTitle,
              aliases: ['new pane', 'new chat panel'],
              defaults: {
                'desktop:macos': binding, 'desktop:windows': binding, 'desktop:linux': binding,
                'web:macos': binding, 'web:windows': binding,
              },
              regions: ['page', 'editable', 'terminal'],
              modals: [],
              resolve: () => {
                const owner = scope.sidebarRight.mounted.getSnapshot()
                const cwd = owner === undefined ? undefined : scope.sessions.list.getSnapshot().byId[owner]?.cwd?.trim()
                if (!cwd) return { status: 'blocked', reason: t('当前主会话没有可用目录', 'No directory for the current main chat') }
                return { status: 'handled', run: () => { void openFromCurrent(owner, cwd) } }
              },
            })
            const binding = { code: 'KeyJ', modifiers: ['primary', 'alt'] }
            const fallback = { ...binding, code: 'KeyU' }
            const { issue, conflicts } = shortcuts.describeBinding(binding)
            if (issue !== null || conflicts.length > 0) return register(fallback)
            try {
              return register(binding)
            } catch (error) {
              if (!failureText(error).startsWith('Conflicting shortcut defaults:')) throw error
              return register(fallback)
            }
          }, 'threads: new pane shortcut')
        })
      })
    }
  },
})
