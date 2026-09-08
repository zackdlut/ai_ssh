/**
 * Byte-level translation between a serial device and a terminal emulator.
 *
 * These live apart from `SerialManager` because they are the parts with edge
 * cases worth pinning down and no need for a port: a CRLF split across two
 * reads, a terminator the device disagrees about, an echo that has to show
 * something different from what went on the wire.
 */
import type { SerialNewline } from './deviceIdentity'

/** Bytes Enter sends, per terminator setting. */
const NEWLINE_BYTES: Record<SerialNewline, string> = {
  none: '',
  cr: '\r',
  lf: '\n',
  crlf: '\r\n'
}

export interface NormalizedOutput {
  text: string
  /**
   * Whether this chunk ended on a CR, to be passed back on the next call.
   *
   * Carrying it matters: a CRLF that straddles a read boundary would otherwise
   * have its LF treated as a bare one and be expanded again, printing a blank
   * line between every line of device output.
   */
  pendingCr: boolean
}

/**
 * Make device output renderable in a terminal.
 *
 * Firmware overwhelmingly prints a bare `\n`, which a terminal takes literally
 * as "one row down, same column" and draws as a staircase running off the right
 * edge. Bare LF is therefore expanded to CRLF, while an LF already preceded by
 * a CR is passed through so well-behaved output is not double-spaced.
 */
export function normalizeSerialOutput(text: string, pendingCr = false): NormalizedOutput {
  if (!text) return { text: '', pendingCr }

  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '\n') {
      out += ch
      continue
    }
    const prevWasCr = i === 0 ? pendingCr : text[i - 1] === '\r'
    out += prevWasCr ? '\n' : '\r\n'
  }
  return { text: out, pendingCr: text.endsWith('\r') }
}

/**
 * Translate renderer keystrokes into what the device should receive.
 *
 * xterm reports Enter as a bare CR, and that single byte is the one a serial
 * target is most likely to disagree about, so it is swapped for the session's
 * terminator. A CRLF arriving from a paste counts as one Enter, not two.
 * Everything else is passed through byte for byte, because a serial tab is
 * also how someone drives a shell over a UART header.
 */
export function serialWriteBytes(data: string, newline: SerialNewline = 'cr'): string {
  if (!data.includes('\r')) return data
  return data.replace(/\r\n?/g, NEWLINE_BYTES[newline])
}

/**
 * What local echo should draw for a keystroke.
 *
 * Serial devices do not echo, so without this a user typing into a serial tab
 * sees nothing. The echo shows the DISPLAY form rather than the wire form:
 * Enter has to return the cursor to column zero of the next row even when the
 * terminator actually sent was a lone LF, or the typed text staircases the same
 * way unnormalized device output would.
 */
export function serialEchoText(data: string): string {
  return data.replace(/\r\n?/g, '\r\n')
}
