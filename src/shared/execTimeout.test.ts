import { describe, expect, it } from 'vitest'
import { nextExecDeadline } from './execTimeout'

describe('nextExecDeadline', () => {
  it('returns the stall window while the absolute ceiling is far away', () => {
    expect(nextExecDeadline(0, 120_000, 3_600_000, 0)).toBe(120_000)
    expect(nextExecDeadline(0, 120_000, 3_600_000, 100_000)).toBe(120_000)
  })

  it('shrinks to the remaining absolute ceiling near the cap', () => {
    expect(nextExecDeadline(0, 120_000, 3_600_000, 3_550_000)).toBe(50_000)
    expect(nextExecDeadline(0, 120_000, 3_600_000, 3_600_000)).toBe(0)
  })

  it('uses only the absolute ceiling when stall is unset', () => {
    expect(nextExecDeadline(0, 0, 3_600_000, 0)).toBe(3_600_000)
    expect(nextExecDeadline(0, 0, 3_600_000, 3_000_000)).toBe(600_000)
  })
})
