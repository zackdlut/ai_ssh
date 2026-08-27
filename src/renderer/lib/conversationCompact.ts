/**
 * In-loop context compaction for the agent's running conversation.
 *
 * The budget check used to run once, in `sendPrompt`, before the loop started.
 * Inside the loop nothing bounded anything: up to 25 steps each appended a full
 * tool result, and every one of them was replayed on every subsequent turn. A
 * long diagnostic session would quietly grow past the model's window and start
 * failing (or, worse, silently dropping the head of the prompt) with no signal
 * anywhere in the UI.
 *
 * Compaction happens in two passes, both structure-preserving. The OpenAI
 * protocol requires every announced `tool_call_id` to have exactly one matching
 * `role:'tool'` reply, so a tool result is never deleted on its own: pass one
 * shrinks result CONTENT in place, and pass two removes an assistant turn
 * together with all of its replies as one unit.
 *
 * This is deliberately synchronous and local, and it is the only thing that
 * runs on the hot path. Pass two, though, DELETES steps: the agent loses the
 * exit code it was about to act on and re-runs the command. `planCompaction`
 * exists so the caller can see that coming one turn early and pay for an LLM
 * summary instead — see `maybeSummarizeLoopHistory` in `aiService`. When that
 * summary fails or is not available, this module is still the fallback, because
 * a degraded conversation beats a failed request.
 */
import { estimateTokens } from '../../shared/contextBudget'
import type { ChatMessageDTO } from '../../shared/types'
import { digestToolResult } from './toolTrace'

/** Never touch this many trailing messages: they are what the model is reasoning about now. */
const KEEP_RECENT = 8
/** Characters kept from a trimmed tool result. */
const TRIMMED_RESULT_CHARS = 180
/**
 * Floor for the last-resort pass. Below this a result stops being evidence, so
 * the pass gives up rather than shrinking every reply into uselessness.
 */
const OVERSIZED_RESULT_FLOOR = 2000

export interface CompactResult {
  messages: ChatMessageDTO[]
  /** Tool results whose content was shrunk in place. */
  trimmed: number
  /** Whole turns removed (assistant + its tool replies counted as one). */
  dropped: number
  /** Oversized recent results shrunk by the last-resort pass. */
  condensed: number
}

function totalTokens(messages: ChatMessageDTO[]): number {
  let sum = 0
  for (const m of messages) {
    sum += estimateTokens(m.content)
    for (const call of m.tool_calls ?? []) sum += estimateTokens(call.arguments)
  }
  return sum
}

/**
 * Split the conversation into indivisible units: an assistant turn that
 * requested tools travels with every tool reply that answers it.
 */
function groupMessages(messages: ChatMessageDTO[]): ChatMessageDTO[][] {
  const groups: ChatMessageDTO[][] = []
  for (const message of messages) {
    if (message.role === 'tool' && groups.length > 0) {
      const last = groups[groups.length - 1]
      if (last[0].role === 'assistant' && last[0].tool_calls?.length) {
        last.push(message)
        continue
      }
    }
    groups.push([message])
  }
  return groups
}

function trimToolContent(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  const head = oneLine.slice(0, TRIMMED_RESULT_CHARS)
  return `[trimmed to save context] ${head}${oneLine.length > TRIMMED_RESULT_CHARS ? '…' : ''}`
}

/** Index of the largest tool result above `floor`, or -1 when none is left. */
function largestToolResult(messages: ChatMessageDTO[], floor: number): number {
  let index = -1
  let longest = floor
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role !== 'tool') continue
    if (message.content.length > longest) {
      longest = message.content.length
      index = i
    }
  }
  return index
}

/** Pass 1 applied to a copy, so the drop decision sees the same state it will. */
function trimOldResults(messages: ChatMessageDTO[], budgetTokens: number): ChatMessageDTO[] {
  const working = messages.map((m) => ({ ...m }))
  const protectedFrom = Math.max(0, working.length - KEEP_RECENT)
  for (let i = 0; i < protectedFrom; i++) {
    if (totalTokens(working) <= budgetTokens) break
    const message = working[i]
    if (message.role !== 'tool') continue
    if (message.content.startsWith('[trimmed to save context]')) continue
    if (estimateTokens(message.content) < 60) continue
    message.content = trimToolContent(message.content)
  }
  return working
}

