import { beforeEach, describe, expect, it } from 'vitest'
import {
  claimVerifyCheckpoint,
  clearTaskEvidence,
  recordTaskEvidence,
  taskEvidence
} from './taskEvidence'
import { unmetPlanSteps } from '../../shared/planVerify'
import type { PlanItem } from '../../shared/types'

const CHAT = 'chat-1'

const plan: PlanItem[] = [
  {
    id: 'step-1',
    title: 'Restart nginx',
    status: 'completed',
    verify: { command: 'systemctl is-active nginx', expectOutput: 'active' }
  }
]

function runTheCheck(): void {
  recordTaskEvidence(CHAT, {
    command: 'systemctl is-active nginx.service',
    exitCode: 0,
    output: 'active'
  })
}

describe('taskEvidence', () => {
  beforeEach(() => clearTaskEvidence(CHAT))

  it('keeps a proven step proven after the loop that proved it is gone', () => {
    runTheCheck()
    expect(unmetPlanSteps(plan, taskEvidence(CHAT))).toEqual([])

    // The loop ends — an endpoint error, the guard tripping, or the user typing
    // "continue" — and a brand new one asks the same question. Evidence used to
    // live on the loop, so this is where the step went back to looking unrun and
    // the model was told to re-verify work it had already done.
    expect(unmetPlanSteps(plan, taskEvidence(CHAT))).toEqual([])
  })

  it('still reports a step whose check never ran', () => {
    const unmet = unmetPlanSteps(plan, taskEvidence(CHAT))
    expect(unmet).toHaveLength(1)
    expect(unmet[0].state.kind).toBe('missing')
  })

  it('does not leak one chat evidence into another', () => {
    runTheCheck()
    expect(taskEvidence('chat-2')).toEqual([])
    clearTaskEvidence('chat-2')
  })

  it('spends the verification checkpoint once per plan, not once per loop', () => {
    expect(claimVerifyCheckpoint(CHAT, plan)).toBe(true)
    // Same plan, new loop: the model has already been told once, and telling it
    // again is how a task spends its remaining turns on the same message.
    expect(claimVerifyCheckpoint(CHAT, plan)).toBe(false)

    // Progress within the plan is not a new set of claims either.
    const progressed: PlanItem[] = [{ ...plan[0], status: 'in_progress' }]
    expect(claimVerifyCheckpoint(CHAT, progressed)).toBe(false)
  })

  it('gives a genuinely new plan its own checkpoint', () => {
    expect(claimVerifyCheckpoint(CHAT, plan)).toBe(true)
    const other: PlanItem[] = [
      {
        id: 'step-1',
        title: 'Rotate the log',
        status: 'completed',
        verify: { command: 'ls -l /var/log' }
      }
    ]
    expect(claimVerifyCheckpoint(CHAT, other)).toBe(true)
  })

  it('drops everything for a chat that starts over', () => {
    runTheCheck()
    claimVerifyCheckpoint(CHAT, plan)
    clearTaskEvidence(CHAT)
    expect(taskEvidence(CHAT)).toEqual([])
    expect(claimVerifyCheckpoint(CHAT, plan)).toBe(true)
  })

  it('bounds what one chat can accumulate', () => {
    for (let i = 0; i < 400; i++) {
      recordTaskEvidence(CHAT, { command: `echo ${i}`, exitCode: 0, output: '' })
    }
    const kept = taskEvidence(CHAT)
    expect(kept.length).toBeLessThanOrEqual(120)
    // The cap drops the oldest: the most recent run of a check is the one that
    // decides whether a step passed.
    expect(kept[kept.length - 1].command).toBe('echo 399')
  })
})
