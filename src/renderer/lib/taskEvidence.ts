/**
 * Per-CHAT record of the commands a task actually ran, plus the one-shot flag
 * for the plan's verification checkpoint.
 *
 * Both used to live on `LoopState`, which outlives almost nothing: a loop ends
 * when the model gives a final answer, when the loop guard trips, when the
 * endpoint errors, and whenever the user sends anything at all. The PLAN,
 * meanwhile, lives on the chat tab and survives every one of those. That
 * mismatch produced an expensive lie. A task interrupted mid-way and resumed —
 * the user typing "continue", or an automatic recovery — came back with an
 * empty evidence list, so every assertion the previous loop had already proven
 * read as "not run"; the harness then refused to let the turn end and the model
 * spent its remaining turns re-running checks that had passed minutes earlier.
 *
 * Evidence is deliberately NOT persisted to disk. It holds kilobytes of command
 * output per step, it is only meaningful against the plan currently in flight,
 * and the chat store it would ride in is already the largest file the app
 * writes.
 */
import type { ExecEvidence } from '../../shared/planVerify'
import type { PlanItem } from '../../shared/types'

/**
 * Steps kept per chat. A plan is capped at 20 steps and each may be checked
 * more than once, so this is generous; the cap only exists so a day-long chat
 * cannot grow without bound.
 */
const MAX_ENTRIES = 120

const evidence = new Map<string, ExecEvidence[]>()
/** Plan the verification checkpoint has already been spent on, per chat. */
const checkpointed = new Map<string, string>()

export function recordTaskEvidence(chatTabId: string | undefined, entry: ExecEvidence): void {
  if (!chatTabId) return
  const list = evidence.get(chatTabId) ?? []
  list.push(entry)
  evidence.set(chatTabId, list.length > MAX_ENTRIES ? list.slice(-MAX_ENTRIES) : list)
}

export function taskEvidence(chatTabId: string | undefined): readonly ExecEvidence[] {
  if (!chatTabId) return []
  return evidence.get(chatTabId) ?? []
}

/** Drop everything remembered for a chat: its plan is gone or being replaced. */
export function clearTaskEvidence(chatTabId: string | undefined): void {
  if (!chatTabId) return
  evidence.delete(chatTabId)
  checkpointed.delete(chatTabId)
}

/**
 * What the model is claiming, reduced to the part a checkpoint is about: the
 * steps and the checks they promise. Statuses are left out on purpose — the
 * same plan progressing from step 2 to step 3 is the same set of claims, and
 * spending a fresh checkpoint on each status change is how the model ends up
 * being told the same thing three times.
 */
function planSignature(plan: readonly PlanItem[]): string {
  return plan.map((item) => `${item.title}=>${item.verify?.command ?? ''}`).join('|')
}

/**
 * Take the one verification checkpoint this plan is allowed, returning false
 * when it has already been spent.
 *
 * One shot per PLAN rather than per loop. A model that ignores the checkpoint
 * will not be convinced by a third copy of it, and a loop that cannot end is
 * worse than an unverified answer the user can read the transcript for — but
 * that argument was being applied per loop, so an interrupted task got the same
 * checkpoint again on resume. A genuinely new plan is a new set of claims and
 * gets its own.
 */
export function claimVerifyCheckpoint(
  chatTabId: string | undefined,
  plan: readonly PlanItem[]
): boolean {
  if (!chatTabId) return false
  const signature = planSignature(plan)
  if (checkpointed.get(chatTabId) === signature) return false
  checkpointed.set(chatTabId, signature)
  return true
}
