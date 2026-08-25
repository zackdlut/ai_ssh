import { describe, expect, it } from 'vitest'
import { computeTextDiff } from './textDiff'
import { normalizeForDiff, tailLines, toSideBySideRows } from './diffRows'

function rowsOf(oldText: string, newText: string): { left?: string; right?: string }[] {
  return toSideBySideRows(computeTextDiff(oldText, newText)).flatMap((hunk) =>
    hunk.rows.map((row) => ({ left: row.left?.text, right: row.right?.text }))
  )
}

describe('toSideBySideRows', () => {
  it('pairs a modified line with its replacement', () => {
    expect(rowsOf('a\nb\nc', 'a\nB\nc')).toEqual([
      { left: 'a', right: 'a' },
      { left: 'b', right: 'B' },
      { left: 'c', right: 'c' }
    ])
  })

  it('leaves the right side empty for a pure deletion', () => {
    expect(rowsOf('a\nb\nc', 'a\nc')).toEqual([
      { left: 'a', right: 'a' },
      { left: 'b', right: undefined },
      { left: 'c', right: 'c' }
    ])
  })

  it('leaves the left side empty for a pure insertion', () => {
    expect(rowsOf('a\nc', 'a\nb\nc')).toEqual([
      { left: 'a', right: 'a' },
      { left: undefined, right: 'b' },
      { left: 'c', right: 'c' }
    ])
  })

  it('zips uneven remove and add runs, then pads the shorter side', () => {
    expect(rowsOf('a\nx\ny\nz\nb', 'a\nX\nb')).toEqual([
      { left: 'a', right: 'a' },
      { left: 'x', right: 'X' },
      { left: 'y', right: undefined },
      { left: 'z', right: undefined },
      { left: 'b', right: 'b' }
    ])
  })

  it('keeps line numbers on both sides of a context row', () => {
    const hunks = toSideBySideRows(computeTextDiff('a\nb', 'a\nB'))
    const context = hunks[0].rows[0]
    expect(context.left?.oldLine).toBe(1)
    expect(context.right?.newLine).toBe(1)
    expect(hunks[0].oldStart).toBe(1)
  })

  it('produces no rows for identical input', () => {
    expect(rowsOf('same\nlines', 'same\nlines')).toEqual([])
  })

  it('produces no rows when the diff was skipped as too large', () => {
    const big = Array.from({ length: 4100 }, (_, i) => `line ${i}`).join('\n')
    const diff = computeTextDiff(big, `${big}\nextra`)
    expect(diff.skipped).toBe(true)
    expect(toSideBySideRows(diff)).toEqual([])
  })
})

describe('normalizeForDiff', () => {
  it('is a no-op without options apart from stripping carriage returns', () => {
    expect(normalizeForDiff('a  b  \r\nc')).toBe('a  b  \nc')
  })

  it('trims trailing whitespace', () => {
    expect(normalizeForDiff('a  \nb\t', { trimTrailing: true })).toBe('a\nb')
  })

  it('collapses runs of spaces but keeps single ones', () => {
    expect(normalizeForDiff('root   1234  0.0 x y', { collapseSpaces: true })).toBe(
      'root 1234 0.0 x y'
    )
  })

  it('masks ISO timestamps', () => {
    const a = normalizeForDiff('2024-03-07T04:05:06.123Z ready', { maskVolatile: true })
    const b = normalizeForDiff('2025-11-01T22:10:00Z ready', { maskVolatile: true })
    expect(a).toBe(b)
    expect(a).toBe('<TS> ready')
  })

  it('masks syslog timestamps', () => {
    expect(normalizeForDiff('Mar  7 04:05:06 host sshd: ok', { maskVolatile: true })).toBe(
      '<TS> host sshd: ok'
    )
  })

  it('masks bare clock times and durations', () => {
    expect(normalizeForDiff('took 1.234s at 04:05:06', { maskVolatile: true })).toBe(
      'took <DUR> at <TIME>'
    )
  })

  it('masks labelled pids and bracketed pids but not plain integers', () => {
    expect(normalizeForDiff('pid=4821 [ 91234 ] port 8080', { maskVolatile: true })).toBe(
      'pid=<PID> [<PID>] port 8080'
    )
  })

  it('makes two hosts with different timestamps compare equal', () => {
    const opts = { maskVolatile: true, trimTrailing: true }
    const left = 'Mar  7 04:05:06 web1 nginx: started in 1.2s   '
    const right = 'Mar 19 22:41:59 web1 nginx: started in 0.9s'
    expect(normalizeForDiff(left, opts)).toBe(normalizeForDiff(right, opts))
  })

  it('applies caller-supplied masks', () => {
    expect(normalizeForDiff('build 9f3a21c ok', { maskPatterns: [/\b[0-9a-f]{7}\b/g] })).toBe(
      'build <MASK> ok'
    )
  })

  it('preserves the line count', () => {
    const text = 'a\n\nb\n'
    expect(normalizeForDiff(text, { trimTrailing: true }).split('\n')).toHaveLength(4)
  })
})

describe('tailLines', () => {
  it('keeps the last n lines', () => {
    expect(tailLines('1\n2\n3\n4', 2)).toBe('3\n4')
  })

  it('returns everything when the text is shorter than the window', () => {
    expect(tailLines('1\n2', 5)).toBe('1\n2')
  })

  it('treats a non-positive count as unlimited', () => {
    expect(tailLines('1\n2\n3', 0)).toBe('1\n2\n3')
    expect(tailLines('1\n2\n3', -1)).toBe('1\n2\n3')
  })
})
