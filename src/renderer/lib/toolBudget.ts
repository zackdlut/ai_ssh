/**
 * Character budget for a single tool result, published by the agent loop.
 *
 * The loop is the only place that knows the live context window and what the
 * rest of the payload costs, but the tools are where output is produced. A tool
 * that can page — `read_file` — should stop at this budget and report an
 * accurate continuation offset, which loses nothing; the loop applies the same
 * bound as a blunt head/tail cut for tools that cannot, which does.
 *
 * Deliberately a single value rather than per-tab: it only steers how a tool
 * sizes its own output, and the loop's cap remains the actual invariant, so a
 * stale value from another tab's turn costs at most one extra page.
 */
const DEFAULT_RESULT_CHARS = 4000

let resultCharBudget = DEFAULT_RESULT_CHARS

export function setToolResultCharBudget(chars: number): void {
  if (Number.isFinite(chars) && chars > 0) resultCharBudget = Math.floor(chars)
}

export function toolResultCharBudget(): number {
  return resultCharBudget
}
