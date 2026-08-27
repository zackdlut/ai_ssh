import { describe, expect, it } from 'vitest'
import { planRecovery, planTruncationRecovery } from './turnRecovery'

/**
 * The trajectory that produced "[Error] 500 no user query found in messages":
 * a window smaller than the one Settings carried, growth until the server
 * refuses, and what the harness does about it.
 *
 * The assertion that matters is the last one. Before this, `onError` set the
 * phase to `recovering` and then cleared the chat's busy flag, so the task was
 * simply over — mid-plan, with the user left to type "continue" and a fresh loop
 * that had lost every piece of verification evidence the previous one gathered.
 */
describe('turnRecovery', () => {
  it('recovers from an over-window rejection instead of ending the task', () => {
    const loop = { contextRecoveries: 0, transientRetries: 0, promptEstimate: 38_000 }

    // The endpoint refuses — naming a missing user message rather than the
    // overflow that removed it.
    const error = '500 no user query found in messages'
    const plan = planRecovery(loop, error)
    expect(plan).toMatchObject({ kind: 'compact', attempt: 1, waitMs: 0 })

    // And the retry is bounded: a second identical refusal means compacting was
    // not the answer, so the user hears about it instead of paying for a third.
    loop.contextRecoveries = plan.kind === 'compact' ? plan.attempt : 0
    expect(planRecovery(loop, error)).toEqual({ kind: 'none', reason: 'exhausted' })
  })

  it('retries a transient failure with backoff, twice at most', () => {
    const loop = { transientRetries: 0 }
    const error = 'Cannot reach the model endpoint (ECONNREFUSED)'

    const first = planRecovery(loop, error)
    expect(first).toMatchObject({ kind: 'backoff', attempt: 1 })
    expect(first.kind === 'backoff' && first.waitMs).toBeGreaterThan(0)
    loop.transientRetries = 1

    const second = planRecovery(loop, error)
    expect(second).toMatchObject({ kind: 'backoff', attempt: 2 })
    expect(second.kind === 'backoff' && second.waitMs).toBeGreaterThan(
      first.kind === 'backoff' ? first.waitMs : 0
    )
    loop.transientRetries = 2

    expect(planRecovery(loop, error)).toEqual({ kind: 'none', reason: 'exhausted' })
  })

  it('does not retry what a retry cannot fix', () => {
    expect(planRecovery({}, '401 Incorrect API key provided')).toEqual({
      kind: 'none',
      reason: 'fatal'
    })
    expect(planRecovery({}, '404 model "qwen3:8b" not found')).toEqual({
      kind: 'none',
      reason: 'fatal'
    })
  })

  it('answers a cut-off reply by giving the answer more room, once', () => {
    const first = planTruncationRecovery({ truncationRetries: 0 })
    expect(first.retry).toBe(true)
    expect(first.squeeze).toBeLessThan(1)
    expect(planTruncationRecovery({ truncationRetries: first.attempt }).retry).toBe(false)
  })
})
