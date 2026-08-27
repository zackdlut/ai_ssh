import { describe, expect, it } from 'vitest'
import {
  commandMatches,
  unmetPlanSteps,
  unmetStepsPrompt,
  verifyPlanStep,
  type ExecEvidence
} from './planVerify'
import type { PlanItem } from './types'

const step = (over: Partial<PlanItem> = {}): PlanItem => ({
  id: '1',
  title: '重启 nginx 服务',
  status: 'completed',
  verify: { command: 'systemctl is-active nginx' },
  ...over
})

const ran = (command: string, exitCode: number | null, output = ''): ExecEvidence => ({
  command,
  exitCode,
  output
})

describe('commandMatches', () => {
  it('accepts an equivalent spelling of the declared check', () => {
    for (const actual of [
      'systemctl is-active nginx',
      'sudo systemctl is-active nginx.service',
      'systemctl --no-pager is-active nginx',
      'systemctl is-active nginx | head -n 1'
    ]) {
      expect(commandMatches('systemctl is-active nginx', actual), actual).toBe(true)
    }
  })

  it('rejects a different command that merely shares a word', () => {
    for (const actual of ['systemctl restart nginx', 'systemctl is-active postgres', 'ps aux']) {
      expect(commandMatches('systemctl is-active nginx', actual), actual).toBe(false)
    }
  })
})

describe('verifyPlanStep', () => {
  it('reports no assertion when the step declared none', () => {
    expect(verifyPlanStep(step({ verify: undefined }), [])).toEqual({ kind: 'none' })
  })

  it('reports the check as missing until it actually runs', () => {
    expect(verifyPlanStep(step(), [ran('systemctl restart nginx', 0)])).toEqual({ kind: 'missing' })
  })

  it('passes when the check ran and exited as expected', () => {
    expect(
      verifyPlanStep(step(), [ran('systemctl restart nginx', 0), ran('systemctl is-active nginx', 0, 'active')])
    ).toEqual({ kind: 'passed' })
  })

  it('fails on the wrong exit code', () => {
    const state = verifyPlanStep(step(), [ran('systemctl is-active nginx', 3, 'inactive')])
    expect(state.kind).toBe('failed')
    if (state.kind === 'failed') expect(state.reason).toContain('exited 3')
  })

  it('honours a non-zero expected exit code', () => {
    const grep = step({
      verify: { command: 'grep -q debug /etc/app.conf', expectExitCode: 1 }
    })
    expect(verifyPlanStep(grep, [ran('grep -q debug /etc/app.conf', 1)])).toEqual({ kind: 'passed' })
    expect(verifyPlanStep(grep, [ran('grep -q debug /etc/app.conf', 0)]).kind).toBe('failed')
  })

  it('checks the output pattern as well as the exit code', () => {
    const item = step({
      verify: { command: 'systemctl is-active nginx', expectOutput: '^active' }
    })
    expect(verifyPlanStep(item, [ran('systemctl is-active nginx', 0, 'active')])).toEqual({
      kind: 'passed'
    })
    const state = verifyPlanStep(item, [ran('systemctl is-active nginx', 0, 'activating')])
    expect(state.kind).toBe('failed')
    if (state.kind === 'failed') expect(state.reason).toContain('does not match')
  })

  it('lets a re-run supersede an earlier failure', () => {
    // Fixing the problem and checking again is exactly the loop we want; being
    // held to the first attempt would make the assertion unsatisfiable.
    expect(
      verifyPlanStep(step(), [
        ran('systemctl is-active nginx', 3, 'inactive'),
        ran('systemctl is-active nginx', 0, 'active')
      ])
    ).toEqual({ kind: 'passed' })
  })

  it('does not block forever on an unparseable output pattern', () => {
    const item = step({ verify: { command: 'systemctl is-active nginx', expectOutput: '([' } })
    expect(verifyPlanStep(item, [ran('systemctl is-active nginx', 0, 'active')])).toEqual({
      kind: 'passed'
    })
  })
})

describe('unmetPlanSteps', () => {
  const plan: PlanItem[] = [
    step({ id: '1', status: 'completed' }),
    {
      id: '2',
      title: '确认端口在监听',
      status: 'pending',
      verify: { command: 'ss -ltn sport = :80' }
    },
    { id: '3', title: '向用户报告结果', status: 'pending' }
  ]

  it('flags a step claimed done whose check never ran', () => {
    const unmet = unmetPlanSteps(plan, [ran('systemctl restart nginx', 0)])
    expect(unmet).toHaveLength(1)
    expect(unmet[0].item.id).toBe('1')
    expect(unmet[0].state.kind).toBe('missing')
  })

  it('ignores steps not yet claimed, and steps with no assertion', () => {
    const unmet = unmetPlanSteps(plan, [ran('systemctl is-active nginx', 0, 'active')])
    expect(unmet).toEqual([])
  })

  it('is empty for a plan that declared no checks at all', () => {
    const bare: PlanItem[] = [{ id: '1', title: 'do the thing', status: 'completed' }]
    expect(unmetPlanSteps(bare, [])).toEqual([])
    expect(unmetPlanSteps(undefined, [])).toEqual([])
  })
})

describe('unmetStepsPrompt', () => {
  it('names the missing check so the model knows what to run', () => {
    const text = unmetStepsPrompt(unmetPlanSteps([step()], []))
    expect(text).toContain('systemctl is-active nginx')
    expect(text).toContain('has not been run')
    expect(text).toContain('update_plan')
  })

  it('states the evidence when a check ran and failed', () => {
    const text = unmetStepsPrompt(unmetPlanSteps([step()], [ran('systemctl is-active nginx', 3)]))
    expect(text).toContain('exited 3')
  })
})
