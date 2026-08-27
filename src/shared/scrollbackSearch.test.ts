import { describe, expect, it } from 'vitest'
import { formatScrollbackResult, searchScrollback } from './scrollbackSearch'

/** n numbered filler lines, so a match's position in the buffer is obvious. */
function filler(count: number, from = 1): string[] {
  return Array.from({ length: count }, (_, i) => `line ${from + i}`)
}

describe('searchScrollback', () => {
  it('returns the match with context and 1-based line numbers', () => {
    const buffer = [...filler(5), 'nginx: [emerg] bind() failed', ...filler(5, 6)].join('\n')
    const result = searchScrollback(buffer, { pattern: 'emerg', contextLines: 2 })

    expect(result.totalMatches).toBe(1)
    expect(result.scannedLines).toBe(11)
    expect(result.droppedBlocks).toBe(0)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].matchLines).toEqual([6])
    expect(result.blocks[0].startLine).toBe(4)
    expect(result.blocks[0].lines).toEqual([
      'line 4',
      'line 5',
      'nginx: [emerg] bind() failed',
      'line 6',
      'line 7'
    ])
  })

  it('merges adjacent matches into one block instead of repeating the region', () => {
    const buffer = ['a', 'error one', 'b', 'error two', 'c'].join('\n')
    const result = searchScrollback(buffer, { pattern: 'error', contextLines: 1 })

    expect(result.totalMatches).toBe(2)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].matchLines).toEqual([2, 4])
  })

  it('is case-insensitive by default and exact when asked', () => {
    const buffer = 'Connection REFUSED'
    expect(searchScrollback(buffer, { pattern: 'refused' }).totalMatches).toBe(1)
    expect(
      searchScrollback(buffer, { pattern: 'refused', ignoreCase: false }).totalMatches
    ).toBe(0)
  })

  it('keeps the newest regions when there are more than max_matches', () => {
    // Ten isolated matches, far enough apart that none merge.
    const buffer = Array.from({ length: 10 }, (_, i) =>
      [`fail ${i}`, ...filler(10)].join('\n')
    ).join('\n')
    const result = searchScrollback(buffer, { pattern: '^fail', maxMatches: 3, contextLines: 1 })

    expect(result.totalMatches).toBe(10)
    expect(result.blocks).toHaveLength(3)
    expect(result.droppedBlocks).toBe(7)
    // Newest kept: the last three "fail" lines, not the first three.
    expect(result.blocks.map((b) => b.lines.find((l) => l.startsWith('fail')))).toEqual([
      'fail 7',
      'fail 8',
      'fail 9'
    ])
  })

  it('drops the oldest regions to respect the char budget', () => {
    const buffer = Array.from({ length: 4 }, (_, i) =>
      [`fail ${i} ${'x'.repeat(400)}`, ...filler(10)].join('\n')
    ).join('\n')
    const result = searchScrollback(buffer, {
      pattern: '^fail',
      contextLines: 0,
      maxChars: 900
    })

    expect(result.blocks.length).toBeLessThan(4)
    expect(result.droppedBlocks).toBe(4 - result.blocks.length)
    // Whatever survives is the tail of the buffer.
    expect(result.blocks.at(-1)?.lines[0]).toContain('fail 3')
  })

  it('always keeps one region even when it alone exceeds the char budget', () => {
    // Truncating the only answer to nothing would read as "no match".
    const result = searchScrollback(`fail ${'x'.repeat(5000)}`, {
      pattern: 'fail',
      maxChars: 500
    })
    expect(result.blocks).toHaveLength(1)
  })

  it('reports a bad pattern instead of throwing', () => {
    const result = searchScrollback('anything', { pattern: '[unclosed' })
    expect(result.patternError).toBeTruthy()
    expect(result.blocks).toEqual([])
  })

  it('scans nothing for an empty buffer', () => {
    expect(searchScrollback('   \n  ', { pattern: 'x' })).toMatchObject({
      scannedLines: 0,
      totalMatches: 0,
      blocks: []
    })
  })
})

describe('formatScrollbackResult', () => {
  const meta = { pattern: 'emerg', label: 'root@prod' }

  it('numbers the lines and states how far back the buffer goes', () => {
    const buffer = [...filler(3), 'nginx: [emerg] bind() failed', ...filler(3, 4)].join('\n')
    const text = formatScrollbackResult(searchScrollback(buffer, { pattern: 'emerg' }), meta)

    expect(text).toContain('Searched 7 lines of scrollback on root@prod for /emerg/')
    expect(text).toContain('oldest line still retained')
    expect(text).toContain('--- around line 4 ---')
    expect(text).toContain('4 | nginx: [emerg] bind() failed')
  })

  it('says the pattern missed rather than implying the event never happened', () => {
    const text = formatScrollbackResult(searchScrollback('all quiet', { pattern: 'emerg' }), meta)
    expect(text).toContain('No match')
    expect(text).toContain('predates the retained buffer')
  })

  it('admits when regions were omitted, so a partial view is not read as complete', () => {
    const buffer = Array.from({ length: 5 }, (_, i) =>
      [`emerg ${i}`, ...filler(10)].join('\n')
    ).join('\n')
    const text = formatScrollbackResult(
      searchScrollback(buffer, { pattern: 'emerg', maxMatches: 2, contextLines: 0 }),
      meta
    )
    expect(text).toContain('3 oldest region(s) are omitted')
    expect(text).toContain('raise max_matches')
  })

  it('reports an empty buffer as empty, not as a failed search', () => {
    expect(formatScrollbackResult(searchScrollback('', { pattern: 'emerg' }), meta)).toContain(
      'is empty'
    )
  })

  it('names the invalid pattern back to the model', () => {
    const text = formatScrollbackResult(searchScrollback('x', { pattern: '[' }), {
      pattern: '['
    })
    expect(text).toContain('Invalid pattern /[/')
  })
})
