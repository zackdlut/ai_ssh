import { describe, expect, it } from 'vitest'
import {
  buildPreset,
  clampSplitRatio,
  clearTerminalsFromLayout,
  clampRatio,
  collectLeaves,
  computeLayoutBoxes,
  countLeaves,
  createLeaf,
  evenRatios,
  findLeaf,
  findLeafByTerminal,
  MIN_PANE_PX,
  MIN_RATIO,
  minExtentPx,
  moveLeaf,
  nearestPaneInDirection,
  removeLeaf,
  setLeafPending,
  setLeafTerminal,
  setSplitRatio,
  splitLeaf,
  swapLeaves,
  type PaneNode,
  type PaneSplit
} from './paneLayout'

function idGen(prefix = 'n'): () => string {
  let i = 0
  return () => `${prefix}${++i}`
}

describe('computeLayoutBoxes', () => {
  it('gives a single pane the whole area and no dividers', () => {
    const boxes = computeLayoutBoxes(createLeaf('p1'))
    expect(boxes.leaves).toHaveLength(1)
    expect(boxes.leaves[0].rect).toEqual({ left: 0, top: 0, width: 100, height: 100 })
    expect(boxes.dividers).toHaveLength(0)
  })

  it('splits a row into left/right halves with a vertical divider', () => {
    const root = splitLeaf(createLeaf('p1'), 'p1', 'row', 's1', 'p2')
    const boxes = computeLayoutBoxes(root)
    const [a, b] = boxes.leaves
    expect(a.rect).toEqual({ left: 0, top: 0, width: 50, height: 100 })
    expect(b.rect).toEqual({ left: 50, top: 0, width: 50, height: 100 })
    expect(boxes.dividers).toEqual([
      {
        splitId: 's1',
        dir: 'row',
        pos: 50,
        ratio: 0.5,
        rect: { left: 0, top: 0, width: 100, height: 100 }
      }
    ])
  })

  it('splits a col into top/bottom halves with a horizontal divider', () => {
    const root = splitLeaf(createLeaf('p1'), 'p1', 'col', 's1', 'p2')
    const boxes = computeLayoutBoxes(root)
    const [a, b] = boxes.leaves
    expect(a.rect).toEqual({ left: 0, top: 0, width: 100, height: 50 })
    expect(b.rect).toEqual({ left: 0, top: 50, width: 100, height: 50 })
    expect(boxes.dividers[0].dir).toBe('col')
    expect(boxes.dividers[0].pos).toBe(50)
  })

  it('honours the ratio and keeps children flush with no gaps', () => {
    let root: PaneNode = splitLeaf(createLeaf('p1'), 'p1', 'row', 's1', 'p2')
    root = setSplitRatio(root, 's1', 0.25)
    const boxes = computeLayoutBoxes(root)
    expect(boxes.leaves[0].rect.width).toBe(25)
    expect(boxes.leaves[1].rect.left).toBe(25)
    expect(boxes.leaves[1].rect.width).toBe(75)
  })

  it('lays out a 2x2 grid in reading order', () => {
    const root = buildPreset('grid4', idGen(), ['t1', 't2', 't3', 't4'])
    const boxes = computeLayoutBoxes(root)
    expect(boxes.leaves.map((box) => box.leaf.terminalId)).toEqual(['t1', 't2', 't3', 't4'])
    expect(boxes.leaves.map((box) => [box.rect.left, box.rect.top])).toEqual([
      [0, 0],
      [50, 0],
      [0, 50],
      [50, 50]
    ])
    expect(boxes.dividers).toHaveLength(3)
  })

  it('gives a zoomed pane the whole area and hides dividers', () => {
    const root = splitLeaf(createLeaf('p1'), 'p1', 'row', 's1', 'p2')
    const boxes = computeLayoutBoxes(root, 'p2')
    expect(boxes.leaves).toHaveLength(1)
    expect(boxes.leaves[0].leaf.id).toBe('p2')
    expect(boxes.leaves[0].rect).toEqual({ left: 0, top: 0, width: 100, height: 100 })
    expect(boxes.dividers).toHaveLength(0)
  })

  it('ignores a stale zoom id', () => {
    const root = splitLeaf(createLeaf('p1'), 'p1', 'row', 's1', 'p2')
    expect(computeLayoutBoxes(root, 'gone').leaves).toHaveLength(2)
  })

  it('scopes a nested divider to its own split rect', () => {
    let root: PaneNode = splitLeaf(createLeaf('p1'), 'p1', 'row', 's1', 'p2')
    root = splitLeaf(root, 'p2', 'col', 's2', 'p3')
    const nested = computeLayoutBoxes(root).dividers.find((d) => d.splitId === 's2')!
    expect(nested.rect).toEqual({ left: 50, top: 0, width: 50, height: 100 })
    expect(nested.pos).toBe(50)
  })

  it('nests splits without overlapping rects', () => {
    let root: PaneNode = splitLeaf(createLeaf('p1'), 'p1', 'row', 's1', 'p2')
    root = splitLeaf(root, 'p2', 'col', 's2', 'p3')
    const boxes = computeLayoutBoxes(root)
    expect(boxes.leaves.map((box) => box.rect)).toEqual([
      { left: 0, top: 0, width: 50, height: 100 },
      { left: 50, top: 0, width: 50, height: 50 },
      { left: 50, top: 50, width: 50, height: 50 }
    ])
  })
})