export interface CompactionPlan {
  /** Whole turns local compaction would delete to make the budget. */
  dropCount: number
  /**
   * Messages at the very front that survive regardless — the user's original
   * instruction. A loop that forgets what it was asked is worse than one that
   * forgets how it got here.
   */
  headLength: number
  /**
   * Index the doomed turns end at. `slice(headLength, dropThrough)` is exactly
   * what would be lost, and both ends fall on a turn boundary so replacing that
   * span cannot orphan a tool reply from the call that announced it.
   */
  dropThrough: number
}

/**
 * Look ahead at what `compactConversation` would have to throw away.
 *
 * Trimming result bodies is lossy but recoverable — the model still sees which
 * command ran. Dropping a turn is not: the step vanishes, and the agent's only
 * remaining trace of it is the one-line ledger entry. So the loop asks this
 * first, and when the answer is "turns will be dropped" it spends a summarizer
 * call to convert those turns into a record instead of a hole.
 */
export function planCompaction(
  messages: ChatMessageDTO[],
  budgetTokens: number
): CompactionPlan {
  const none: CompactionPlan = { dropCount: 0, headLength: 0, dropThrough: 0 }
  if (budgetTokens <= 0 || totalTokens(messages) <= budgetTokens) return none
  const working = trimOldResults(messages, budgetTokens)
  if (totalTokens(working) <= budgetTokens) return none

  const groups = groupMessages(working)
  const first = groups.length > 0 ? groups[0] : []
  const rest = groups.slice(1)
  let dropCount = 0
  let dropThrough = first.length
  while (rest.length > 1 && totalTokens([...first, ...rest.flat()]) > budgetTokens) {
    const gone = rest.shift()
    dropThrough += gone?.length ?? 0
    dropCount++
  }
  return dropCount > 0 ? { dropCount, headLength: first.length, dropThrough } : none
}

/**
 * Shrink the conversation to fit `budgetTokens`, preserving tool-call pairing.
 * Returns the original array untouched when it already fits.
 */
export function compactConversation(
  messages: ChatMessageDTO[],
  budgetTokens: number
): CompactResult {
  if (budgetTokens <= 0 || totalTokens(messages) <= budgetTokens) {
    return { messages, trimmed: 0, dropped: 0, condensed: 0 }
  }

  // Pass 1: shrink old tool results in place. Their arguments and ids survive,
  // so the model still sees what it ran and in what order — just not the full
  // several-kilobyte output of a command it already acted on.
  const working = trimOldResults(messages, budgetTokens)
  const trimmed = working.filter(
    (m, i) => m.content !== messages[i].content && m.content.startsWith('[trimmed to save context]')
  ).length

  if (totalTokens(working) <= budgetTokens) {
    return { messages: working, trimmed, dropped: 0, condensed: 0 }
  }

  // Pass 2: drop the oldest whole turns. The very first message is kept
  // regardless — it carries the user's original instruction, and a loop that
  // forgets what it was asked to do is worse than one that forgets how it got
  // here.
  const groups = groupMessages(working)
  const first = groups.length > 0 ? groups[0] : []
  const rest = groups.slice(1)
  let dropped = 0
  while (rest.length > 1 && totalTokens([...first, ...rest.flat()]) > budgetTokens) {
    rest.shift()
    dropped++
  }

  const kept = [...first, ...rest.flat()]
  if (dropped > 0) {
    kept.splice(first.length, 0, {
      role: 'system',
      content: `[${dropped} earlier step(s) were dropped from this conversation to stay within the context window. Their outcomes are summarized in the task execution history; do not assume they were never performed.]`
    })
  }

  // Pass 3: a single oversized result can blow the budget on its own — reading
  // 1000 lines of a log is ~120k characters — and neither pass above can touch
  // it. Pass 1 skips the recent window it lives in, and pass 2 will not drop
  // the turn that is being reasoned about. So the request went out over-window,
  // the server truncated the prompt from the front, and the user's own question
  // was what fell off the edge.
  //
  // Shrink the biggest offenders instead of dropping them, keeping head and
  // tail so the verdict at the end of the output survives. Each step must
  // strictly reduce length, which is what guarantees termination.
  let condensed = 0
  while (totalTokens(kept) > budgetTokens) {
    const index = largestToolResult(kept, OVERSIZED_RESULT_FLOOR)
    if (index < 0) break
    const current = kept[index].content
    const target = Math.max(OVERSIZED_RESULT_FLOOR, Math.floor(current.length / 2))
    const next = digestToolResult(current, target)
    if (next.length >= current.length) break
    kept[index] = { ...kept[index], content: next }
    condensed++
  }

  return { messages: kept, trimmed, dropped, condensed }
}
