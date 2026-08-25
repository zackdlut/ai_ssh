import { describe, expect, it, beforeEach } from 'vitest'
import { describeSource, readSource, sourceExists, type DiffSource } from './diffSource'
import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'

const tab: DiffSource = { kind: 'terminal', terminalId: 't1' }

function session(id: string): TerminalSession {
  return { id, title: id, status: 'idle', host: '', port: 22, username: '' }
}

beforeEach(() => {
  useSessionsStore.setState({ sessions: [] })
})

describe('readSource', () => {
  it('returns empty text instead of throwing when a source has vanished', () => {
    expect(readSource({ kind: 'terminal', terminalId: 'gone' }, 'all')).toBe('')
    expect(readSource(null, 'all')).toBe('')
  })
})

describe('sourceExists', () => {
  it('tracks whether the terminal is still in the session list', () => {
    expect(sourceExists(tab)).toBe(false)
    useSessionsStore.setState({ sessions: [session('t1')] })
    expect(sourceExists(tab)).toBe(true)
  })
})

describe('describeSource', () => {
  it('falls back when the terminal is unknown', () => {
    expect(describeSource(null, 'none')).toBe('none')
    expect(describeSource(tab, 'none')).toBe('t1')
  })
})
