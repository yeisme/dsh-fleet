/**
 * Claude Code sessions: `~/.claude/projects/<cwd with non-alphanumerics as dashes>/<session uuid>.jsonl`.
 *
 * Record shapes (checked against real sessions, structure only):
 * - `user` and `assistant` records carry `message.content` (a string, or blocks), `timestamp` (ISO) and `sessionId`.
 *   An assistant message is written as one record per content block, all sharing `message.id` and repeating
 *   `message.usage`, so usage is counted once per message id.
 * - tool results come back as `user` records whose blocks are `tool_result { tool_use_id, is_error? }`.
 * - `system` records with `subtype: 'turn_duration'` and `durationMs` end a turn: that is Claude's own turn marker.
 * - `isSidechain: true` marks a sub-agent's own conversation, which is not this thread.
 * - `isMeta: true` user records are text the harness injected (skills, caveats), not the user's words.
 * - a long tail of bookkeeping record types (attachments, request logs, titles, ...) that carry no conversation.
 */
import { blocksOf, count, describeInput, isObject, timeOf } from './frames.js'

/** Record types that are recognized and deliberately produce nothing. */
const BOOKKEEPING = new Set([
  'attachment', 'api-request', 'api-request-blob', 'api-request-shape', 'atis-latch', 'last-prompt', 'mode', 'permission-mode',
  'ai-title', 'custom-title', 'agent-name', 'agent-color', 'agent-setting', 'tools-used', 'cost-state', 'file-history-snapshot',
  'file-history-delta', 'queue-operation', 'fork-context-ref', 'summary', 'pr-link', 'progress', 'tag',
])

/** The harness stores slash commands, shell escapes and reminders as user text wrapped in these tags. */
const INJECTED = /^\s*<(?:command-name|command-message|command-args|local-command-(?:caveat|stdout|stderr)|system-reminder|bash-input|bash-stdout|bash-stderr|task-notification)\b/
const INTERRUPTED = /^\s*\[Request interrupted/

/** @returns {boolean} false when the record is not understood (the caller counts it as unknown) */
export function handle(record, builder) {
  if (record.isSidechain === true) return true
  switch (record.type) {
    case 'user':
      return user(record, builder)
    case 'assistant':
      return assistant(record, builder)
    case 'system':
      if (record.subtype === 'turn_duration') builder.final({ text: '', reason: 'turn_duration', ms: record.durationMs })
      else if (record.subtype === 'compact_boundary') builder.system('Context compacted')
      // Every other subtype (api errors, away summaries, local commands) is session housekeeping.
      return true
    default:
      return BOOKKEEPING.has(record.type)
  }
}

function userText(text, at, builder) {
  if (typeof text !== 'string' || INJECTED.test(text)) return
  // Claude records an interruption as a user message, but the user did not type it.
  if (INTERRUPTED.test(text)) builder.system(text.trim())
  else builder.text('user', text, at)
}

function user(record, builder) {
  builder.noteSession(record.sessionId)
  if (record.isMeta === true) return true
  const message = record.message
  if (!isObject(message)) return false
  const at = timeOf(record.timestamp)
  if (typeof message.content === 'string') {
    userText(message.content, at, builder)
    return true
  }
  if (!Array.isArray(message.content)) return false
  for (const block of blocksOf(message.content)) {
    if (block.type === 'tool_result') builder.result({ callId: block.tool_use_id, outcome: block.is_error === true ? 'error' : 'ok', at })
    else if (block.type === 'text') userText(block.text, at, builder)
  }
  return true
}

function assistant(record, builder) {
  builder.noteSession(record.sessionId)
  const message = record.message
  if (!isObject(message)) return false
  const at = timeOf(record.timestamp)
  const output = isObject(message.usage) ? message.usage.output_tokens : null
  // The API-error placeholders are written as assistant messages; they are the system speaking, not the model.
  const role = record.isApiErrorMessage === true ? 'system' : 'assistant'
  const key = typeof message.id === 'string' ? message.id : String(record.uuid ?? builder.offset)
  for (const block of blocksOf(message.content)) {
    if (block.type === 'thinking') builder.reasoning(block.thinking)
    else if (block.type === 'text') builder.text(role, block.text, role === 'system' ? null : at)
    else if (block.type === 'tool_use') {
      builder.call({ callId: block.id, verb: block.name, object: describeInput(block.input), at, usage: count(output) === null ? null : { key, output } })
    }
  }
  return true
}
