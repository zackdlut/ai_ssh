/**
 * Retrieval over a terminal's scrollback.
 *
 * The copilot used to see the terminal only as the last N lines pasted into
 * every turn, so "what was that error an hour ago" had exactly one remedy:
 * raise N. That pays for the whole window on every turn of every task to answer
 * a question asked once, and it still truncates — the answer is usually a dozen
 * lines somewhere in five thousand.
 *
 * So the snippet stays small and the rest of the buffer becomes searchable: the
 * model asks for a pattern and gets back the matching regions with their line
 * numbers, which it can then widen. Pure text in, text out, so it is testable
 * without a terminal.
 */
export interface ScrollbackBlock {
  /** 1-based line number of the first line in this block (1 = oldest kept). */
  startLine: number
  /** Line numbers of the lines that actually matched, for the model to cite. */
  matchLines: number[]
  lines: string[]
}

export interface ScrollbackSearchOptions {
  /** Extended-regex source, as the model wrote it. */
  pattern: string
  /** Lines of context kept on each side of a match. */
  contextLines?: number
  /** How many matching regions to return, newest first in the buffer order. */
  maxMatches?: number
  /** Case-insensitive matching (default true: log levels vary in case). */
  ignoreCase?: boolean
  /** Hard cap on the returned text, so one greedy pattern cannot fill a window. */
  maxChars?: number
}

export interface ScrollbackSearchResult {
  blocks: ScrollbackBlock[]
  /** Lines that matched in the whole buffer, even if not all are returned. */
  totalMatches: number
  /** Lines the buffer held, so the model can tell how far back it can see. */
  scannedLines: number
  /** Matching regions dropped to respect maxMatches / maxChars. */
  droppedBlocks: number
  /** Set when the pattern is not a usable regex; blocks is then empty. */
  patternError?: string
}

export const DEFAULT_CONTEXT_LINES = 3
export const MAX_CONTEXT_LINES = 20
export const DEFAULT_MAX_MATCHES = 6
export const MAX_MAX_MATCHES = 30
export const DEFAULT_MAX_CHARS = 6000

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * Find the regions of `buffer` that match `pattern`.
 *
 * Overlapping context windows are merged into one block, so a burst of matching
 * lines reads as the passage it is rather than as N copies of the same region.
 * When more matches survive than the caller allows, the NEWEST are kept: the
 * end of a terminal buffer is where the state that still matters lives, and the
 * count of what was dropped tells the model to narrow the pattern instead of
 * assuming it saw everything.
 */
export function searchScrollback(
  buffer: string,
  options: ScrollbackSearchOptions
): ScrollbackSearchResult {
  const lines = buffer.split('\n')
  const scannedLines = buffer.trim() ? lines.length : 0
  const contextLines = clamp(options.contextLines, DEFAULT_CONTEXT_LINES, 0, MAX_CONTEXT_LINES)
  const maxMatches = clamp(options.maxMatches, DEFAULT_MAX_MATCHES, 1, MAX_MAX_MATCHES)
  const maxChars = clamp(options.maxChars, DEFAULT_MAX_CHARS, 500, 200000)

  let re: RegExp
  try {
    re = new RegExp(options.pattern, options.ignoreCase === false ? '' : 'i')
  } catch (e) {
    return {
      blocks: [],
      totalMatches: 0,
      scannedLines,
      droppedBlocks: 0,
      patternError: e instanceof Error ? e.message : String(e)
    }
  }

  const hits: number[] = []
  for (let i = 0; i < scannedLines; i++) {
    if (re.test(lines[i])) hits.push(i)
  }
  if (hits.length === 0) {
    return { blocks: [], totalMatches: 0, scannedLines, droppedBlocks: 0 }
  }

  // Merge each hit's context window into blocks.
  const merged: { start: number; end: number; matchLines: number[] }[] = []
  for (const hit of hits) {
    const start = Math.max(0, hit - contextLines)
    const end = Math.min(scannedLines - 1, hit + contextLines)
    const last = merged[merged.length - 1]
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end)
      last.matchLines.push(hit + 1)
      continue
    }
    merged.push({ start, end, matchLines: [hit + 1] })
  }

  let kept = merged.slice(-maxMatches)
  let dropped = merged.length - kept.length

  // Char budget: drop from the OLD end, for the same reason maxMatches does.
  const blockChars = (b: { start: number; end: number }): number =>
    lines.slice(b.start, b.end + 1).reduce((sum, l) => sum + l.length + 1, 0)
  let total = kept.reduce((sum, b) => sum + blockChars(b), 0)
  while (kept.length > 1 && total > maxChars) {
    total -= blockChars(kept[0])
    kept = kept.slice(1)
    dropped += 1
  }

  return {
    blocks: kept.map((b) => ({
      startLine: b.start + 1,
      matchLines: b.matchLines,
      lines: lines.slice(b.start, b.end + 1)
    })),
    totalMatches: hits.length,
    scannedLines,
    droppedBlocks: dropped
  }
}

/**
 * Render a result for the model: numbered lines so it can quote a location, and
 * a header that states how far back the buffer goes and what was left out. The
 * honesty matters more than the brevity — a model that thinks it searched the
 * whole session will conclude an error never happened.
 */
export function formatScrollbackResult(
  result: ScrollbackSearchResult,
  meta: { pattern: string; label?: string }
): string {
  const where = meta.label ? ` on ${meta.label}` : ''
  if (result.patternError) {
    return `Invalid pattern /${meta.pattern}/: ${result.patternError}. Re-send a valid extended regular expression.`
  }
  if (result.scannedLines === 0) {
    return `Scrollback${where} is empty; nothing has been captured for this session yet.`
  }
  const head = `Searched ${result.scannedLines} lines of scrollback${where} for /${meta.pattern}/ (line 1 is the oldest line still retained; older output is gone).`
  if (result.blocks.length === 0) {
    return `${head}\nNo match. The pattern may be too specific, or the output predates the retained buffer.`
  }
  const note =
    result.droppedBlocks > 0
      ? `\n${result.totalMatches} matching line(s) in ${
          result.blocks.length + result.droppedBlocks
        } region(s); the ${result.droppedBlocks} oldest region(s) are omitted — narrow the pattern or raise max_matches to see them.`
      : `\n${result.totalMatches} matching line(s) in ${result.blocks.length} region(s).`
  const body = result.blocks
    .map((block) => {
      const rendered = block.lines
        .map((line, i) => `${block.startLine + i} | ${line}`)
        .join('\n')
      return `--- around line ${block.matchLines.join(', ')} ---\n${rendered}`
    })
    .join('\n')
  return `${head}${note}\n${body}`
}
