/**
 * Loop Guard for the SSH agent loop.
 *
 * The function-calling loop has no built-in bound: a model can, in principle,
 * emit `tool -> result -> tool` forever (repeating a failing command, re-reading
 * the same log, or drifting without progress). For a fleet of DevOps users that
 * means runaway API spend, stuck sessions, and commands hammered at production
 * hosts. This guard enforces hard limits at the single choke point where a turn
 * continues into the next one.
 */
import { estimateTokens } from '../../shared/contextBudget'

/** Hard cap on LLM turns within a single user task. */
export const MAX_STEPS = 25
/** Trip after this many consecutive identical (command + result) turns. */
export const MAX_REPEAT_NO_PROGRESS = 3
/** Cumulative estimated-token budget for a single task before forcing a stop. */
export const TASK_TOKEN_BUDGET = 1_500_000

export interface GuardState {
  /** Number of LLM turns taken in this task so far. */
  stepCount: number
  /** Cumulative estimated tokens sent across all turns of this task. */
  tokenSpent: number
  /** Signatures of completed tool turns, for no-progress detection. */
  turnHistory: string[]
}

export type GuardReason = 'max_steps' | 'repeat_no_progress' | 'token_budget'

export type GuardTrip = { tripped: false } | { tripped: true; reason: GuardReason }

export function createGuardState(): GuardState {
  return { stepCount: 0, tokenSpent: 0, turnHistory: [] }
}

/** Add the estimated token cost of a turn's outgoing messages. */
export function accountTokens(state: GuardState, texts: string[]): void {
  let sum = 0
  for (const t of texts) sum += estimateTokens(t)
  state.tokenSpent += sum
}

/** Small, stable string hash (djb2) used to fold tool results into a signature. */
function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function normalizeArgs(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') {
      return JSON.stringify(parsed, Object.keys(parsed).sort())
    }
  } catch {
    /* fall through to raw */
  }
  return raw.trim()
}

/**
 * Signature of a completed tool turn: the tool names + normalized args paired
 * with a hash of each result. Two turns with the same signature ran the same
 * calls AND got the same results — i.e. no progress was made.
 */
export function turnSignature(
  calls: { name: string; args: string; result: string }[]
): string {
  return calls
    .map((c) => `${c.name}(${normalizeArgs(c.args)})=>${hashString(c.result)}`)
    .sort()
    .join('|')
}

export function recordTurn(state: GuardState, signature: string): void {
  state.turnHistory.push(signature)
  // Bound the history; only the recent tail matters for repeat detection.
  if (state.turnHistory.length > 50) state.turnHistory = state.turnHistory.slice(-50)
}

/** How many times the most recent turn signature has repeated consecutively. */
export function noProgressStreak(state: GuardState): number {
  const h = state.turnHistory
  if (h.length === 0) return 0
  const last = h[h.length - 1]
  let streak = 0
  for (let i = h.length - 1; i >= 0 && h[i] === last; i--) streak++
  return streak
}

/** Evaluate whether the loop should be stopped before the next turn. */
export function checkLoopGuard(state: GuardState): GuardTrip {
  if (state.stepCount >= MAX_STEPS) return { tripped: true, reason: 'max_steps' }
  if (state.tokenSpent >= TASK_TOKEN_BUDGET) return { tripped: true, reason: 'token_budget' }

  const h = state.turnHistory
  if (h.length >= MAX_REPEAT_NO_PROGRESS) {
    const last = h[h.length - 1]
    let streak = 0
    for (let i = h.length - 1; i >= 0 && h[i] === last; i--) streak++
    if (streak >= MAX_REPEAT_NO_PROGRESS) return { tripped: true, reason: 'repeat_no_progress' }
  }
  return { tripped: false }
}
