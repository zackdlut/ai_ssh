import { describe, expect, it } from 'vitest'
import { normalizeSerialOutput, serialEchoText, serialWriteBytes } from './serialStream'

/** Feed text through in chunks, the way the port emits it. */
function stream(chunks: string[]): string {
  let pendingCr = false
  let out = ''
  for (const chunk of chunks) {
    const res = normalizeSerialOutput(chunk, pendingCr)
    out += res.text
    pendingCr = res.pendingCr
  }
  return out
}

describe('normalizeSerialOutput', () => {
  it('expands the bare LF firmware prints, so output does not staircase', () => {
    expect(normalizeSerialOutput('boot\nready\n').text).toBe('boot\r\nready\r\n')
  })

  it('leaves an LF that already follows a CR alone', () => {
    expect(normalizeSerialOutput('boot\r\nready\r\n').text).toBe('boot\r\nready\r\n')
  })

  it('does not double-space a CRLF split across two reads', () => {
    expect(stream(['boot\r', '\nready'])).toBe('boot\r\nready')
  })

  it('still expands a bare LF that opens a chunk', () => {
    expect(stream(['boot', '\nready'])).toBe('boot\r\nready')
  })

  it('handles a lone CR, as a progress line rewriting itself would send', () => {
    expect(normalizeSerialOutput('50%\r').text).toBe('50%\r')
    expect(stream(['50%\r', '100%\r'])).toBe('50%\r100%\r')
  })

  it('reports pendingCr only for a trailing CR', () => {
    expect(normalizeSerialOutput('a\r').pendingCr).toBe(true)
    expect(normalizeSerialOutput('a\r\n').pendingCr).toBe(false)
    expect(normalizeSerialOutput('a').pendingCr).toBe(false)
  })

  it('carries pendingCr through an empty chunk', () => {
    expect(stream(['boot\r', '', '\nready'])).toBe('boot\r\nready')
  })

  it('passes ANSI escapes through, since a Pi console and ESP-IDF both color', () => {
    const colored = '\x1b[32mI (123) wifi: connected\x1b[0m\n'
    expect(normalizeSerialOutput(colored).text).toBe(
      '\x1b[32mI (123) wifi: connected\x1b[0m\r\n'
    )
  })

  it('leaves mixed CRLF and bare LF each handled on its own', () => {
    expect(normalizeSerialOutput('a\r\nb\nc').text).toBe('a\r\nb\r\nc')
  })
})

describe('serialWriteBytes', () => {
  it('replaces the CR xterm sends for Enter with the configured terminator', () => {
    expect(serialWriteBytes('\r', 'cr')).toBe('\r')
    expect(serialWriteBytes('\r', 'lf')).toBe('\n')
    expect(serialWriteBytes('\r', 'crlf')).toBe('\r\n')
    expect(serialWriteBytes('\r', 'none')).toBe('')
  })

  it('defaults to CR, which is what a real terminal sends', () => {
    expect(serialWriteBytes('\r')).toBe('\r')
  })

  it('passes ordinary characters through untouched', () => {
    expect(serialWriteBytes('AT+GMR', 'crlf')).toBe('AT+GMR')
  })

  it('translates the whole line a paste submits', () => {
    expect(serialWriteBytes('AT+GMR\r', 'crlf')).toBe('AT+GMR\r\n')
  })

  it('counts a pasted CRLF as one Enter rather than two', () => {
    expect(serialWriteBytes('a\r\nb', 'lf')).toBe('a\nb')
  })

  it('keeps control keys intact, so Ctrl+C still reaches a UART shell', () => {
    expect(serialWriteBytes('\x03', 'lf')).toBe('\x03')
  })
})

describe('serialEchoText', () => {
  it('echoes Enter as CRLF even when the wire terminator was a lone LF', () => {
    expect(serialEchoText('\r')).toBe('\r\n')
  })

  it('echoes typed characters as-is', () => {
    expect(serialEchoText('ls -al')).toBe('ls -al')
  })
})
