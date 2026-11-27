/**
 * Synthetic transcript builders for test/transcripts.test.mjs. Everything is invented and neutral: the paths are
 * `/Users/demo/...`, the ids are made up, and no real conversation, prompt or account appears anywhere.
 *
 * Record shapes follow what pi, Claude Code and Codex write (structure only), so the adapters are exercised on the
 * layouts they will meet. For each kind `turn(i, t)` returns the records of one conversation turn that maps to the same
 * six frames: user text, reasoning, assistant text, a work frame (Read ok after 12 ms, Bash error after 34 ms, 40
 * output tokens), assistant text, and the kind's own end-of-turn marker.
 */
import path from 'node:path'

export const CWD = '/Users/demo/work/app'
export const SESSION_ID = '0b9f6c3e-5a1d-4e8b-9c27-3f1a6d8e2b40'
export const T0 = Date.UTC(2026, 0, 2, 3, 4, 5)

export const iso = (ms) => new Date(ms).toISOString()

/** Records -> JSONL text. */
export const jsonl = (records, eol = '\n') => records.map((record) => JSON.stringify(record)).join(eol) + eol

/** Where each kind keeps the session file of a cwd under a home directory. */
export const layout = {
  pi: (home, { cwd = CWD, id = SESSION_ID } = {}) =>
    path.join(home, '.pi', 'agent', 'sessions', `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`, `2026-01-02T03-04-05-000Z_${id}.jsonl`),
  claude: (home, { cwd = CWD, id = SESSION_ID } = {}) =>
    path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`),
  codex: (home, { id = SESSION_ID, day = '2026/01/02', stamp = '2026-01-02T03-04-05' } = {}) =>
    path.join(home, '.codex', 'sessions', ...day.split('/'), `rollout-${stamp}-${id}.jsonl`),
}

/** The agent session herdr would report for a file. */
export const sessionFor = (kind, file) => ({ agent: kind, kind: 'path', source: `herdr:${kind}`, value: file })

/** What `turn` produces, as frames without ids and times, for each kind's end-of-turn marker. */
export const FINAL = {
  pi: (i) => ({ kind: 'final', text: '', reason: 'stop', ms: null }),
  claude: (i) => ({ kind: 'final', text: '', reason: 'turn_duration', ms: 210 }),
  codex: (i) => ({ kind: 'final', text: `done ${i}`, reason: 'task_complete', ms: 210 }),
}

export const expectedTurn = (kind, i) => [
  { kind: 'text', role: 'user', text: `question ${i}` },
  { kind: 'reasoning', text: `plan ${i}` },
  { kind: 'text', role: 'assistant', text: `working ${i}` },
  {
    kind: 'work',
    summary: 'Read · Bash',
    rows: [
      { verb: 'Read', object: `/Users/demo/work/app/file${i}.txt`, outcome: 'ok', ms: 12 },
      { verb: 'Bash', object: `ls -la ${i}`, outcome: 'error', ms: 34 },
    ],
    tokens: 40,
  },
  { kind: 'text', role: 'assistant', text: `done ${i}` },
  FINAL[kind](i),
]

/* ------------------------------------------------------------------------------------------------- pi */

const piMessage = (id, t, message) => ({ type: 'message', id, parentId: null, timestamp: iso(t), message: { ...message, timestamp: t } })

const pi = {
  header: () => [{ type: 'session', version: 3, id: SESSION_ID, timestamp: iso(T0), cwd: CWD }],
  user: (i, t, text = `question ${i}`) => piMessage(`u${i}`, t, { role: 'user', content: [{ type: 'text', text }] }),
  assistant: (i, t, blocks, extra = {}) => piMessage(`a${i}`, t, { role: 'assistant', content: blocks, usage: { input: 900, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 940 }, stopReason: 'toolUse', durationMs: 800, ...extra }),
  call: (id, name, args) => ({ type: 'toolCall', id, name, arguments: args }),
  result: (i, t, callId, name, isError, durationMs) => piMessage(`r${i}${callId}`, t, { role: 'toolResult', toolCallId: callId, toolName: name, content: [{ type: 'text', text: isError ? 'no such directory' : 'file contents' }], isError, ...(durationMs === undefined ? {} : { durationMs }) }),
  turn(i, t) {
    return [
      this.user(i, t),
      this.assistant(i, t + 100, [
        { type: 'thinking', thinking: `plan ${i}`, thinkingSignature: 'sig' },
        { type: 'text', text: `working ${i}` },
        this.call(`c${i}a`, 'Read', { path: `/Users/demo/work/app/file${i}.txt` }),
        this.call(`c${i}b`, 'Bash', { command: `ls -la ${i}` }),
      ]),
      this.result(i, t + 122, `c${i}a`, 'Read', false, 12),
      this.result(i, t + 145, `c${i}b`, 'Bash', true, 34),
      piMessage(`d${i}`, t + 200, { role: 'assistant', content: [{ type: 'text', text: `done ${i}` }], usage: { output: 10 }, stopReason: 'stop' }),
    ]
  },
  /** One finished tool step: a call and its result, 20 ms apart. */
  step(i, j, t) {
    const callId = `s${i}.${j}`
    return [
      piMessage(`sa${i}.${j}`, t, { role: 'assistant', content: [this.call(callId, 'Bash', { command: `echo ${j}` })], usage: { output: 5 }, stopReason: 'toolUse' }),
      this.result(`s${i}.${j}`, t + 20, callId, 'Bash', false, 20),
    ]
  },
  /** An assistant message that ends the agent's turn. */
  say: (i, t, text) => piMessage(`say${i}`, t, { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' }),
  /** The calls of a turn without their results: the run is still open. */
  pending(i, t) {
    return this.turn(i, t).slice(0, 2)
  },
  unrecognized: () => ({ type: 'mystery-v9', id: 'x1' }),
  bookkeeping: (t = T0) => ({ type: 'model_change', id: 'm1', parentId: null, timestamp: iso(t), provider: 'demo', modelId: 'demo-model' }),
}

/* --------------------------------------------------------------------------------------------- claude */

const claudeBase = (t, extra) => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd: CWD, sessionId: SESSION_ID, version: '2.0.0', timestamp: iso(t), ...extra })

const claude = {
  header: () => [],
  user: (i, t, text = `question ${i}`) => ({ ...claudeBase(t), type: 'user', uuid: `u${i}`, message: { role: 'user', content: text } }),
  /** One record per content block, all sharing the message id and its usage, as Claude Code writes them. */
  block: (i, t, block, messageId = `msg_${i}a`, extra = {}) => ({
    ...claudeBase(t), type: 'assistant', uuid: `b${i}-${t}`, ...extra,
    message: { id: messageId, type: 'message', role: 'assistant', model: 'demo-model', content: [block], usage: { input_tokens: 5, output_tokens: 40 } },
  }),
  toolResult: (i, t, toolUseId, isError) => ({
    ...claudeBase(t), type: 'user', uuid: `r${i}${toolUseId}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: isError ? 'No such directory' : 'file contents', ...(isError ? { is_error: true } : {}) }] },
  }),
  turn(i, t) {
    return [
      this.user(i, t),
      this.block(i, t + 100, { type: 'thinking', thinking: `plan ${i}`, signature: 'sig' }),
      this.block(i, t + 101, { type: 'text', text: `working ${i}` }),
      this.block(i, t + 110, { type: 'tool_use', id: `tu${i}a`, name: 'Read', input: { file_path: `/Users/demo/work/app/file${i}.txt` } }),
      this.block(i, t + 111, { type: 'tool_use', id: `tu${i}b`, name: 'Bash', input: { command: `ls -la ${i}`, description: 'List' } }),
      this.toolResult(i, t + 122, `tu${i}a`, false),
      this.toolResult(i, t + 145, `tu${i}b`, true),
      this.block(i, t + 200, { type: 'text', text: `done ${i}` }, `msg_${i}b`),
      { ...claudeBase(t + 210), type: 'system', subtype: 'turn_duration', uuid: `s${i}`, durationMs: 210, messageCount: 5, isMeta: false },
    ]
  },
  step(i, j, t) {
    const id = `st${i}.${j}`
    return [this.block(i, t, { type: 'tool_use', id, name: 'Bash', input: { command: `echo ${j}` } }, `msg_s${i}.${j}`), this.toolResult(i, t + 20, id, false)]
  },
  say: (i, t, text) => ({ ...claudeBase(t), type: 'assistant', uuid: `say${i}`, message: { id: `msg_say${i}`, type: 'message', role: 'assistant', model: 'demo-model', content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 7 } } }),
  pending(i, t) {
    return this.turn(i, t).slice(0, 5)
  },
  unrecognized: () => ({ type: 'hologram', uuid: 'x1' }),
  bookkeeping: (t = T0) => ({ type: 'last-prompt', sessionId: SESSION_ID, lastPrompt: 'demo', timestamp: iso(t) }),
}

