import { describe, expect, it } from 'vitest'
import { createLeaf, type PaneNode } from './paneLayout'
import { paneNumberByTerminalId, selectMentionableTerminals } from './mentionableTerminals'
import type { PaneTab } from '../store/paneLayoutStore'
import type { TerminalSession } from '../store/sessionsStore'

function session(
  id: string,
  patch: Partial<TerminalSession> = {}
): TerminalSession {
  return {
    id,
    title: id,
    status: 'connected',
    host: '10.0.0.7',
    port: 22,
    username: 'root',
    ...patch
  }
}

function paneTab(id: string, root: PaneNode): PaneTab {
  const focused = root.kind === 'leaf' ? root.id : createLeaf('unused').id
  return { id, root, focusedPaneId: focused, zoomedPaneId: null }
}

/** Left-to-right split whose leaf order is `terminalIds`. */
function rowSplit(terminalIds: (string | null)[]): PaneNode {
  const [first, ...rest] = terminalIds.map((terminalId, index) => createLeaf(`pane-${index}`, terminalId))
  if (!first) return createLeaf('pane-empty')
  return rest.reduce<PaneNode>(
    (tree, leaf, index) => ({
      kind: 'split',
      id: `split-${index + 1}`,
      dir: 'row',
      ratio: 0.5,
      a: tree,
      b: leaf
    }),
    first
  )
}

describe('paneNumberByTerminalId', () => {
  it('matches the 1-based header index on a split tab', () => {
    const tabs = [paneTab('w1', rowSplit(['a', 'b', 'c']))]
    expect([...paneNumberByTerminalId(tabs)]).toEqual([
      ['a', { paneNumber: 1, paneCount: 3 }],
      ['b', { paneNumber: 2, paneCount: 3 }],
      ['c', { paneNumber: 3, paneCount: 3 }]
    ])
  })

  it('does not number an unsplit tab', () => {
    expect(paneNumberByTerminalId([paneTab('w1', createLeaf('pane-0', 'a'))]).size).toBe(0)
  })
})

describe('selectMentionableTerminals', () => {
  it('drops idle sessions and sessions with no pane', () => {
    const tabs = [paneTab('w1', createLeaf('pane-0', 'live'))]
    expect(
      selectMentionableTerminals(
        [session('live'), session('idle', { status: 'idle' }), session('orphan')],
        tabs
      ).map((s) => s.id)
    ).toEqual(['live'])
  })

  it('walks panes in leaf order and stamps the header index', () => {
    const tabs = [paneTab('w1', rowSplit(['c', 'a', 'b']))]
    const listed = selectMentionableTerminals(
      [session('a'), session('b'), session('c')],
      tabs
    )
    expect(listed.map((s) => ({ id: s.id, paneNumber: s.paneNumber, paneCount: s.paneCount }))).toEqual([
      { id: 'c', paneNumber: 1, paneCount: 3 },
      { id: 'a', paneNumber: 2, paneCount: 3 },
      { id: 'b', paneNumber: 3, paneCount: 3 }
    ])
  })

  it('lists the active tab before the others', () => {
    const tabs = [
      paneTab('w1', createLeaf('p1', 'one')),
      paneTab('w2', createLeaf('p2', 'two'))
    ]
    expect(selectMentionableTerminals([session('one'), session('two')], tabs, 'w2').map((s) => s.id)).toEqual([
      'two',
      'one'
    ])
  })
})
