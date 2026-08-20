import { describe, expect, it } from 'vitest'
import { verifyCommand } from './verify'

describe('verifyCommand', () => {
  it('trusts a zero exit code', () => {
    expect(verifyCommand('done', 0)).toMatchObject({ status: 'success', retryable: false })
  })

  it('flags a zero exit whose output still mentions a failure, without failing it', () => {
    // `chmod -R` on a tree with one unreadable entry is the classic case: the
    // command succeeded overall but part of the work did not happen.
    const verdict = verifyCommand('chmod: /root/x: Permission denied', 0)
    expect(verdict.status).toBe('success')
    expect(verdict.category).toBe('permission')
    expect(verdict.hint).toMatch(/partial failure/)
  })

  it('classifies a permission failure as not retryable', () => {
    const verdict = verifyCommand('bash: /etc/shadow: Permission denied', 1)
    expect(verdict).toMatchObject({ status: 'failed', category: 'permission', retryable: false })
  })

  it('classifies network and timeout failures as retryable', () => {
    expect(verifyCommand('curl: (7) Connection refused', 7)).toMatchObject({
      status: 'failed',
      category: 'network',
      retryable: true
    })
    expect(verifyCommand('operation timed out', 124)).toMatchObject({
      status: 'failed',
      category: 'timeout',
      retryable: true
    })
  })

  it('reads exit 127 as a missing command even with empty output', () => {
    expect(verifyCommand('', 127)).toMatchObject({
      status: 'failed',
      category: 'not_found',
      retryable: false
    })
  })

  it('reports unknown when there is neither an exit code nor a known pattern', () => {
    expect(verifyCommand('some output', null)).toMatchObject({ status: 'unknown', retryable: false })
  })

  it('does not mark an ambiguous non-zero exit retryable', () => {
    // `grep` exits 1 for "no match", which is not an error to retry blindly.
    expect(verifyCommand('', 1)).toMatchObject({ status: 'failed', retryable: false })
  })
})
