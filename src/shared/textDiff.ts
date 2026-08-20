/**
 * Minimal line diff used to preview `edit_file` / `write_file` before the user
 * approves them. A write the user cannot see is a write the user will not
 * enable auto-approval for, so the approval card needs a real diff — but the
 * app has no diff dependency and does not need one: an LCS over lines is a few
 * dozen lines of code and is exact for the file sizes these tools accept.
 */
export type DiffOp = 'context' | 'add' | 'remove'

export interface DiffLine {
  op: DiffOp
  /** 1-based line number in the original text (undefined for added lines). */
  oldLine?: number
  /** 1-based line number in the new text (undefined for removed lines). */
  newLine?: number
  text: string
}

export interface DiffHunk {
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface TextDiff {
  hunks: DiffHunk[]
  added: number
  removed: number
  /** True when the diff was elided because the inputs were too large. */
  skipped?: boolean
}

/** Context lines kept around each change. */
const CONTEXT_LINES = 3
/** Beyond this many lines the O(n*m) LCS table gets expensive; report stats only. */
const MAX_DIFF_LINES = 4000

function splitLines(text: string): string[] {
  if (text === '') return []
  return text.split('\n')
}

/**
 * Longest-common-subsequence backtrack producing a flat op list. Common
 * prefixes/suffixes are stripped first, which is what makes this fast enough
 * for real files: a single-line edit in a 3000-line config reduces to an LCS
 * over a handful of lines.
 */
function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  let head = 0
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  ) {
    head++
  }
  let tail = 0
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail++
  }

  const oldMid = oldLines.slice(head, oldLines.length - tail)
  const newMid = newLines.slice(head, newLines.length - tail)

  const n = oldMid.length
  const m = newMid.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        oldMid[i] === newMid[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const result: DiffLine[] = []
  for (let k = 0; k < head; k++) {
    result.push({ op: 'context', oldLine: k + 1, newLine: k + 1, text: oldLines[k] })
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) {
      result.push({
        op: 'context',
        oldLine: head + i + 1,
        newLine: head + j + 1,
        text: oldMid[i]
      })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      result.push({ op: 'remove', oldLine: head + i + 1, text: oldMid[i] })
      i++
    } else {
      result.push({ op: 'add', newLine: head + j + 1, text: newMid[j] })
      j++
    }
  }
  while (i < n) {
    result.push({ op: 'remove', oldLine: head + i + 1, text: oldMid[i] })
    i++
  }
  while (j < m) {
    result.push({ op: 'add', newLine: head + j + 1, text: newMid[j] })
    j++
  }

  for (let k = 0; k < tail; k++) {
    const oldIdx = oldLines.length - tail + k
    const newIdx = newLines.length - tail + k
    result.push({
      op: 'context',
      oldLine: oldIdx + 1,
      newLine: newIdx + 1,
      text: oldLines[oldIdx]
    })
  }

  return result
}

/** Group a flat op list into hunks with a few lines of surrounding context. */
function toHunks(lines: DiffLine[]): DiffHunk[] {
  const changed = lines
    .map((l, idx) => (l.op === 'context' ? -1 : idx))
    .filter((idx) => idx >= 0)
  if (changed.length === 0) return []

  const ranges: [number, number][] = []
  for (const idx of changed) {
    const start = Math.max(0, idx - CONTEXT_LINES)
    const end = Math.min(lines.length - 1, idx + CONTEXT_LINES)
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  }

  return ranges.map(([start, end]) => {
    const slice = lines.slice(start, end + 1)
    return {
      oldStart: slice.find((l) => l.oldLine !== undefined)?.oldLine ?? 0,
      newStart: slice.find((l) => l.newLine !== undefined)?.newLine ?? 0,
      lines: slice
    }
  })
}

export function computeTextDiff(oldText: string, newText: string): TextDiff {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return {
      hunks: [],
      added: Math.max(0, newLines.length - oldLines.length),
      removed: Math.max(0, oldLines.length - newLines.length),
      skipped: true
    }
  }

  const lines = diffLines(oldLines, newLines)
  return {
    hunks: toHunks(lines),
    added: lines.filter((l) => l.op === 'add').length,
    removed: lines.filter((l) => l.op === 'remove').length
  }
}

/** Compact `+3 -1` style summary for a tool result string. */
export function formatDiffStat(diff: TextDiff): string {
  return `+${diff.added} -${diff.removed}`
}
