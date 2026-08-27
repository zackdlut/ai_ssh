import { describe, expect, it } from 'vitest'
import { buildCopilotSystemPrompt } from './copilot'
import { buildContextMessage, describeTabOs } from './terminalContext'
import { buildTranslateSystemPrompt, buildSummarizeSystemPrompt, buildSummarizeUserMessage } from './nlMode'
import { buildHistorySummarySystemPrompt, buildHistoryCompressUserMessage } from './history'
import { buildChartTurnNudge, CHART_INTENT, MERMAID_INTENT } from './chart'
import { READONLY_TOOLS, toolNamesFor } from '../aiTools'

const CORE = toolNamesFor('core')
const FULL = toolNamesFor('full')

/** Tools the core tier withholds; the prompt must not mention any of them. */
const NOT_IN_CORE = FULL.filter((n) => !CORE.includes(n))

describe('buildCopilotSystemPrompt tool gating', () => {
  it('never names a tool it was not given', () => {
    for (const names of [CORE, [] as string[]]) {
      const prompt = buildCopilotSystemPrompt({ toolNames: names })
      const leaked = FULL.filter((n) => !names.includes(n) && prompt.includes(n))
      expect(leaked, `leaked for [${names.join(',')}]`).toEqual([])
    }
  })

  it('withholds the core tier from documentation of tools it lacks', () => {
    const prompt = buildCopilotSystemPrompt({ toolNames: CORE })
    // Guard the specific tools that motivated this: the core tier previously
    // received several paragraphs of instructions for app-management tools it
    // cannot call.
    for (const tool of ['run_in_terminal', 'write_file', 'close_tabs', 'update_app_settings']) {
      expect(NOT_IN_CORE).toContain(tool)
      expect(prompt, tool).not.toContain(tool)
    }
  })

  it('still documents every core tool it does send', () => {
    const prompt = buildCopilotSystemPrompt({ toolNames: CORE })
    for (const tool of CORE) expect(prompt, tool).toContain(tool)
  })

  it('drops the whole Tool rules section when no tools are sent', () => {
    const prompt = buildCopilotSystemPrompt({ toolNames: [] })
    expect(prompt).not.toContain('## Tool rules')
    expect(prompt).not.toContain('Available tools:')
    // A toolless turn must not be told to act through tools, nor to keep quiet
    // about tool cards it will never see.
    expect(prompt).not.toContain('through tools')
    expect(prompt).not.toContain('tool card')
  })

  it('keeps the non-tool sections in every variant', () => {
    for (const names of [FULL, CORE, [] as string[]]) {
      const prompt = buildCopilotSystemPrompt({ toolNames: names })
      for (const heading of ['## Role', '## Workflow', '## Output rules', '## Constraints & safety']) {
        expect(prompt, `${heading} for [${names.length}]`).toContain(heading)
      }
    }
  })

  it('says nothing about skills when none are installed', () => {
    const withSkills = buildCopilotSystemPrompt({
      toolNames: toolNamesFor('core', { hasSkills: true })
    })
    const without = buildCopilotSystemPrompt({ toolNames: toolNamesFor('core') })
    expect(withSkills).toContain('read_skill')
    expect(withSkills).toContain('Skills:')
    // With an empty skill store the tool can load nothing, so neither its
    // schema nor the paragraphs pointing at it are worth a turn's tokens.
    expect(without).not.toContain('read_skill')
    expect(without).not.toContain('skill')
    expect(without.length).toBeLessThan(withSkills.length)
  })

  it('promises only the snapshot fields the tier can consume', () => {
    const core = buildCopilotSystemPrompt({ toolNames: CORE })
    const full = buildCopilotSystemPrompt({ toolNames: FULL })
    // Nothing on the core tier accepts a config_id or folder_id, and nothing
    // reads app settings, so the snapshot omits them — the prompt must not
    // announce context the turn will not receive.
    expect(core).toContain('tab_id')
    expect(core).not.toContain('config_id')
    expect(core).not.toContain('folder_id')
    expect(core).not.toContain('App settings line')
    expect(full).toContain('bookmark folders')
    expect(full).toContain('App settings line')
  })

  it('tells the model to default to the pinned tab', () => {
    const prompt = buildCopilotSystemPrompt({ toolNames: CORE })
    expect(prompt).toContain('Default to the tab marked pinned')
  })

  it('in execute mode documents run_in_terminal and not exec_command', () => {
    const names = toolNamesFor('full', { executeMode: true })
    const prompt = buildCopilotSystemPrompt({ toolNames: names })
    expect(names).toContain('run_in_terminal')
    expect(names).not.toContain('exec_command')
    expect(prompt).toContain('ALWAYS run_in_terminal')
    expect(prompt).not.toContain('exec_command')
    const leaked = FULL.filter((n) => !names.includes(n) && prompt.includes(n))
    expect(leaked).toEqual([])
  })

  it('tells the full tier when to reach for apply_patch instead of edit_file', () => {
    const full = buildCopilotSystemPrompt({ toolNames: FULL })
    expect(full).toContain('ONE apply_patch')
    // The core tier has no patch tool, so it must not be offered the choice.
    expect(buildCopilotSystemPrompt({ toolNames: CORE })).not.toContain('apply_patch')
  })

  it('documents the git tools only when they are sent', () => {
    const full = buildCopilotSystemPrompt({ toolNames: FULL })
    expect(full).toContain('Version control (git_read / git_commit)')
    expect(full).toContain('never needs approval')
    const noGit = buildCopilotSystemPrompt({
      toolNames: FULL.filter((n) => n !== 'git_read' && n !== 'git_commit')
    })
    expect(noGit).not.toContain('Version control')
  })

  it('shrinks as the tool set shrinks', () => {
    const full = buildCopilotSystemPrompt({ toolNames: FULL }).length
    const core = buildCopilotSystemPrompt({ toolNames: CORE }).length
    const none = buildCopilotSystemPrompt({ toolNames: [] }).length
    expect(core).toBeLessThan(full)
    expect(none).toBeLessThan(core)
  })

  it('numbers the workflow steps contiguously whichever steps are dropped', () => {
    for (const names of [FULL, CORE, [] as string[]]) {
      const workflow = buildCopilotSystemPrompt({ toolNames: names }).split('## Workflow')[1].split('\n##')[0]
      const numbers = [...workflow.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))
      expect(numbers, `for [${names.length}]`).toEqual(numbers.map((_, i) => i + 1))
    }
  })
})

