import { describe, expect, it } from 'vitest'
import { hostMemoryCandidates, isHostMemoryPath } from './hostMemory'

describe('hostMemoryCandidates', () => {
  it('looks in the connecting user home, matching @path expansion', () => {
    expect(hostMemoryCandidates('root')).toEqual(['/root/AGENTS.md', '/root/.ai-terminal.md'])
    expect(hostMemoryCandidates('deploy')).toEqual([
      '/home/deploy/AGENTS.md',
      '/home/deploy/.ai-terminal.md'
    ])
  })

  it('falls back to ~ when the username is unknown', () => {
    expect(hostMemoryCandidates(undefined)[0]).toBe('~/AGENTS.md')
  })
})

describe('isHostMemoryPath', () => {
  it('recognizes a memory file wherever it sits', () => {
    expect(isHostMemoryPath('/root/AGENTS.md')).toBe(true)
    expect(isHostMemoryPath('/srv/app/.ai-terminal.md')).toBe(true)
  })

  it('does not fire on a file that merely resembles one', () => {
    // The cache is keyed on the host, so a false positive here would silently
    // re-read AGENTS.md after every unrelated markdown edit.
    expect(isHostMemoryPath('/root/README.md')).toBe(false)
    expect(isHostMemoryPath('/root/AGENTS.md.bak.1700000000000')).toBe(false)
    expect(isHostMemoryPath('/etc/agents.md')).toBe(false)
  })
})
