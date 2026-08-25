import { describe, expect, it, beforeEach } from 'vitest'
import {
  parseSourceKey,
  readSource,
  sameSource,
  sourceExists,
  sourceKey,
  sourceTerminalId,
  type DiffSource
} from './diffSource'
import { usePaneSnapshotStore, MAX_SNAPSHOTS } from '../store/paneSnapshotStore'

const tab: DiffSource = { kind: 'terminal', terminalId: 't1' }
const snap: DiffSource = { kind: 'snapshot', snapshotId: 's1' }

describe('sourceKey / parseSourceKey', () => {
  it('round-trips every source kind', () => {
    for (const source of [tab, snap]) {
      expect(parseSourceKey(sourceKey(source))).toEqual(source)
    }
  })

  it('maps null and empty to each other', () => {
    expect(sourceKey(null)).toBe('')
    expect(parseSourceKey('')).toBeNull()
  })

  it('rejects malformed keys rather than producing a half-built source', () => {
    expect(parseSourceKey('tab:')).toBeNull()
    expect(parseSourceKey('snap:')).toBeNull()
    expect(parseSourceKey('bogus:x')).toBeNull()
  })

  it('keeps kinds distinct even when ids collide', () => {
    const a = sourceKey({ kind: 'terminal', terminalId: 'x' })
    const b = sourceKey({ kind: 'snapshot', snapshotId: 'x' })
    expect(a).not.toBe(b)
  })
})

describe('sameSource', () => {
  it('compares by value, not reference', () => {
    expect(sameSource(tab, { kind: 'terminal', terminalId: 't1' })).toBe(true)
    expect(sameSource(tab, { kind: 'terminal', terminalId: 't2' })).toBe(false)
  })

  it('treats two nulls as different so an empty panel is not "same pane"', () => {
    expect(sameSource(null, null)).toBe(false)
  })
})

describe('sourceTerminalId', () => {
  it('returns the tab for tab sources, null for snapshots', () => {
    expect(sourceTerminalId(tab)).toBe('t1')
    expect(sourceTerminalId(snap)).toBeNull()
    expect(sourceTerminalId(null)).toBeNull()
  })
})

describe('readSource', () => {
  beforeEach(() => {
    usePaneSnapshotStore.setState({ snapshots: [] })
  })

  it('reads snapshot text', () => {
    const saved = usePaneSnapshotStore.getState().take('t1', 'before', 'line a\nline b')
    expect(saved).not.toBeNull()
    expect(readSource({ kind: 'snapshot', snapshotId: saved!.id }, 'all')).toBe('line a\nline b')
  })

  it('returns empty text instead of throwing when a source has vanished', () => {
    expect(readSource({ kind: 'snapshot', snapshotId: 'gone' }, 'all')).toBe('')
    expect(readSource(null, 'all')).toBe('')
  })

  it('ignores range for fixed text, since a snapshot has no live viewport', () => {
    const saved = usePaneSnapshotStore.getState().take('t1', 'before', 'x\ny')
    const source: DiffSource = { kind: 'snapshot', snapshotId: saved!.id }
    expect(readSource(source, 'viewport')).toBe(readSource(source, 'all'))
  })
})

describe('sourceExists', () => {
  beforeEach(() => {
    usePaneSnapshotStore.setState({ snapshots: [] })
  })

  it('tracks snapshot removal', () => {
    const saved = usePaneSnapshotStore.getState().take('t1', 'l', 'text')!
    const source: DiffSource = { kind: 'snapshot', snapshotId: saved.id }
    expect(sourceExists(source)).toBe(true)
    usePaneSnapshotStore.getState().remove(saved.id)
    expect(sourceExists(source)).toBe(false)
  })
})

describe('paneSnapshotStore', () => {
  beforeEach(() => usePaneSnapshotStore.setState({ snapshots: [] }))

  it('refuses to store a blank capture', () => {
    expect(usePaneSnapshotStore.getState().take('t1', 'l', '   \n  ')).toBeNull()
    expect(usePaneSnapshotStore.getState().snapshots).toHaveLength(0)
  })

  it('caps the list and drops the oldest', () => {
    for (let i = 0; i < MAX_SNAPSHOTS + 5; i++) {
      usePaneSnapshotStore.getState().take('t1', `snap ${i}`, `text ${i}`)
    }
    const { snapshots } = usePaneSnapshotStore.getState()
    expect(snapshots).toHaveLength(MAX_SNAPSHOTS)
    // Newest first, so the survivors are the most recent ones.
    expect(snapshots[0].label).toBe(`snap ${MAX_SNAPSHOTS + 4}`)
  })
})
