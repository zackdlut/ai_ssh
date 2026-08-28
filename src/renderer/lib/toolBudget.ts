/**
 * Character budget for a single tool result.
 *
 * The loop is the only place that knows the live context window and what the
 * rest of the payload costs, but the tools are where output is produced. A tool
 * that can page — `read_file` — should stop at this budget and report an
 * accurate continuation offset, which loses nothing; the loop applies the same
 * bound as a blunt head/tail cut for tools that cannot, which does.
 *
 * This used to be one module-level value that the loop wrote before each turn.
 * That was defensible while turns were effectively serial — a stale value from
 * another tab cost at most one extra page. It stops being defensible once
 * sub-agents investigate several hosts at once, because each of those carries a
 * much smaller budget of its own: with a shared slot, whichever turn started
 * most recently silently decides how much every other one's `read_file`
 * returns. So the budget now travels with the call, and this default applies
 * only to a caller that supplies none.
 */
export const DEFAULT_TOOL_RESULT_CHARS = 4000

/** Resolve a caller-supplied budget, falling back to the default. */
export function toolResultCharBudget(requested?: number): number {
  if (requested !== undefined && Number.isFinite(requested) && requested > 0) {
    return Math.floor(requested)
  }
  return DEFAULT_TOOL_RESULT_CHARS
}
