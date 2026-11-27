/**
 * Codex rollouts: `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<uuid>.jsonl`.
 *
 * Record shapes (checked against real rollouts, structure only):
 * - `session_meta { payload: { id, cwd, ... } }` heads the file.
 * - `response_item` records are the conversation as the model saw it: `message` (role user, assistant, or developer
 *   which is the harness's own prompt), `reasoning { summary[] }`, tool calls (`function_call`, `custom_tool_call`,
 *   `local_shell_call`, `web_search_call`) and their `*_output` records, joined by `call_id`.
 * - `event_msg` records are UI events. Most of them mirror a response_item (the same message or reasoning again), so
 *   only the ones that carry something no response_item does are read: `task_complete` and `turn_aborted` (the turn
 *   markers) and `token_count` (usage).
 * - a custom tool's output starts with a header line, `Script completed` or `Script failed`, which is the outcome.
 *   The older function tools put `Exit code: N` in the output text (or a JSON blob with metadata.exit_code).
 * - Codex injects context as user messages (environment, AGENTS.md); those are not the user's words.
 */
import { blocksOf, describeInput, isObject, joinText, str, timeOf } from './frames.js'

const TEXT_TYPES = ['input_text', 'output_text', 'text']

/** Top-level records that are recognized and deliberately produce nothing. */
const BOOKKEEPING = new Set(['turn_context', 'world_state', 'token_usage_record', 'inter_agent_communication_metadata'])
/** response_item payloads that are recognized and deliberately produce nothing. */
const ITEM_BOOKKEEPING = new Set(['agent_message', 'additional_tools', 'configuration_update', 'ghost_snapshot', 'compaction', 'compaction_summary', 'other'])
const INJECTED = /^\s*(?:<(?:environment_context|user_instructions|turn_aborted|permissions[ _]instructions|collaboration_mode|skills_instructions|user_shell_command)\b|# AGENTS\.md instructions)/

/** @returns {boolean} false when the record is not understood (the caller counts it as unknown) */
export function handle(record, builder) {
  const payload = record.payload
  switch (record.type) {
    case 'session_meta':
      // Only the head of the file is this rollout's own; later ones are inherited from a parent thread.
      if (builder.offset === 0 && isObject(payload)) builder.session(str(payload.id), str(payload.cwd))
      return true
    case 'response_item':
      return isObject(payload) && item(payload, timeOf(record.timestamp), builder)
    case 'event_msg':
      return isObject(payload) && event(payload, builder)
    case 'compacted':
      builder.system('Context compacted')
      return true
    default:
      return BOOKKEEPING.has(record.type)
  }
}

function item(payload, at, builder) {
  switch (payload.type) {
    case 'message': {
      if (payload.role === 'developer' || payload.role === 'system') return true
      if (payload.role !== 'user' && payload.role !== 'assistant') return false
      const text = joinText(payload.content, TEXT_TYPES)
      if (payload.role === 'user' && INJECTED.test(text)) return true
      builder.text(payload.role, text, at)
      return true
    }
    case 'reasoning':
      // The summary is what Codex shows; `content` is encrypted or absent.
      builder.reasoning(joinText(payload.summary ?? payload.content, ['summary_text', 'reasoning_text', 'text']))
      return true
    case 'function_call':
      builder.call({ callId: payload.call_id, verb: payload.name, object: describeInput(payload.arguments), at })
      return true
    case 'custom_tool_call':
      builder.call({ callId: payload.call_id, verb: payload.name, object: describeInput(payload.input), at })
      return true
    case 'local_shell_call':
      builder.call({ callId: payload.call_id, verb: 'shell', object: describeInput({ command: isObject(payload.action) ? payload.action.command : null }), at })
      return true
    case 'web_search_call': {
      // Searches are recorded as one finished item, with no separate result record.
      const callId = `search@${builder.offset}`
      builder.call({ callId, verb: 'web_search', object: describeInput(isObject(payload.action) ? { query: payload.action.query, url: payload.action.url } : null), at })
      builder.result({ callId, outcome: payload.status === 'failed' ? 'error' : 'ok', at })
      return true
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
      builder.result({ callId: payload.call_id, outcome: outcomeOf(payload), at })
      return true
    default:
      return ITEM_BOOKKEEPING.has(payload.type)
  }
}

function event(payload, builder) {
  switch (payload.type) {
    case 'task_complete':
      // last_agent_message repeats the final assistant message; the client decides whether to show it twice.
      builder.final({ text: typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '', reason: 'task_complete', ms: payload.duration_ms })
      break
    case 'turn_aborted':
      builder.final({ text: '', reason: 'turn_aborted', ms: payload.duration_ms })
      break
    case 'token_count': {
      // info is null when only the rate limits changed. total_tokens grows with every response, so it names one.
      const info = payload.info
      if (isObject(info) && isObject(info.last_token_usage)) {
        const total = isObject(info.total_token_usage) ? info.total_token_usage.total_tokens : undefined
        builder.tokens({ key: typeof total === 'number' ? total : null, output: info.last_token_usage.output_tokens })
      }
      break
    }
    default:
      // Every other event is UI bookkeeping that mirrors a response_item.
      break
  }
  return true
}

function outcomeOf(payload) {
  if (payload.is_error === true || payload.success === false) return 'error'
  const output = payload.output
  if (Array.isArray(output)) {
    const first = blocksOf(output).find((part) => typeof part.text === 'string')
    return first !== undefined && /^\s*Script failed\b/.test(first.text.slice(0, 64)) ? 'error' : 'ok'
  }
  if (typeof output === 'string') {
    const head = output.slice(0, 256)
    if (/^\s*Script failed\b/.test(head)) return 'error'
    const exit = /^\s*Exit code: (-?\d+)/.exec(head)
    if (exit !== null) return Number(exit[1]) === 0 ? 'ok' : 'error'
    // Older versions return a JSON blob with the exit code under metadata.
    if (head.trimStart().startsWith('{') && output.length <= 200_000) {
      try {
        const parsed = JSON.parse(output)
        if (isObject(parsed)) {
          const code = isObject(parsed.metadata) ? parsed.metadata.exit_code : undefined
          if (parsed.success === false || (typeof code === 'number' && code !== 0)) return 'error'
        }
      } catch { /* plain text that merely starts with a brace */ }
    }
  } else if (isObject(output) && output.success === false) return 'error'
  return 'ok'
}