/* ---------------------------------------------------------------------------------------------- codex */

const codexRecord = (t, type, payload) => ({ timestamp: iso(t), type, payload })
const codexItem = (t, payload) => codexRecord(t, 'response_item', payload)

const codex = {
  header: (extra = {}) => [codexRecord(T0, 'session_meta', { id: SESSION_ID, cwd: CWD, originator: 'codex_cli', cli_version: '0.0.0', ...extra })],
  user: (i, t, text = `question ${i}`) => codexItem(t, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }),
  item: codexItem,
  event: (t, payload) => codexRecord(t, 'event_msg', payload),
  turn(i, t) {
    return [
      this.user(i, t),
      codexItem(t + 100, { type: 'reasoning', summary: [{ type: 'summary_text', text: `plan ${i}` }], content: null, encrypted_content: null }),
      codexItem(t + 101, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `working ${i}` }] }),
      codexItem(t + 110, { type: 'custom_tool_call', name: 'Read', call_id: `k${i}a`, input: `/Users/demo/work/app/file${i}.txt`, status: 'completed' }),
      codexItem(t + 111, { type: 'function_call', name: 'Bash', call_id: `k${i}b`, arguments: JSON.stringify({ command: `ls -la ${i}` }) }),
      this.event(t + 112, { type: 'token_count', info: { total_token_usage: { total_tokens: 1000 + i * 100 }, last_token_usage: { output_tokens: 40 } } }),
      codexItem(t + 122, { type: 'custom_tool_call_output', call_id: `k${i}a`, output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: 'file contents' }] }),
      codexItem(t + 145, { type: 'function_call_output', call_id: `k${i}b`, output: 'Exit code: 1\nWall time: 0.1 seconds\nOutput:\nNo such directory' }),
      codexItem(t + 200, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `done ${i}` }] }),
      this.event(t + 210, { type: 'task_complete', last_agent_message: `done ${i}`, duration_ms: 210 }),
    ]
  },
  step(i, j, t) {
    const id = `ks${i}.${j}`
    return [
      codexItem(t, { type: 'function_call', name: 'Bash', call_id: id, arguments: JSON.stringify({ command: `echo ${j}` }) }),
      codexItem(t + 20, { type: 'function_call_output', call_id: id, output: 'Exit code: 0\nWall time: 0.0 seconds\nOutput:\nok' }),
    ]
  },
  say: (i, t, text) => codexItem(t, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }),
  pending(i, t) {
    return this.turn(i, t).slice(0, 6)
  },
  unrecognized: () => ({ timestamp: iso(T0), type: 'hologram', payload: {} }),
  bookkeeping: (t = T0) => codexRecord(t, 'turn_context', { cwd: CWD, model: 'demo-model' }),
}

export const builders = { pi, claude, codex }
