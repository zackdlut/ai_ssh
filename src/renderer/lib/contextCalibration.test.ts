import { beforeEach, describe, expect, it } from 'vitest'
import {
  calibrationKey,
  calibratedWindow,
  effectiveContextLimit,
  MIN_CALIBRATED_WINDOW,
  noteContextRejection,
  observeUsage,
  resetContextCalibration
} from './contextCalibration'
import { planRecovery, planTruncationRecovery } from './turnRecovery'

const KEY = calibrationKey('default', 'qwen3:8b', 'http://127.0.0.1:11434/v1')
/** What Settings claimed, from the model's advertised window. */
const CONFIGURED = 128_000
/** What the server was actually serving, fitted to the GPU. */
const REAL = 32_768

function feed(usage: { prompt: number; completion: number }, estimatedPrompt = usage.prompt) {
  return observeUsage({
    key: KEY,
    configured: CONFIGURED,
    estimatedPrompt,
    usage: { ...usage, total: usage.prompt + usage.completion }
  })
}

describe('contextCalibration', () => {
  beforeEach(resetContextCalibration)

  it('leaves the configured window alone while nothing is wrong', () => {
    // Healthy turns: the total moves freely and generation is not being squeezed.
    expect(feed({ prompt: 13_178, completion: 194 })).toBeUndefined()
    expect(feed({ prompt: 15_656, completion: 1268 })).toBeUndefined()
    expect(feed({ prompt: 21_004, completion: 7006 })).toBeUndefined()
    expect(effectiveContextLimit(KEY, CONFIGURED)).toBe(CONFIGURED)
  })

  it('does not mistake a repeated turn for a clamped total', () => {
    // Same prompt twice (the loop repeating itself) produces near-identical
    // totals without the server capping anything.
    expect(feed({ prompt: 20_000, completion: 40 })).toBeUndefined()
    expect(feed({ prompt: 20_000, completion: 40 })).toBeUndefined()
    expect(calibratedWindow(KEY)).toBeUndefined()
  })

  it('learns the real window from totals pinned at a ceiling', () => {
    // The trajectory from the failed task: the prompt keeps growing but the
    // reported total stops moving and the model is left a handful of tokens.
    expect(feed({ prompt: 32_439, completion: 311 })).toBeUndefined()
    const learned = feed({ prompt: 32_705, completion: 61 })
    expect(learned).toEqual({ window: REAL, reason: 'ceiling' })
    expect(effectiveContextLimit(KEY, CONFIGURED)).toBe(REAL)
  })

  it('reports the same discovery once, not on every turn after it', () => {
    feed({ prompt: 32_439, completion: 311 })
    expect(feed({ prompt: 32_705, completion: 61 })).toBeTruthy()
    expect(feed({ prompt: 32_614, completion: 154 })).toBeUndefined()
    expect(feed({ prompt: 32_763, completion: 5 })).toBeUndefined()
  })

  it('learns from a single truncated prompt, without waiting for a second turn', () => {
    // The server charged for far less than we handed it, and what it charged
    // for lands on a window a server is actually configured with.
    const learned = feed({ prompt: 32_400, completion: 300 }, 41_000)
    expect(learned).toEqual({ window: REAL, reason: 'truncated' })
  })

  it("does not read the estimator's own error as truncation", () => {
    // 8% over on a prose-heavy turn is the heuristic being a heuristic.
    expect(feed({ prompt: 20_000, completion: 900 }, 21_600)).toBeUndefined()
    // Even a large gap is not enough on its own: 20.9k is not a window anyone
    // configures, so this is our estimate being wrong, not the server truncating.
    expect(feed({ prompt: 20_000, completion: 900 }, 27_000)).toBeUndefined()
  })

  it('is scoped to the endpoint, so another server starts clean', () => {
    feed({ prompt: 32_439, completion: 311 })
    feed({ prompt: 32_705, completion: 61 })
    const other = calibrationKey('default', 'qwen3:8b', 'https://api.example.com/v1')
    expect(effectiveContextLimit(other, CONFIGURED)).toBe(CONFIGURED)
  })

  it('cuts below the refused prompt when the endpoint rejects the request', () => {
    const learned = noteContextRejection(KEY, CONFIGURED, 38_000)
    expect(learned.reason).toBe('rejected')
    expect(learned.window).toBeLessThan(38_000)
    expect(effectiveContextLimit(KEY, CONFIGURED)).toBe(learned.window)
  })

  it('never calibrates below what the loop needs to run', () => {
    const learned = noteContextRejection(KEY, 8000, 1000)
    expect(learned.window).toBe(MIN_CALIBRATED_WINDOW)
  })
})

/**
 * The trajectory that produced "[Error] 500 no user query found in messages",
 * end to end: a window four times its real size, growth until the server
 * refuses, and what the harness does about it.
 *
 * The assertion that matters is the last one. Before this, `onError` set the
 * phase to `recovering` and then cleared the chat's busy flag, so the task was
 * simply over — mid-plan, with the user left to type "continue" and a fresh loop
 * that had lost every piece of verification evidence the previous one gathered.
 */
describe('context pressure trajectory', () => {
  beforeEach(resetContextCalibration)

  it('recovers from an over-window rejection instead of ending the task', () => {
    const loop = { contextRecoveries: 0, transientRetries: 0, promptEstimate: 38_000 }

    // Nineteen turns of growth against a limit that was never real: usage is
    // healthy right up to the wall, so nothing warns us on the way there.
    expect(feed({ prompt: 13_178, completion: 194 })).toBeUndefined()
    expect(feed({ prompt: 26_403, completion: 1268 })).toBeUndefined()
    expect(effectiveContextLimit(KEY, CONFIGURED)).toBe(CONFIGURED)

    // Then the endpoint refuses — naming a missing user message rather than the
    // overflow that removed it.
    const error = '500 no user query found in messages'
    const plan = planRecovery(loop, error)
    expect(plan).toMatchObject({ kind: 'compact', attempt: 1, waitMs: 0 })

    // The refusal is filed against the endpoint, so the retry and every later
    // task budget against something below the prompt that was refused.
    const learned = noteContextRejection(KEY, CONFIGURED, loop.promptEstimate)
    expect(learned.window).toBeLessThan(loop.promptEstimate)
    expect(effectiveContextLimit(KEY, CONFIGURED)).toBe(learned.window)

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
