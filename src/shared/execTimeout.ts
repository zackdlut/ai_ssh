/**
 * Shared stall + absolute-ceiling deadline for captured commands (Execute PTY)
 * and the Agent's dedicated SSH exec channel.
 *
 * `stallMs` is "how long with no output before we give up". Arriving data
 * postpones that window. `absoluteMaxMs` is the wall-clock ceiling from start,
 * even if the command keeps printing.
 */

/** Ms until the next stall/absolute deadline. 0 means the ceiling is already due. */
export function nextExecDeadline(
  startedAt: number,
  stallMs: number,
  absoluteMaxMs: number,
  now = Date.now()
): number {
  const remainingAbs =
    absoluteMaxMs > 0 ? absoluteMaxMs - (now - startedAt) : Number.POSITIVE_INFINITY
  if (remainingAbs <= 0) return 0
  if (stallMs > 0) return Math.min(stallMs, remainingAbs)
  return Number.isFinite(remainingAbs) ? remainingAbs : 0
}
