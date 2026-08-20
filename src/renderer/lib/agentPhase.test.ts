import { describe, expect, it } from 'vitest'
import { transition, type AgentEvent, type AgentPhase } from './agentPhase'

describe('agentPhase.transition', () => {
  it('walks a plain read-execute-answer task through the full cycle', () => {
    const events: AgentEvent[] = ['prompt', 'toolCalls', 'toolExecuted', 'observed', 'continue', 'finalAnswer']
    const phases = events.reduce<AgentPhase[]>(
      (acc, event) => [...acc, transition(acc[acc.length - 1], event)],
      ['idle']
    )
    expect(phases).toEqual([
      'idle',
      'thinking',
      'acting',
      'observing',
      'verifying',
      'thinking',
      'done'
    ])
  })

  it('parks in awaitingUser until the user decides', () => {
    const waiting = transition('acting', 'needApproval')
    expect(waiting).toBe('awaitingUser')
    expect(transition(waiting, 'approved')).toBe('acting')
    // A rejection is not a failure: the loop goes back to the model to replan.
    expect(transition(waiting, 'rejected')).toBe('thinking')
  })

  it('treats a guard trip and an unrecoverable error as terminal failures', () => {
    expect(transition('acting', 'guardTripped')).toBe('failed')
    expect(transition('recovering', 'unrecoverable')).toBe('failed')
  })

  it('routes a recoverable error through recovering and back', () => {
    expect(transition('acting', 'recover')).toBe('recovering')
    expect(transition('recovering', 'recovered')).toBe('thinking')
  })

  it('keeps the current phase for events that do not apply to it', () => {
    // A stray event must never corrupt the phase; the caller decides what to do.
    expect(transition('done', 'nonsense' as AgentEvent)).toBe('done')
  })
})