describe('clampRatio', () => {
  it('keeps a pane from collapsing', () => {
    expect(clampRatio(0)).toBe(MIN_RATIO)
    expect(clampRatio(1)).toBe(1 - MIN_RATIO)
    expect(clampRatio(0.5)).toBe(0.5)
  })

  it('falls back to an even split for non-finite input', () => {
    expect(clampRatio(Number.NaN)).toBe(0.5)
  })
})

describe('minExtentPx', () => {
  it('charges a single pane one minimum', () => {
    expect(minExtentPx(createLeaf('p1'), 'row')).toBe(MIN_PANE_PX.row)
    expect(minExtentPx(createLeaf('p1'), 'col')).toBe(MIN_PANE_PX.col)
  })

  it('stacks children along the split axis and overlaps them across it', () => {
    const root = splitLeaf(createLeaf('p1'), 'p1', 'row', 's1', 'p2')
    expect(minExtentPx(root, 'row')).toBe(MIN_PANE_PX.row * 2)
    expect(minExtentPx(root, 'col')).toBe(MIN_PANE_PX.col)
  })

  it('accumulates through nested splits', () => {
    let root: PaneNode = buildPreset('grid4', idGen(), [])
    expect(minExtentPx(root, 'row')).toBe(MIN_PANE_PX.row * 2)
    expect(minExtentPx(root, 'col')).toBe(MIN_PANE_PX.col * 2)
    // A third column on the right raises only the width requirement.
    root = splitLeaf(root, collectLeaves(root)[1].id, 'row', 's9', 'p9')
    expect(minExtentPx(root, 'row')).toBe(MIN_PANE_PX.row * 3)
    expect(minExtentPx(root, 'col')).toBe(MIN_PANE_PX.col * 2)
  })
})

describe('clampSplitRatio', () => {
  const rowSplit = splitLeaf(createLeaf('p1'), 'p1', 'row', 's1', 'p2') as PaneSplit

  it('falls back to the fraction floor when no pixel size is known', () => {
    expect(clampSplitRatio(rowSplit, 0)).toBe(MIN_RATIO)
    expect(clampSplitRatio(rowSplit, Number.NaN)).toBe(0.5)
  })

  it('lets a pane shrink to its pixel minimum, below the fraction floor', () => {
    // 1600px wide: 168px is 10.5%, under MIN_RATIO, and should be reachable.
    const ratio = clampSplitRatio(rowSplit, 0.01, 1600)
    expect(ratio).toBeCloseTo(MIN_PANE_PX.row / 1600)
    expect(ratio).toBeLessThan(MIN_RATIO)
  })

  it('reserves room for the other side', () => {
    expect(clampSplitRatio(rowSplit, 0.99, 1600)).toBeCloseTo(1 - MIN_PANE_PX.row / 1600)
  })

  it('leaves a comfortable ratio alone', () => {
    expect(clampSplitRatio(rowSplit, 0.4, 1600)).toBe(0.4)
  })

  it('reserves room for a nested grandchild the drag cannot see', () => {
    // `b` is itself split along the same axis, so it needs two panes' worth.
    const nested = splitLeaf(rowSplit, 'p2', 'row', 's2', 'p3') as PaneSplit
    const ratio = clampSplitRatio(nested, 0.99, 900)
    expect(ratio).toBeCloseTo(1 - (MIN_PANE_PX.row * 2) / 900)
  })

  it('shares a container too small for both sides in proportion to need', () => {
    const nested = splitLeaf(rowSplit, 'p2', 'row', 's2', 'p3') as PaneSplit
    // 200px cannot host three panes; `a` needs 1 share and `b` needs 2.
    expect(clampSplitRatio(nested, 0.9, 200)).toBeCloseTo(1 / 3)
  })

  it('drives setSplitRatio when a pixel size is supplied', () => {
    const root = setSplitRatio(rowSplit, 's1', 0.01, 1600)
    const boxes = computeLayoutBoxes(root)
    expect(boxes.leaves[0].rect.width).toBeCloseTo((MIN_PANE_PX.row / 1600) * 100)
  })
})

