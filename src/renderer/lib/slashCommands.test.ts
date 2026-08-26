import { describe, expect, it } from 'vitest'
import { filterSlashCommands, parseSlashCommand, slashMenuPrefix } from './slashCommands'

describe('parseSlashCommand', () => {
  it('parses the local commands', () => {
    expect(parseSlashCommand('/plan')).toEqual({ kind: 'command', name: 'plan', arg: '' })
    expect(parseSlashCommand('/agent')).toEqual({ kind: 'command', name: 'agent', arg: '' })
    expect(parseSlashCommand('/execute')).toEqual({ kind: 'command', name: 'execute', arg: '' })
    expect(parseSlashCommand('/compact')).toEqual({ kind: 'command', name: 'compact', arg: '' })
    expect(parseSlashCommand('/skill nginx')).toEqual({
      kind: 'command',
      name: 'skill',
      arg: 'nginx'
    })
  })

  it('does not steal ordinary prompts', () => {
    expect(parseSlashCommand('restart nginx')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
    expect(parseSlashCommand('/plan\nstill typing')).toBeNull()
  })

  it('reports unknown tokens', () => {
    expect(parseSlashCommand('/foo')).toEqual({ kind: 'unknown', token: 'foo' })
  })
})

describe('slashMenuPrefix', () => {
  it('is the typed token until arguments start', () => {
    expect(slashMenuPrefix('/')).toBe('')
    expect(slashMenuPrefix('/pl')).toBe('pl')
    expect(slashMenuPrefix('/skill nginx')).toBeNull()
    expect(slashMenuPrefix('plan')).toBeNull()
  })
})

describe('filterSlashCommands', () => {
  it('filters by prefix', () => {
    expect(filterSlashCommands('').map((c) => c.name)).toEqual([
      'plan',
      'agent',
      'execute',
      'compact',
      'skill'
    ])
    expect(filterSlashCommands('pl').map((c) => c.name)).toEqual(['plan'])
    expect(filterSlashCommands('ex').map((c) => c.name)).toEqual(['execute'])
    expect(filterSlashCommands('xyz')).toEqual([])
  })
})
