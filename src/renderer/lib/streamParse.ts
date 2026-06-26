/**
 * Shared helpers for parsing terminal output streams: ANSI stripping, splitting
 * an arbitrarily-chunked stream into complete lines, and extracting a numeric
 * value from a line via a regex.
 */

/** Strip ANSI escape / control sequences from captured terminal output. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

/**
 * Accumulates raw stream chunks and emits complete lines (split on \n),
 * retaining any trailing partial line until more data arrives.
 */
export interface LineSplitter {
  push: (chunk: string, onLine: (line: string) => void) => void
}

export function createLineSplitter(): LineSplitter {
  let buffer = ''
  return {
    push(chunk, onLine) {
      buffer += chunk
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        onLine(line)
      }
      // Guard against an unbounded buffer if a line never terminates.
      if (buffer.length > 100000) buffer = buffer.slice(-50000)
    }
  }
}

const SIZE_SUFFIX: Record<string, number> = {
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
  e: 1024 ** 6
}

/**
 * Parse a possibly human-readable numeric token into a plain number. Handles:
 *   - plain numbers and percentages ("42", "73%")
 *   - thousands separators ("1,234")
 *   - byte-size suffixes from `du -h` / `df -h` / `free -h` ("3.0M", "1.2G", "512K")
 * Uses a 1024 base so mixed-unit outputs compare correctly. Returns null when
 * the token has no leading number.
 */
export function parseHumanNumber(raw: string): number | null {
  if (raw == null) return null
  const s = String(raw).trim().replace(/,/g, '')
  if (!s) return null
  const direct = Number(s)
  if (Number.isFinite(direct)) return direct
  const m = /^([+-]?\d*\.?\d+)\s*([a-zA-Z%]*)$/.exec(s)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const unit = m[2].toLowerCase()
  if (!unit || unit === '%' || unit === 'b') return n
  const mult = SIZE_SUFFIX[unit[0]]
  return mult ? n * mult : n
}

/**
 * Apply a regex to a line and return the captured group parsed as a number, or
 * null when there is no match or the captured text is not numeric. Understands
 * human-readable size suffixes (see {@link parseHumanNumber}).
 */
export function extractValue(line: string, regex: RegExp, group = 1): number | null {
  const m = regex.exec(line)
  if (!m) return null
  const raw = m[group]
  if (raw === undefined) return null
  return parseHumanNumber(raw)
}