describe('evenRatios', () => {
  it('is identity for a single pane and for an already even grid', () => {
    const leaf = createLeaf('p1')
    expect(evenRatios(leaf)).toBe(leaf)
    const grid = buildPreset('grid4', idGen(), [])
    expect(evenRatios(grid)).toBe(grid)
  })

  it('weights a lopsided tree by leaf count so panes come out equal', () => {
    // p1 | (p2 / p3): the root has to give p1 a third, not a half.
    let root: PaneNode = splitLeaf(createLeaf('p1'), 'p1', 'row', 's1', 'p2')
    root = splitLeaf(root, 'p2', 'col', 's2', 'p3')
    root = setSplitRatio(root, 's1', 0.8)
    const widths = computeLayoutBoxes(evenRatios(root)).leaves.map((box) => box.rect.width)
    expect(widths[0]).toBeCloseTo(100 / 3)
  })

  it('recentres a divider the user had dragged off centre', () => {
    let root: PaneNode = splitLeaf(createLeaf('p1'), 'p1', 'row', 's1', 'p2')
    root = setSplitRatio(root, 's1', 0.8)
    expect(computeLayoutBoxes(evenRatios(root)).leaves[0].rect.width).toBe(50)
  })
})

describe('removeLeaf', () => {
  it('promotes the sibling', () => {
    const root = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2')
    const next = removeLeaf(root, 'p1')
    expect(next).toEqual(createLeaf('p2', 't2'))
  })

  it('returns null for the last remaining pane', () => {
    expect(removeLeaf(createLeaf('p1'), 'p1')).toBeNull()
  })

  it('leaves the tree untouched for an unknown pane', () => {
    const root = splitLeaf(createLeaf('p1'), 'p1', 'row', 's1', 'p2')
    expect(removeLeaf(root, 'gone')).toBe(root)
  })

  it('collapses a nested split down to two panes', () => {
    let root: PaneNode = splitLeaf(createLeaf('p1'), 'p1', 'row', 's1', 'p2')
    root = splitLeaf(root, 'p2', 'col', 's2', 'p3')
    const next = removeLeaf(root, 'p3')!
    expect(countLeaves(next)).toBe(2)
    expect(collectLeaves(next).map((leaf) => leaf.id)).toEqual(['p1', 'p2'])
  })
})

describe('splitLeaf with before', () => {
  it('puts the new pane first when splitting toward the left', () => {
    const root = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2', true)
    // Reading order is a-then-b, so the new pane leads.
    expect(collectLeaves(root).map((leaf) => leaf.id)).toEqual(['p2', 'p1'])
    const boxes = computeLayoutBoxes(root)
    expect(boxes.leaves[0].leaf.id).toBe('p2')
    expect(boxes.leaves[0].rect.left).toBe(0)
    expect(boxes.leaves[1].rect.left).toBe(50)
  })

  it('puts the new pane above when splitting toward the top', () => {
    const root = splitLeaf(createLeaf('p1', 't1'), 'p1', 'col', 's1', 'p2', 't2', true)
    const boxes = computeLayoutBoxes(root)
    expect(boxes.leaves[0].leaf.id).toBe('p2')
    expect(boxes.leaves[0].rect.top).toBe(0)
    expect(boxes.leaves[1].rect.top).toBe(50)
  })

  it('keeps the original pane first by default', () => {
    const root = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2')
    expect(collectLeaves(root).map((leaf) => leaf.id)).toEqual(['p1', 'p2'])
  })

  it('carries the tab into the new pane on either side', () => {
    for (const before of [true, false]) {
      const root = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2', before)
      expect(findLeafByTerminal(root, 't2')?.id).toBe('p2')
      expect(findLeafByTerminal(root, 't1')?.id).toBe('p1')
    }
  })

  it('splits a nested pane without disturbing its siblings', () => {
    let root: PaneNode = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2')
    root = splitLeaf(root, 'p2', 'col', 's2', 'p3', 't3', true)
    expect(countLeaves(root)).toBe(3)
    expect(collectLeaves(root).map((leaf) => leaf.id)).toEqual(['p1', 'p3', 'p2'])
  })
})

