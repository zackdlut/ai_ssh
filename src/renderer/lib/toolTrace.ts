/**
 * Reconstruct a model-facing conversation (including the tool-call chain) from
 * persisted chat messages.
 *
 * Every user turn used to rebuild history as `{ role, content }` only, which
 * silently deleted every tool call and every tool result from the model's view
 * of the session. The visible prose said "I restarted nginx"; the model's
 * actual context did not contain the command, its exit code, or its output — so
 * a follow-up like "now check it started cleanly" had nothing to work from, and
 * a restart wiped even that.
 *
 * Replaying the chain is not optional bookkeeping: the OpenAI protocol requires
 * every `tool_call_id` announced by an assistant message to be answered by a
 * matching `role:'tool'` message. A single missing pair rejects the whole
 * request, so the pairing here is emitted as an inseparable unit.
 */
import type { ChatMessageDTO, CopilotChatMessage, ToolCallView } from '../../shared/types'

/**
 * Cap for a replayed tool result. Large enough to keep an exit code plus the
 * meaningful head and tail of command output, small enough that a 20-step
 * session's full trace stays affordable to resend each turn.
 */
export const TOOL_DIGEST_MAX = 900

/** Result text used when a call was never given one. */
const NO_RESULT = 'Done.'

/**
 * Condense a tool result for replay, keeping the head and the tail. Command
 * output puts its verdict at the end (the error line, the final summary), so a
 * head-only cut throws away the part the model most needs.
 */
export function digestToolResult(text: string, max = TOOL_DIGEST_MAX): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  const headLen = Math.floor(max * 0.6)
  const tailLen = max - headLen
  const head = trimmed.slice(0, headLen)
  const tail = trimmed.slice(-tailLen)
  const dropped = trimmed.length - headLen - tailLen
  return `${head}\n…[${dropped} characters trimmed]…\n${tail}`
}

/** The text a completed call contributes back to the model. */
export function toolCallContent(call: ToolCallView): string {
  if (call.status === 'rejected') return call.result ?? 'User rejected this action.'
  if (call.status === 'error') return `Error: ${call.error ?? 'unknown error'}`
  if (call.status === 'pending' || call.status === 'running') {
    return 'This call was interrupted and never completed.'
  }
  return call.result ?? NO_RESULT
}

/** The compact text used when this call is replayed on a later turn. */
export function toolCallDigest(call: ToolCallView): string {
  return call.digest ?? digestToolResult(toolCallContent(call))
}

/**
 * Expand one persisted chat message into the model messages it represents:
 * an assistant turn carrying `tool_calls`, immediately followed by one
 * `role:'tool'` message per call.
 */
function expandMessage(message: CopilotChatMessage): ChatMessageDTO[] {
  const calls = message.toolCalls
  if (message.role !== 'assistant' || !calls || calls.length === 0) {
    // A blank assistant bubble (e.g. an interrupted turn) carries no
    // information and some providers reject empty content outright.
    if (!message.content.trim()) return []
    return [{ role: message.role, content: message.content }]
  }

  const out: ChatMessageDTO[] = [
    {
      role: 'assistant',
      content: message.content,
      tool_calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args }))
    }
  ]
  for (const call of calls) {
    out.push({ role: 'tool', tool_call_id: call.id, content: toolCallDigest(call) })
  }
  return out
}

/** Rebuild the full model conversation for a chat, tool chain included. */
export function buildHistoryFromMessages(messages: CopilotChatMessage[]): ChatMessageDTO[] {
  return messages.flatMap(expandMessage)
}

/**
 * Text used to size a persisted message against the context budget. The budget
 * previously measured only visible prose, so a turn holding several thousand
 * characters of tool output counted as near zero and compression fired far too
 * late. Kept 1:1 with `messages` so a compression decision made on this list
 * can be applied back to the original array by index.
 */
export function messageBudgetText(message: CopilotChatMessage): string {
  const parts = [message.content]
  for (const call of message.toolCalls ?? []) {
    parts.push(`${call.name}(${call.args})`, toolCallDigest(call))
  }
  return parts.filter(Boolean).join('\n')
}
