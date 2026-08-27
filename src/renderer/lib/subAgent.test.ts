import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'
import type { AIAgentTurnRequest, AIAgentTurnResult } from '../../shared/types'

vi.mock('./terminalRegistry', () => ({
  COPILOT_CONTEXT_MAX_LINES: 40,
  readTerminalOutput: () => 'last line on the host'
}))

vi.mock('./terminalObservation', () => ({
  getTabObservation: () => ({ cwd: '/srv' })
}))

vi.mock('./debugLog', () => ({ debugLog: () => {} }))

const { MAX_SUB_AGENT_STEPS, formatSubAgentResult, runSubAgent } = await import('./subAgent')

function session(id: string): TerminalSession {
  return {
    id,
    sessionId: `pty-${id}`,
    title: id,
    status: 'connected',
    host: 'prod.example.com',
    port: 22,
    username: 'root',
    kind: 'ssh'
  }
}

/** Turns the fake provider hands back, one per call, in order. */
let turns: AIAgentTurnResult[] = []
/** Every request the sub-agent sent, for asserting on prompt/tool wiring. */
let requests: AIAgentTurnRequest[] = []
let cancelled: string[] = []

function call(name: string, args: Record<string, unknown>, id = 'c1'): AIAgentTurnResult {
  return { toolCalls: [{ id, name, arguments: JSON.stringify(args) }] }
}

beforeEach(() => {
  turns = []
  requests = []
  cancelled = []
  useSessionsStore.setState({ sessions: [session('t1')], activeSessionId: 't1' })
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      ai: {
        agentTurn: (req: AIAgentTurnRequest) => {
          requests.push(req)
          return Promise.resolve(turns.shift() ?? { content: 'fallback report' })
        },
        cancel: (id: string) => cancelled.push(id)
      }
    }
  }
  ;(globalThis as unknown as { crypto: Crypto }).crypto ??= {
    randomUUID: () => `id-${requests.length}`
  } as Crypto
})

/** An executor that records what it was asked to run and always succeeds. */
function recordingExecutor(ran: { name: string; args: Record<string, unknown> }[]) {
  return async (name: string, args: Record<string, unknown>) => {
    ran.push({ name, args })
    return { ok: true, result: 'nginx is active' }
  }
}