describe('setLeafTerminal', () => {
  it('moves a tab out of its previous pane', () => {
    let root: PaneNode = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2')
    root = setLeafTerminal(root, 'p2', 't1')
    expect(findLeafByTerminal(root, 't1')?.id).toBe('p2')
    expect(collectLeaves(root).find((leaf) => leaf.id === 'p1')?.terminalId).toBeNull()
  })

  it('clears only the target pane when passed null', () => {
    const root = setLeafTerminal(
      splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2'),
      'p1',
      null
    )
    expect(collectLeaves(root).map((leaf) => leaf.terminalId)).toEqual([null, 't2'])
  })

  it('is identity when nothing changes', () => {
    const root = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2')
    expect(setLeafTerminal(root, 'p1', 't1')).toBe(root)
  })
})

describe('clearTerminalsFromLayout', () => {
  it('detaches every closed tab', () => {
    const root = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2')
    const next = clearTerminalsFromLayout(root, ['t1', 't2'])
    expect(collectLeaves(next).map((leaf) => leaf.terminalId)).toEqual([null, null])
  })

  it('is identity for an empty id list', () => {
    const root = createLeaf('p1', 't1')
    expect(clearTerminalsFromLayout(root, [])).toBe(root)
  })
})

describe('nearestPaneInDirection', () => {
  const grid = buildPreset('grid4', idGen('g'), [])
  const boxes = computeLayoutBoxes(grid)
  const [topLeft, topRight, bottomLeft] = boxes.leaves.map((box) => box.leaf.id)

  it('walks right and down across a 2x2 grid', () => {
    expect(nearestPaneInDirection(boxes, topLeft, 'right')).toBe(topRight)
    expect(nearestPaneInDirection(boxes, topLeft, 'down')).toBe(bottomLeft)
  })

  it('returns null at the edge', () => {
    expect(nearestPaneInDirection(boxes, topLeft, 'left')).toBeNull()
    expect(nearestPaneInDirection(boxes, topLeft, 'up')).toBeNull()
  })

  it('returns null for an unknown source pane', () => {
    expect(nearestPaneInDirection(boxes, 'gone', 'right')).toBeNull()
  })

  it('walks left and up back across the grid', () => {
    const bottomRight = boxes.leaves[3].leaf.id
    expect(nearestPaneInDirection(boxes, bottomRight, 'left')).toBe(bottomLeft)
    expect(nearestPaneInDirection(boxes, bottomRight, 'up')).toBe(topRight)
  })

  it('stays in its own column rather than cutting diagonally', () => {
    /*
     *  +-----+-----+   Going up from the full-width bottom pane must land in a
     *  |  a  |  b  |   pane that shares columns with it. Both qualify here, but
     *  +-----+-----+   from `b` going left there is only one aligned answer, and
     *  |     c     |   a centre-distance test alone would happily pick `c`.
     *  +-----------+
     */
    let root: PaneNode = splitLeaf(createLeaf('top'), 'top', 'col', 'sv', 'c')
    root = splitLeaf(root, 'top', 'row', 'sh', 'b')
    const local = computeLayoutBoxes(root)
    expect(local.leaves.map((box) => box.leaf.id)).toEqual(['top', 'b', 'c'])
    expect(nearestPaneInDirection(local, 'b', 'left')).toBe('top')
    expect(nearestPaneInDirection(local, 'b', 'down')).toBe('c')
    expect(nearestPaneInDirection(local, 'c', 'up')).toBe('top')
  })

  it('ignores a pane that only touches the source at a corner', () => {
    /*
     *  +-----+-----+  `wide` spans the full width on top; from `br` the pane
     *  |   wide    |  directly left is `bl`, and `wide` is up — never left.
     *  +-----+-----+
     *  | bl  | br  |
     */
    let root: PaneNode = splitLeaf(createLeaf('wide'), 'wide', 'col', 'sv', 'bl')
    root = splitLeaf(root, 'bl', 'row', 'sh', 'br')
    const local = computeLayoutBoxes(root)
    expect(nearestPaneInDirection(local, 'br', 'left')).toBe('bl')
    expect(nearestPaneInDirection(local, 'br', 'up')).toBe('wide')
    expect(nearestPaneInDirection(local, 'wide', 'up')).toBeNull()
  })
})

