import { describe, expect, it } from 'vitest'
import { AI_SETTINGS_INTENT, buildAITools, toolNamesFor } from './aiTools'
import { normalizeCopilotAgentMode } from './types'

const settingsTool = (opts: Parameters<typeof buildAITools>[1]) =>
  buildAITools('full', opts).find((t) => t.function.name === 'update_app_settings')!

/** The `ai` branch of the settings tool, whichever shape it was sent in. */
const aiBranch = (opts: Parameters<typeof buildAITools>[1]) => {
  const params = settingsTool(opts).function.parameters as {
    properties: { updates: { properties: Record<string, { properties?: object }> } }
  }
  return params.properties.updates.properties.ai
}

describe('the AI-settings branch of update_app_settings', () => {
  it('carries its full field list only when the request is about AI config', () => {
    expect(aiBranch({ aiSettingsIntent: true }).properties).toBeDefined()
    expect(aiBranch({}).properties).toBeUndefined()
  })

  it('leaves a usable escape hatch when the field list is withheld', () => {
    // A withheld schema must not become a withheld capability: the field still
    // exists and says where to learn its shape, and the renderer dispatcher
    // applies `updates.ai` either way.
    const slim = aiBranch({}) as { type: string; description: string }
    expect(slim.type).toBe('object')
    expect(slim.description).toContain('get_app_settings')
  })

  it('is worth withholding', () => {
    const withAI = JSON.stringify(settingsTool({ aiSettingsIntent: true })).length
    const without = JSON.stringify(settingsTool({})).length
    // The branch was roughly a quarter of the whole tool payload. If trimming it
    // ever stops saving on the order of a thousand characters per turn, the
    // split has stopped paying for its complexity.
    expect(withAI - without).toBeGreaterThan(1500)
  })

  it('keeps one tool name across both shapes', () => {
    // The dispatcher, approval policy, result card and i18n labels all key off
    // the name, and a task must not see the tool change identity mid-flight.
    expect(toolNamesFor('full', { aiSettingsIntent: true })).toEqual(toolNamesFor('full'))
  })
})

describe('AI_SETTINGS_INTENT', () => {
  it('fires on requests that need the AI field list', () => {
    for (const req of [
      'change the copilot model to gpt-4',
      'set the ollama base url to http://localhost:11434',
      'raise the context length for the fast profile',
      'put my OpenAI api key in',
      '把模型换成 qwen2.5',
      '调大上下文长度',
      '改一下 AI 设置',
      '换个档位跑',
      'set the command timeout to 120',
      '把命令超时改成 2 小时'
    ]) {
      expect(AI_SETTINGS_INTENT.test(req), req).toBe(true)
    }
  })

  it('stays quiet on ordinary operations work', () => {
    // The terms that make a greedy version useless: `profile`, `model`, `token`
    // and `context` are everyday words in a terminal.
    for (const req of [
      'cat ~/.bash_profile',
      'restart nginx and tell me if it worked',
      'what model is this CPU?',
      'check the context switches in vmstat',
      'find the token in the auth log',
      '看一下 /etc/nginx 的配置',
      '重启 docker 服务'
    ]) {
      expect(AI_SETTINGS_INTENT.test(req), req).toBe(false)
    }
  })
})

describe('buildAITools', () => {
  it('withholds read_skill until a skill is installed', () => {
    expect(toolNamesFor('core')).not.toContain('read_skill')
    expect(toolNamesFor('core', { hasSkills: true })).toContain('read_skill')
  })

  it('keeps the app-management tools off the core tier', () => {
    for (const tool of ['update_app_settings', 'open_ssh', 'close_tabs', 'run_in_terminal']) {
      expect(toolNamesFor('core'), tool).not.toContain(tool)
      expect(toolNamesFor('full'), tool).toContain(tool)
    }
  })

  it('documents that tab_id defaults to the pinned tab', () => {
    const exec = buildAITools('core').find((t) => t.function.name === 'exec_command')
    expect(JSON.stringify(exec)).toContain('pinned tab')
  })

  it('in plan mode keeps read tools, update_plan and exec_command only', () => {
    const names = toolNamesFor('full', { planMode: true, hasSkills: true })
    expect(names).toContain('exec_command')
    expect(names).toContain('update_plan')
    expect(names).toContain('read_file')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('edit_file')
    expect(names).not.toContain('run_in_terminal')
    expect(names).not.toContain('open_ssh')
  })

  it('in execute mode drops exec_command and always includes run_in_terminal', () => {
    for (const tier of ['core', 'full'] as const) {
      const names = toolNamesFor(tier, { executeMode: true, hasSkills: true })
      expect(names, tier).not.toContain('exec_command')
      expect(names, tier).toContain('run_in_terminal')
      expect(names, tier).toContain('update_plan')
      expect(names, tier).toContain('read_file')
      expect(names, tier).toContain('edit_file')
    }
    expect(toolNamesFor('full', { executeMode: true })).toContain('open_ssh')
    expect(toolNamesFor('core', { executeMode: true })).not.toContain('open_ssh')
  })

  it('lets planMode win when both mode flags are set', () => {
    const names = toolNamesFor('full', { planMode: true, executeMode: true, hasSkills: true })
    expect(names).toContain('exec_command')
    expect(names).not.toContain('run_in_terminal')
    expect(names).not.toContain('write_file')
  })
})

describe('normalizeCopilotAgentMode', () => {
  it('keeps known modes and falls back to agent', () => {
    expect(normalizeCopilotAgentMode('plan')).toBe('plan')
    expect(normalizeCopilotAgentMode('execute')).toBe('execute')
    expect(normalizeCopilotAgentMode('agent')).toBe('agent')
    expect(normalizeCopilotAgentMode(undefined)).toBe('agent')
    expect(normalizeCopilotAgentMode('other')).toBe('agent')
  })
})
