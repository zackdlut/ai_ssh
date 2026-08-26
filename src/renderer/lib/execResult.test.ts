import { describe, expect, it } from 'vitest'
import { isEmptyExecOutput, parsedExitCode, parseExecToolResult } from './execResult'

describe('parseExecToolResult', () => {
  it('splits header fields out of the output body', () => {
    const parsed = parseExecToolResult(
      ['status: success', 'exit_code: 0', 'cwd: /home/zackzh', 'wait: 0s', 'output:', 'hello', 'world'].join(
        '\n'
      )
    )
    expect(parsed).toEqual({
      status: 'success',
      exitCode: '0',
      cwd: '/home/zackzh',
      wait: '0s',
      output: 'hello\nworld',
      structured: true
    })
  })

  it('does not leave the output: label in the body', () => {
    const parsed = parseExecToolResult('status: failed\nexit_code: 1\noutput:\nboom')
    expect(parsed.output).toBe('boom')
    expect(parsed.output).not.toMatch(/^output:/)
    expect(parsed.status).toBe('failed')
    expect(parsed.exitCode).toBe('1')
  })

  it('keeps optional verify and note with the header', () => {
    const parsed = parseExecToolResult(
      [
        'status: failed',
        'exit_code: 127',
        'verify: Command not found (exit 127)',
        'note: the command hit its execution timeout',
        'output:',
        '(no output captured)'
      ].join('\n')
    )
    expect(parsed.verify).toMatch(/Command not found/)
    expect(parsed.note).toMatch(/timeout/)
    expect(parsed.output).toBe('(no output captured)')
    expect(parsed.structured).toBe(true)
  })

  it('treats unstructured results as raw output', () => {
    const parsed = parseExecToolResult('just some grep hits\nstatus: not a header')
    expect(parsed).toEqual({ output: 'just some grep hits\nstatus: not a header', structured: false })
  })
})

describe('isEmptyExecOutput', () => {
  it('treats the capture placeholder as empty', () => {
    expect(isEmptyExecOutput('')).toBe(true)
    expect(isEmptyExecOutput('  \n')).toBe(true)
    expect(isEmptyExecOutput('(no output captured)')).toBe(true)
    expect(isEmptyExecOutput('ok')).toBe(false)
  })
})

describe('parsedExitCode', () => {
  it('parses numeric codes and maps unknown to null', () => {
    expect(parsedExitCode('0')).toBe(0)
    expect(parsedExitCode('127')).toBe(127)
    expect(parsedExitCode('unknown')).toBeNull()
    expect(parsedExitCode(undefined)).toBeNull()
  })
})
