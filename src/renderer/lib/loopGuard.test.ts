import { describe, expect, it } from 'vitest'
import {
  accountTokens,
  checkLoopGuard,
  createGuardState,
  MAX_REPEAT_NO_PROGRESS,
  MAX_STEPS,
  noProgressStreak,
  reconcileTokens,
  recordTurn,
  TASK_TOKEN_BUDGET,
  turnSignature
} from './loopGuard'

describe('loopGuard', () => {
  it('does not trip a fresh state', () => {
    expect(checkLoopGuard(createGuardState())).toEqual({ tripped: false })
  })

  it('trips at the step ceiling', () => {
    const state = createGuardState()
    state.stepCount = MAX_STEPS - 1
    expect(checkLoopGuard(state).tripped).toBe(false)
    state.stepCount = MAX_STEPS
    expect(checkLoopGuard(state)).toEqual({ tripped: true, reason: 'max_steps' })
  })

  it('trips on the task token budget', () => {
    const state = createGuardState()
    state.tokenSpent = TASK_TOKEN_BUDGET
    expect(checkLoopGuard(state)).toEqual({ tripped: true, reason: 'token_budget' })
  })

  it('trips only after the same turn repeats consecutively', () => {
    const state = createGuardState()
    const same = turnSignature([{ name: 'exec_command', args: '{"command":"ls"}', result: 'a b c' }])
    for (let i = 0; i < MAX_REPEAT_NO_PROGRESS - 1; i++) recordTurn(state, same)
    expect(checkLoopGuard(state).tripped).toBe(false)
    recordTurn(state, same)
    expect(checkLoopGuard(state)).toEqual({ tripped: true, reason: 'repeat_no_progress' })
  })

  it('does not count a repeat when the result changed', () => {
    const state = createGuardState()
    const args = '{"command":"systemctl status nginx"}'
    recordTurn(state, turnSignature([{ name: 'exec_command', args, result: 'inactive' }]))
    recordTurn(state, turnSignature([{ name: 'exec_command', args, result: 'active' }]))
    recordTurn(state, turnSignature([{ name: 'exec_command', args, result: 'active' }]))
    expect(noProgressStreak(state)).toBe(2)
    expect(checkLoopGuard(state).tripped).toBe(false)
  })

  it('treats argument key order as irrelevant to the signature', () => {
    const a = turnSignature([{ name: 'exec_command', args: '{"tab_id":"t1","command":"ls"}', result: 'x' }])
    const b = turnSignature([{ name: 'exec_command', args: '{"command":"ls","tab_id":"t1"}', result: 'x' }])
    expect(a).toBe(b)
  })

  it('replaces a turn estimate with the provider count instead of double-charging', () => {
    const state = createGuardState()
    accountTokens(state, ['hello world'])
    const estimated = state.tokenSpent
    expect(estimated).toBeGreaterThan(0)

    reconcileTokens(state, 500)
    expect(state.tokenSpent).toBe(500)

    // A second turn is charged on top of the reconciled total.
    accountTokens(state, ['another turn'])
    expect(state.tokenSpent).toBeGreaterThan(500)
  })

  it('keeps the estimate when the provider reports no usage', () => {
    const state = createGuardState()
    accountTokens(state, ['some prompt text'])
    const estimated = state.tokenSpent
    reconcileTokens(state, 0)
    expect(state.tokenSpent).toBe(estimated)
  })
})
