/**
 * Parse the structured exec_command / run_in_terminal result string.
 *
 * The tool result fed to the model starts with a header (status, exit_code,
 * cwd, wait, optional verify/note) then `output:` and the captured stdout.
 * The UI splits those so the code block shows only the command output.
 */

const HEADER_KEY_RE = /^(status|exit_code|cwd|wait|verify|note):\s*(.*)$/
const EMPTY_OUTPUT_MARKERS = new Set(['', '(no output captured)'])

export interface ParsedExecResult {
  status?: string
  exitCode?: string
  cwd?: string
  wait?: string
  verify?: string
  note?: string
  output: string
  /** True when the result used the structured header format. */
  structured: boolean
}

export function parseExecToolResult(result: string): ParsedExecResult {
  const text = result.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  if (lines.length === 0) return { output: text, structured: false }

  const header: Omit<ParsedExecResult, 'output' | 'structured'> = {}
  let i = 0
  let sawHeader = false

  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line === 'output:') {
      sawHeader = true
      i += 1
      break
    }
    const match = HEADER_KEY_RE.exec(line)
    if (!match) {
      if (!sawHeader) return { output: text, structured: false }
      break
    }
    sawHeader = true
    const [, key, value] = match
    if (key === 'status') header.status = value
    else if (key === 'exit_code') header.exitCode = value
    else if (key === 'cwd') header.cwd = value
    else if (key === 'wait') header.wait = value
    else if (key === 'verify') header.verify = value
    else if (key === 'note') header.note = value
  }

  if (!sawHeader) return { output: text, structured: false }

  return {
    ...header,
    output: lines.slice(i).join('\n'),
    structured: true
  }
}

export function isEmptyExecOutput(output: string): boolean {
  return EMPTY_OUTPUT_MARKERS.has(output.trim())
}

export function parsedExitCode(raw?: string): number | null {
  if (raw == null || raw === '' || raw === 'unknown') return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}
