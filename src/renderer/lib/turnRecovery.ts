/**
 * What to do about an LLM turn the provider failed, decided without touching
 * anything.
 *
 * The policy lives apart from the loop that applies it for one reason: the
 * failure this exists for is not reproducible from a unit test that has to mock
 * a chat store, an IPC bridge and a streaming provider. It took a 32k window
 * behind a 128k setting, nineteen turns of growth, and a backend whose
 * over-window message names a missing user message rather than the overflow.
 * The rules are worth checking against that trajectory directly.
 *
 * Every retry here is bounded and the caller announces each one. An unbounded
 * or silent retry loop against a paid endpoint is worse than the abandoned task
 * it would be replacing.
 */

/**
 * What kind of failure the provider reported, which decides what is worth
 * trying next. Classification is on the message text because that is all an
 * OpenAI-compatible endpoint reliably gives us — the status code is routinely
 * 500 for things that are not server faults at all.
 */
export type FailureClass = 'context' | 'transient' | 'fatal'

/**
 * The prompt did not fit. Backends word this every possible way, and the worst
 * of them never mention size: an Ollama-served Qwen3 answers a prompt it
 * truncated from the front with "no user query found in messages", naming the
 * message its own truncation removed rather than the overflow that caused it.
 */
const CONTEXT_FAILURE =
  /no user query found|context length|context window|maximum context|too many tokens|prompt is too long|reduce the length|input length|exceeds the maximum/i

/**
 * Says nothing about the request itself, so re-sending the same bytes is a
 * legitimate move rather than a way to fail twice.
 */
const TRANSIENT_FAILURE =
  /\b(429|500|502|503|504)\b|rate ?limit|overloaded|server error|timed out|timeout|temporarily|econnreset|etimedout|econnrefused|enotfound|epipe|socket hang up|cannot reach the model endpoint/i

export function classifyFailure(error: string): FailureClass {
  // Order matters: an over-window rejection frequently ARRIVES as a 500, and
  // the specific diagnosis has a specific fix that is cheaper than waiting.
  if (CONTEXT_FAILURE.test(error)) return 'context'
  if (TRANSIENT_FAILURE.test(error)) return 'transient'
  return 'fatal'
}

/** One compaction retry per task: a second identical refusal is not about size. */
export const MAX_CONTEXT_RECOVERIES = 1
export const MAX_TRANSIENT_RETRIES = 2
/** Backoff before each transient attempt, in order. */
export const TRANSIENT_BACKOFF_MS = [2000, 6000]
/** Budget cut applied after the provider cut a reply at the output limit. */
export const TRUNCATION_SQUEEZE = 0.5
export const MAX_TRUNCATION_RETRIES = 1

/** Retries a task has already spent, per failure class. */
export interface RecoveryCounters {
  contextRecoveries?: number
  transientRetries?: number
  truncationRetries?: number
}

export type RecoveryPlan =
  /**
   * Shrink the payload and re-send immediately. Nothing about the endpoint
   * needs time; the request needed to be smaller.
   */
  | { kind: 'compact'; attempt: number; max: number; waitMs: 0 }
  /** Wait, then re-send the same request. */
  | { kind: 'backoff'; attempt: number; max: number; waitMs: number }
  /** Hand the failure to the user: nothing left to try, or nothing worth trying. */
  | { kind: 'none'; reason: 'fatal' | 'exhausted' }

/**
 * Decide how to answer a failed turn. Pure: the caller increments its own
 * counters from `attempt` so the decision can be tested against a trajectory.
 */
export function planRecovery(counters: RecoveryCounters, error: string): RecoveryPlan {
  const kind = classifyFailure(error)
  if (kind === 'fatal') return { kind: 'none', reason: 'fatal' }

  if (kind === 'context') {
    const attempt = (counters.contextRecoveries ?? 0) + 1
    if (attempt > MAX_CONTEXT_RECOVERIES) return { kind: 'none', reason: 'exhausted' }
    return { kind: 'compact', attempt, max: MAX_CONTEXT_RECOVERIES, waitMs: 0 }
  }

  const attempt = (counters.transientRetries ?? 0) + 1
  if (attempt > MAX_TRANSIENT_RETRIES) return { kind: 'none', reason: 'exhausted' }
  return {
    kind: 'backoff',
    attempt,
    max: MAX_TRANSIENT_RETRIES,
    waitMs: TRANSIENT_BACKOFF_MS[attempt - 1] ?? TRANSIENT_BACKOFF_MS[0]
  }
}

/**
 * Decide what to do about a reply the provider CUT at the output limit.
 *
 * A `length` finish is not a short answer, it is half of one: the prose stops
 * mid-sentence and a tool call stops mid-arguments. The fix is not a smaller
 * window — that was the right size — but a different split between prompt and
 * answer, so the conversation budget is squeezed for the rest of the task.
 */
export function planTruncationRecovery(
  counters: RecoveryCounters,
  currentSqueeze = 1
): { retry: boolean; attempt: number; squeeze: number } {
  const attempt = (counters.truncationRetries ?? 0) + 1
  if (attempt > MAX_TRUNCATION_RETRIES) {
    return { retry: false, attempt: attempt - 1, squeeze: currentSqueeze }
  }
  return { retry: true, attempt, squeeze: currentSqueeze * TRUNCATION_SQUEEZE }
}