describe('buildPreset', () => {
  it('reuses tab ids left to right and pads with empty panes', () => {
    const root = buildPreset('cols2', idGen(), ['t1'])
    expect(collectLeaves(root).map((leaf) => leaf.terminalId)).toEqual(['t1', null])
  })

  it('collapses back to a single pane', () => {
    const root = buildPreset('single', idGen(), ['t1', 't2'])
    expect(countLeaves(root)).toBe(1)
    expect(collectLeaves(root)[0].terminalId).toBe('t1')
  })

  it('mints unique ids', () => {
    const root = buildPreset('grid4', idGen(), [])
    const ids = [
      ...collectLeaves(root).map((leaf) => leaf.id),
      ...computeLayoutBoxes(root).dividers.map((d) => d.splitId)
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('swapLeaves', () => {
  it('exchanges two leaves including their ids', () => {
    const root = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2')
    const next = swapLeaves(root, 'p1', 'p2')
    expect(collectLeaves(next).map((leaf) => leaf.id)).toEqual(['p2', 'p1'])
    expect(findLeafByTerminal(next, 't1')?.id).toBe('p1')
    expect(findLeafByTerminal(next, 't2')?.id).toBe('p2')
    expect(next.kind === 'split' && next.ratio).toBe(0.5)
  })

  it('carries a pending connection with the leaf', () => {
    let root: PaneNode = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2')
    root = setLeafPending(root, 'p2', 'conn-1')
    const next = swapLeaves(root, 'p1', 'p2')
    expect(findLeaf(next, 'p2')?.pendingConnectionId).toBe('conn-1')
    expect(findLeaf(next, 'p1')?.terminalId).toBe('t1')
    expect(collectLeaves(next).map((leaf) => leaf.id)).toEqual(['p2', 'p1'])
  })

  it('is identity when the ids match or a pane is missing', () => {
    const root = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2')
    expect(swapLeaves(root, 'p1', 'p1')).toBe(root)
    expect(swapLeaves(root, 'p1', 'gone')).toBe(root)
  })
})

describe('moveLeaf', () => {
  it('turns a row of two into a column without adding a pane', () => {
    const root = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2')
    const next = moveLeaf(root, 'p1', 'p2', 'col', 's2')
    expect(countLeaves(next)).toBe(2)
    expect(next.kind === 'split' && next.dir).toBe('col')
    expect(collectLeaves(next).map((leaf) => leaf.id)).toEqual(['p2', 'p1'])
    expect(findLeafByTerminal(next, 't1')?.id).toBe('p1')
  })

  it('inserts on the dropped-on side when before is set', () => {
    const root = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2')
    const next = moveLeaf(root, 'p2', 'p1', 'col', 's2', true)
    expect(next.kind === 'split' && next.dir).toBe('col')
    expect(collectLeaves(next).map((leaf) => leaf.id)).toEqual(['p2', 'p1'])
    expect(computeLayoutBoxes(next).leaves[0].rect.top).toBe(0)
  })

  it('promotes a nested sibling then docks beside another pane', () => {
    let root: PaneNode = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2')
    root = splitLeaf(root, 'p2', 'col', 's2', 'p3', 't3')
    const next = moveLeaf(root, 'p3', 'p1', 'row', 's3', true)
    expect(countLeaves(next)).toBe(3)
    expect(collectLeaves(next).map((leaf) => leaf.id)).toEqual(['p3', 'p1', 'p2'])
  })

  it('keeps a pending binding on the moved leaf', () => {
    let root: PaneNode = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2')
    root = setLeafPending(root, 'p2', 'conn-9')
    const next = moveLeaf(root, 'p2', 'p1', 'col', 's2', true)
    expect(findLeaf(next, 'p2')?.pendingConnectionId).toBe('conn-9')
  })

  it('is identity for a self-drop, a missing pane, or the last pane', () => {
    const pair = splitLeaf(createLeaf('p1', 't1'), 'p1', 'row', 's1', 'p2', 't2')
    expect(moveLeaf(pair, 'p1', 'p1', 'row', 's2')).toBe(pair)
    expect(moveLeaf(pair, 'p1', 'gone', 'row', 's2')).toBe(pair)
    const only = createLeaf('p1', 't1')
    expect(moveLeaf(only, 'p1', 'p1', 'row', 's2')).toBe(only)
  })
})