describe('the Available tools inventory', () => {
  function inventory(names: readonly string[]): string {
    const line = buildCopilotSystemPrompt({ toolNames: names })
      .split('\n')
      .find((l) => l.startsWith('Available tools:'))
    return line ?? ''
  }

  it('lists exactly the tools sent, and nothing else', () => {
    const execute = toolNamesFor('full', { executeMode: true })
    for (const names of [FULL, CORE, execute]) {
      const listed = inventory(names)
        .replace(/^Available tools:\s*/, '')
        .replace(/\bplus read-only\b/, '')
        .replace(/\.$/, '')
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean)
      expect(listed.slice().sort()).toEqual(names.slice().sort())
    }
  })

  it('groups a tool as read-only only when it really is', () => {
    const readonlySide = inventory(FULL).split('plus read-only ')[1] ?? ''
    for (const name of FULL) {
      expect(readonlySide.includes(name), name).toBe(READONLY_TOOLS.has(name))
    }
  })

  it('does not call update_plan read-only — it writes the plan', () => {
    expect(READONLY_TOOLS.has('update_plan')).toBe(false)
    expect(inventory(CORE).split('plus read-only ')[1] ?? '').not.toContain('update_plan')
  })
})

describe('promises the prompt makes about injected context', () => {
  // Each field the Environment section advertises must actually be renderable,
  // so the prompt cannot promise the model something no builder ever supplies.
  const message = buildContextMessage({
    recentOutput: 'some output',
    host: 'h1',
    username: 'root',
    cwd: '/srv',
    osHint: describeTabOs('ssh')
  })

  it('renders every field the Environment section advertises', () => {
    expect(message).toBeTruthy()
    for (const label of ['Host:', 'User:', 'Working directory:', 'OS hint:', 'Recent terminal output:']) {
      expect(message, label).toContain(label)
    }
  })

  it('describes a WSL tab as having no SFTP channel', () => {
    const hint = describeTabOs('wsl', 'Ubuntu-26.04')
    expect(hint).toContain('Ubuntu-26.04')
    expect(hint).toContain('exec_command')
    expect(describeTabOs('ssh')).not.toContain('WSL')
  })

  it('returns null when there is nothing worth injecting', () => {
    expect(buildContextMessage(undefined)).toBeNull()
    expect(buildContextMessage({ recentOutput: '   ' })).toBeNull()
  })
})

describe('locale-dependent prompts', () => {
  const hasCJK = (s: string): boolean => /[\u4e00-\u9fff]/.test(s)

  it('keeps English prompts free of Chinese', () => {
    const runs = [{ command: 'uptime', output: 'up 3 days', code: 0 }]
    for (const [label, text] of [
      ['translate', buildTranslateSystemPrompt('en')],
      ['summarize', buildSummarizeSystemPrompt('en')],
      ['summarize user', buildSummarizeUserMessage('en', 'how long up?', runs)],
      ['history', buildHistorySummarySystemPrompt('en')],
      ['history user', buildHistoryCompressUserMessage('en', 'User: hi')],
      ['chart nudge', buildChartTurnNudge('en')]
    ] as const) {
      expect(hasCJK(text), label).toBe(false)
    }
  })

  it('answers in Chinese for the zh locale', () => {
    expect(hasCJK(buildSummarizeSystemPrompt('zh'))).toBe(true)
    expect(hasCJK(buildHistorySummarySystemPrompt('zh'))).toBe(true)
    expect(buildTranslateSystemPrompt('zh')).toContain('无法解析该意图')
  })

  it('reports a null exit code rather than inventing one', () => {
    const runs = [{ command: 'x', output: '', code: null }]
    expect(buildSummarizeUserMessage('en', 'q', runs)).toContain('unknown')
    expect(buildSummarizeUserMessage('zh', 'q', runs)).toContain('未知')
  })
})

describe('chart and mermaid intent', () => {
  it('routes chart phrasing to the chart renderer', () => {
    for (const s of ['把 CPU 画成实时折线图', '柱状图', 'plot cpu usage', 'chart the memory', 'line graph of load']) {
      expect(CHART_INTENT.test(s), s).toBe(true)
    }
  })

  it('routes diagram phrasing to mermaid', () => {
    for (const s of ['画个架构图', '服务拓扑图', 'sequence diagram', 'a flowchart of the deploy']) {
      expect(MERMAID_INTENT.test(s), s).toBe(true)
    }
  })

  it('does not read a bare "graph" as a live chart', () => {
    // `graph LR` opens a mermaid declaration, so a bare "graph" used to send
    // topology requests to the wrong renderer.
    expect(CHART_INTENT.test('draw a graph of the service topology')).toBe(false)
    expect(CHART_INTENT.test('graph LR')).toBe(false)
  })

  it('does not treat plain operational requests as either', () => {
    for (const s of ['restart nginx', 'show me disk usage', 'why is sshd failing']) {
      expect(CHART_INTENT.test(s), s).toBe(false)
      expect(MERMAID_INTENT.test(s), s).toBe(false)
    }
  })
})