describe('runSubAgent', () => {
  it('returns the report and the commands it ran', async () => {
    turns = [
      call('exec_command', { command: 'systemctl is-active nginx' }),
      { content: 'nginx is active on prod.' }
    ]
    const ran: { name: string; args: Record<string, unknown> }[] = []

    const outcome = await runSubAgent({
      terminalTabId: 't1',
      task: 'Is nginx running?',
      execute: recordingExecutor(ran)
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.report).toBe('nginx is active on prod.')
    expect(outcome.commands).toEqual(['systemctl is-active nginx'])
    expect(outcome.budgetExhausted).toBe(false)
    expect(ran).toEqual([
      { name: 'exec_command', args: { command: 'systemctl is-active nginx', tab_id: 't1' } }
    ])
  })

  it('starts from a private conversation seeded only with the host and the task', async () => {
    turns = [{ content: 'done' }]
    await runSubAgent({
      terminalTabId: 't1',
      task: 'Report the disk usage of /var.',
      execute: recordingExecutor([])
    })

    const first = requests[0]
    expect(first.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(first.messages[0].content).toContain('prod.example.com')
    expect(first.messages[1].content).toBe('Report the disk usage of /var.')
    // Only the read-only surface is offered, and never delegation itself.
    expect(first.toolNames).toContain('exec_command')
    expect(first.toolNames).not.toContain('delegate_to_host')
    expect(first.toolNames).not.toContain('edit_file')
  })

  it('pins every call to the delegated tab, even when the model names another', async () => {
    turns = [call('read_file', { tab_id: 'some-other-tab', path: '/etc/hosts' }), { content: 'ok' }]
    const ran: { name: string; args: Record<string, unknown> }[] = []

    await runSubAgent({ terminalTabId: 't1', task: 'read hosts', execute: recordingExecutor(ran) })

    expect(ran[0].args.tab_id).toBe('t1')
  })

  it('refuses a write tool without running it, and tells the model why', async () => {
    turns = [call('edit_file', { path: '/etc/nginx.conf' }), { content: 'could not change it' }]
    const ran: { name: string; args: Record<string, unknown> }[] = []

    const outcome = await runSubAgent({
      terminalTabId: 't1',
      task: 'fix nginx',
      execute: recordingExecutor(ran)
    })

    expect(ran).toEqual([])
    expect(outcome.ok).toBe(true)
    const refusal = requests[1].messages.find((m) => m.role === 'tool')?.content ?? ''
    expect(refusal).toContain('not available to a delegated sub-agent')
  })

  it('refuses a mutating shell command while allowing a read-only one', async () => {
    turns = [
      call('exec_command', { command: 'systemctl restart nginx' }),
      call('exec_command', { command: 'systemctl is-active nginx' }, 'c2'),
      { content: 'inactive' }
    ]
    const ran: { name: string; args: Record<string, unknown> }[] = []

    const outcome = await runSubAgent({
      terminalTabId: 't1',
      task: 'why is nginx down',
      execute: recordingExecutor(ran)
    })

    expect(ran.map((r) => r.args.command)).toEqual(['systemctl is-active nginx'])
    expect(outcome.commands).toEqual(['systemctl is-active nginx'])
    const refusal = requests[1].messages.find((m) => m.role === 'tool')?.content ?? ''
    expect(refusal).toContain('READ-ONLY')
  })

  it('reports malformed arguments back instead of executing an empty call', async () => {
    turns = [
      { toolCalls: [{ id: 'c1', name: 'exec_command', arguments: '{not json' }] },
      { content: 'gave up' }
    ]
    const ran: { name: string; args: Record<string, unknown> }[] = []

    await runSubAgent({ terminalTabId: 't1', task: 'x', execute: recordingExecutor(ran) })

    expect(ran).toEqual([])
    expect(requests[1].messages.find((m) => m.role === 'tool')?.content).toContain('Invalid JSON')
  })

  it('forces a tools-off summary turn once the step budget is spent', async () => {
    // Never stops calling on its own; the harness must end it.
    turns = Array.from({ length: MAX_SUB_AGENT_STEPS }, () =>
      call('exec_command', { command: 'ls /var/log' })
    )
    turns.push({ content: 'partial findings' })

    const outcome = await runSubAgent({
      terminalTabId: 't1',
      task: 'look around',
      execute: recordingExecutor([])
    })

    expect(requests).toHaveLength(MAX_SUB_AGENT_STEPS + 1)
    const summaryTurn = requests[MAX_SUB_AGENT_STEPS]
    expect(summaryTurn.toolNames).toEqual([])
    expect(summaryTurn.messages.at(-1)?.content).toContain('Step budget reached')
    expect(outcome.ok).toBe(true)
    expect(outcome.report).toBe('partial findings')
    expect(outcome.budgetExhausted).toBe(true)
  })

  it('fails rather than inventing a report when even the summary turn is silent', async () => {
    turns = Array.from({ length: MAX_SUB_AGENT_STEPS + 1 }, () =>
      call('exec_command', { command: 'ls' })
    )
    const outcome = await runSubAgent({
      terminalTabId: 't1',
      task: 'look around',
      execute: recordingExecutor([])
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('no report within its step budget')
    expect(outcome.budgetExhausted).toBe(true)
  })

  it('surfaces a provider error as a failed outcome', async () => {
    turns = [{ error: 'no API key configured' }]
    const outcome = await runSubAgent({
      terminalTabId: 't1',
      task: 'x',
      execute: recordingExecutor([])
    })
    expect(outcome).toMatchObject({ ok: false, error: 'no API key configured' })
  })

  it('stops on abort and cancels the child command', async () => {
    let abortSubAgent: () => void = () => {}
    const childAbort = vi.fn()
    turns = [call('exec_command', { command: 'tail -f /var/log/syslog' }), { content: 'never' }]

    const outcome = await runSubAgent({
      terminalTabId: 't1',
      task: 'x',
      onAbortHandle: (abort) => {
        abortSubAgent = abort
      },
      execute: async (_name, _args, onAbortHandle) => {
        onAbortHandle(childAbort)
        abortSubAgent()
        return { ok: false, error: 'interrupted' }
      }
    })

    expect(childAbort).toHaveBeenCalled()
    expect(outcome).toMatchObject({ ok: false, error: 'Cancelled by the user.' })
    // Only the first turn ran; nothing was sent after the user said stop.
    expect(requests).toHaveLength(1)
  })
})

describe('formatSubAgentResult', () => {
  it('names the host and keeps the report verbatim', () => {
    const text = formatSubAgentResult('root@prod', {
      ok: true,
      report: 'Port 8080 is held by java (pid 4121).',
      steps: 2,
      commands: ['ss -ltnp']
    })
    expect(text).toContain('Sub-agent report from root@prod')
    expect(text).toContain('2 step(s), 1 command(s)')
    expect(text).toContain('Port 8080 is held by java (pid 4121).')
    expect(text).not.toContain('step budget')
  })

  it('flags a budget-truncated report so the parent does not treat it as complete', () => {
    const text = formatSubAgentResult('root@prod', {
      ok: true,
      report: 'as far as I got',
      steps: 6,
      commands: [],
      budgetExhausted: true
    })
    expect(text).toContain('hit its step budget')
  })

  it('makes a missing report read as a failure, not as nothing to report', () => {
    const text = formatSubAgentResult('root@prod', {
      ok: false,
      error: 'Cancelled by the user.',
      steps: 1,
      commands: ['ss -ltnp']
    })
    expect(text).toContain('No report: Cancelled by the user.')
    expect(text).toContain('Commands attempted: ss -ltnp')
  })
})
