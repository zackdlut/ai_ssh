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

/**
 * Apply a regex to a line and return the captured group parsed as a number, or
 * null when there is no match or the captured text is not numeric.
 */
export function extractValue(line: string, regex: RegExp, group = 1): number | null {
  const m = regex.exec(line)
  if (!m) return null
  const raw = m[group]
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}
