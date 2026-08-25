import type { DiffHunk, DiffLine, TextDiff } from './textDiff'

/**
 * One rendered row of a side-by-side diff. A changed block pairs its removed
 * and added lines positionally; whichever side runs out gets `undefined` so the
 * renderer can draw a filler cell.
 */
export interface SideBySideRow {
  left?: DiffLine
  right?: DiffLine
}

export interface SideBySideHunk {
  oldStart: number
  newStart: number
  rows: SideBySideRow[]
}

/**
 * Flatten a hunk's op list into left/right pairs. Context lines occupy both
 * sides of a row; a run of removes and the run of adds that follows it are
 * zipped together so a modified line lines up with its replacement.
 */
export function hunkToSideBySideRows(hunk: DiffHunk): SideBySideRow[] {
  const rows: SideBySideRow[] = []
  const { lines } = hunk
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line.op === 'context') {
      rows.push({ left: line, right: line })
      i++
      continue
    }

    const removes: DiffLine[] = []
    while (i < lines.length && lines[i].op === 'remove') removes.push(lines[i++])
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i].op === 'add') adds.push(lines[i++])

    const pairs = Math.max(removes.length, adds.length)
    for (let k = 0; k < pairs; k++) {
      rows.push({ left: removes[k], right: adds[k] })
    }
  }

  return rows
}

export function toSideBySideRows(diff: TextDiff): SideBySideHunk[] {
  return diff.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
    rows: hunkToSideBySideRows(hunk)
  }))
}

export interface NormalizeOptions {
  /** Drop trailing whitespace, which terminal padding produces constantly. */
  trimTrailing?: boolean
  /** Collapse runs of spaces so column-aligned output stops mismatching. */
  collapseSpaces?: boolean
  /** Replace timestamps, PIDs and durations with a placeholder. */
  maskVolatile?: boolean
  /** Extra masks applied after the presets; each match becomes its own token. */
  maskPatterns?: RegExp[]
}

/**
 * Values that differ on every run and every host. Without masking these, two
 * healthy machines diff as entirely different output and the feature is
 * useless. Each pattern is applied globally and replaced by a stable token.
 */
export const VOLATILE_PATTERNS: { pattern: RegExp; token: string }[] = [
  // ISO 8601, with optional fractional seconds and zone.
  {
    pattern: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    token: '<TS>'
  },
  // syslog style: `Mar  7 04:05:06`
  {
    pattern:
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b/g,
    token: '<TS>'
  },
  // Bare clock times, including `ps` style elapsed columns.
  { pattern: /\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, token: '<TIME>' },
  // Durations: `1.234s`, `250ms`, `3m12s`.
  { pattern: /\b\d+(?:\.\d+)?\s?(?:ns|us|ms|s|m|h)\b/g, token: '<DUR>' },
  // Explicit pid labels only; a bare integer is far too common to mask.
  { pattern: /\bpid[=: ]\s*\d+/gi, token: 'pid=<PID>' },
  { pattern: /\[\s*\d{2,7}\s*\]/g, token: '[<PID>]' },
  // Uptime / load-average style figures that drift between reads.
  { pattern: /\bup\s+\d+(?:\s+\w+)*,/gi, token: 'up <UPTIME>,' }
]

/**
 * Canonicalise terminal output so the diff highlights real differences. Applied
 * to both sides with the same options; the result is what gets diffed and shown,
 * so the user always sees exactly what was compared.
 */
export function normalizeForDiff(text: string, opts: NormalizeOptions = {}): string {
  const lines = text.split('\n')
  const out = lines.map((raw) => {
    let line = raw
    // Carriage returns survive from progress bars and would diff as one line.
    line = line.replace(/\r/g, '')
    if (opts.maskVolatile) {
      for (const { pattern, token } of VOLATILE_PATTERNS) {
        line = line.replace(pattern, token)
      }
    }
    if (opts.maskPatterns) {
      for (const pattern of opts.maskPatterns) {
        line = line.replace(pattern, '<MASK>')
      }
    }
    if (opts.collapseSpaces) line = line.replace(/[ \t]{2,}/g, ' ')
    if (opts.trimTrailing) line = line.replace(/[ \t]+$/, '')
    return line
  })
  return out.join('\n')
}

/** Keep the last `count` lines; a non-positive count means everything. */
export function tailLines(text: string, count: number): string {
  if (count <= 0) return text
  const lines = text.split('\n')
  return lines.length <= count ? text : lines.slice(lines.length - count).join('\n')
}
