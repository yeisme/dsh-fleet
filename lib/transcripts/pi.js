/**
 * pi sessions: `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`.
 *
 * Record shapes (checked against real sessions, structure only):
 * - `{ type: 'session', id, cwd, timestamp }` is the header and always the first line.
 * - `{ type: 'message', id, timestamp (ISO), message }` where message.role is `user`, `assistant`, `toolResult`,
 *   `system` (the prompt) or `bashExecution` (a command the user ran by hand). `message.timestamp` is epoch ms.
 * - assistant content blocks: `text`, `thinking`, `toolCall { id, name, arguments }`. The message carries
 *   `usage { output, ... }`, `stopReason` (`toolUse` while the agent keeps going; `stop`, `error`, `aborted` or
 *   `length` when it ends) and, on errors, `errorMessage`.
 * - toolResult: `{ toolCallId, isError, durationMs }`.
 *
 * The legacy normalizer in index.js read `Number(entry.timestamp)`, which is NaN for the ISO string; the numeric
 * time lives on `message.timestamp`.
 */
import { blocksOf, count, describeInput, isObject, joinText, str, timeOf } from './frames.js'

/** Records that change how the session runs but are not part of the conversation. */
const BOOKKEEPING = new Set(['model_change', 'thinking_level_change', 'session_info', 'custom', 'context_edit', 'label'])

/** @returns {boolean} false when the record is not understood (the caller counts it as unknown) */
export function handle(record, builder) {
  switch (record.type) {
    case 'session':
      // Only the header at the top is this file's own; a later one belongs to a fork or an import.
      if (builder.offset === 0) builder.session(str(record.id), str(record.cwd))
      return true
    case 'message':
      return message(record, builder)
    case 'custom_message': {
      // Extension messages are shown in pi only when `display` is true.
      if (record.display === true) builder.system(typeof record.content === 'string' ? record.content : joinText(record.content))
      return true
    }
    case 'compaction': {
      const before = count(record.tokensBefore)
      builder.system(before === null ? 'Context compacted' : `Context compacted · ${before} tokens before`)
      return true
    }
    default:
      return BOOKKEEPING.has(record.type)
  }
}

function message(record, builder) {
  const m = record.message
  if (!isObject(m)) return false
  const at = timeOf(m.timestamp, record.timestamp)
  switch (m.role) {
    case 'user':
      builder.text('user', joinText(m.content), at)
      return true
    case 'assistant':
      assistant(m, at, builder)
      return true
    case 'toolResult':
      builder.result({ callId: m.toolCallId, outcome: m.isError === true ? 'error' : 'ok', ms: m.durationMs })
      return true
    case 'system':
      return true
    case 'bashExecution': {
      const callId = `bash@${builder.offset}`
      builder.call({ callId, verb: 'bash', object: describeInput({ command: m.command }), at })
      builder.result({ callId, outcome: m.exitCode === 0 && m.cancelled !== true ? 'ok' : 'error' })
      return true
    }
    default:
      return false
  }
}

function assistant(m, at, builder) {
  const output = isObject(m.usage) ? m.usage.output : null
  const key = String(builder.offset)
  for (const block of blocksOf(m.content)) {
    if (block.type === 'thinking') builder.reasoning(block.thinking)
    else if (block.type === 'text') builder.text('assistant', block.text, at)
    else if (block.type === 'toolCall') {
      builder.call({ callId: block.id, verb: block.name, object: describeInput(block.arguments), at, usage: count(output) === null ? null : { key, output } })
    }
  }
  // A message that does not stop for a tool ends the agent's turn: that is pi's own turn marker. The reason is pi's
  // raw word for it. Its duration is not recorded (durationMs is one model call, not the turn), so ms stays null.
  if (typeof m.stopReason === 'string' && m.stopReason !== '' && m.stopReason !== 'toolUse') {
    builder.final({ text: m.stopReason === 'error' && typeof m.errorMessage === 'string' ? m.errorMessage : '', reason: m.stopReason, ms: null })
  }
}
