import { describe, expect, it } from 'vitest'
import {
  countLayoutLeaves,
  layoutConnectionIds,
  parseLayout,
  serializeLayout
} from './paneLayoutSerialize'
import { collectLeaves, createLeaf, type PaneNode } from './paneLayout'
import type { SavedLayoutNode } from '../../shared/types'

let counter = 0
const nextId = (): string => `pane-${++counter}`

function split(dir: 'row' | 'col', a: PaneNode, b: PaneNode, ratio = 0.5): PaneNode {
  return { kind: 'split', id: `split-${dir}-${ratio}`, dir, ratio, a, b }
}

describe('serializeLayout', () => {
  it('records each pane connection id and drops live tab ids', () => {
    const root = split('row', createLeaf('p1', 't1'), createLeaf('p2', 't2'))
    const saved = serializeLayout(root, (terminalId) => (terminalId === 't1' ? 'conn-a' : 'conn-b'))
    expect(saved).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', connectionId: 'conn-a' },
      b: { kind: 'leaf', connectionId: 'conn-b' }
    })
    expect(JSON.stringify(saved)).not.toContain('t1')
  })

  it('leaves an unbound pane bare rather than inventing a connection', () => {
    const saved = serializeLayout(createLeaf('p1', 't1'), () => undefined)
    expect(saved).toEqual({ kind: 'leaf' })
  })

  it('keeps a pending binding that was never connected', () => {
    const root: PaneNode = { ...createLeaf('p1', null), pendingConnectionId: 'conn-x' }
    expect(serializeLayout(root, () => undefined)).toEqual({
      kind: 'leaf',
      connectionId: 'conn-x'
    })
  })

  it('clamps a ratio that would collapse a pane', () => {
    const root = split('row', createLeaf('p1', null), createLeaf('p2', null), 0.001)
    const saved = serializeLayout(root, () => undefined)
    expect(saved.kind === 'split' && saved.ratio).toBeGreaterThan(0.1)
  })
})

describe('parseLayout', () => {
  it('round-trips a tree and mints fresh pane ids', () => {
    const root = split(
      'col',
      split('row', createLeaf('p1', 't1'), createLeaf('p2', 't2'), 0.3),
      createLeaf('p3', null)
    )
    const saved = serializeLayout(root, (terminalId) => `conn-${terminalId}`)
    const parsed = parseLayout(saved, nextId)
    expect(parsed).not.toBeNull()
    const leaves = collectLeaves(parsed!)
    expect(leaves).toHaveLength(3)
    // Restored panes start empty and carry the binding, not a stale tab.
    expect(leaves.map((l) => l.terminalId)).toEqual([null, null, null])
    expect(leaves[0].pendingConnectionId).toBe('conn-t1')
    expect(leaves.every((l) => l.id.startsWith('pane-'))).toBe(true)
    expect(new Set(leaves.map((l) => l.id)).size).toBe(3)
  })

  it('preserves direction and ratio', () => {
    const parsed = parseLayout(
      { kind: 'split', dir: 'col', ratio: 0.25, a: { kind: 'leaf' }, b: { kind: 'leaf' } },
      nextId
    )
    expect(parsed?.kind).toBe('split')
    if (parsed?.kind === 'split') {
      expect(parsed.dir).toBe('col')
      expect(parsed.ratio).toBe(0.25)
    }
  })

  it('rejects junk instead of throwing', () => {
    expect(parseLayout(null, nextId)).toBeNull()
    expect(parseLayout('nope', nextId)).toBeNull()
    expect(parseLayout(42, nextId)).toBeNull()
    expect(parseLayout({ kind: 'weird' }, nextId)).toBeNull()
    expect(parseLayout({}, nextId)).toBeNull()
  })

  it('degrades a split with one broken half to its surviving child', () => {
    const parsed = parseLayout(
      { kind: 'split', dir: 'row', ratio: 0.5, a: { kind: 'leaf' }, b: 'garbage' },
      nextId
    )
    expect(parsed?.kind).toBe('leaf')
  })

  it('defaults a missing direction and ratio rather than producing NaN geometry', () => {
    const parsed = parseLayout(
      { kind: 'split', a: { kind: 'leaf' }, b: { kind: 'leaf' } },
      nextId
    )
    expect(parsed?.kind).toBe('split')
    if (parsed?.kind === 'split') {
      expect(parsed.dir).toBe('row')
      expect(Number.isFinite(parsed.ratio)).toBe(true)
    }
  })

  it('refuses a tree nested deep enough to threaten the stack', () => {
    let node: SavedLayoutNode = { kind: 'leaf' }
    for (let i = 0; i < 40; i++) {
      node = { kind: 'split', dir: 'row', ratio: 0.5, a: node, b: { kind: 'leaf' } }
    }
    const parsed = parseLayout(node, nextId)
    // The over-deep branch is dropped, but the shallow side still survives.
    expect(parsed).not.toBeNull()
    expect(collectLeaves(parsed!).length).toBeLessThan(41)
  })

  it('ignores a blank connection id', () => {
    const parsed = parseLayout({ kind: 'leaf', connectionId: '' }, nextId)
    expect(parsed?.kind === 'leaf' && parsed.pendingConnectionId).toBeUndefined()
  })
})

describe('layoutConnectionIds / countLayoutLeaves', () => {
  const saved: SavedLayoutNode = {
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    a: { kind: 'leaf', connectionId: 'a' },
    b: {
      kind: 'split',
      dir: 'col',
      ratio: 0.5,
      a: { kind: 'leaf' },
      b: { kind: 'leaf', connectionId: 'b' }
    }
  }

  it('lists bound connections in visual order', () => {
    expect(layoutConnectionIds(saved)).toEqual(['a', 'b'])
  })

  it('counts every pane, bound or not', () => {
    expect(countLayoutLeaves(saved)).toBe(3)
  })
})
