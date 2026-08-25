/**
 * Pure geometry for the split-pane terminal grid.
 *
 * The layout is a binary tree: every split owns two children and a ratio, so a
 * divider drag is a single number change and no measurement pass is needed.
 * Rects come out as percentages of the terminal area, which is what lets the
 * xterm hosts stay absolutely positioned siblings that never move in the DOM —
 * re-parenting a live xterm instance breaks it.
 */
export type SplitDir = 'row' | 'col'

export interface PaneLeaf {
  kind: 'leaf'
  id: string
  /** Terminal tab shown in this pane, or null for an empty pane. */
  terminalId: string | null
  /**
   * Saved connection this pane is waiting to be filled by, set when a stored
   * layout is restored. Restoring never dials on its own, so this is what the
   * empty pane offers a "connect" button for.
   */
  pendingConnectionId?: string
}

export interface PaneSplit {
  kind: 'split'
  id: string
  /** `row` lays children out left/right, `col` top/bottom. */
  dir: SplitDir
  /** Fraction of the split axis given to child `a`. */
  ratio: number
  a: PaneNode
  b: PaneNode
}

export type PaneNode = PaneLeaf | PaneSplit

/** Percentages of the containing terminal area. */
export interface PaneRect {
  left: number
  top: number
  width: number
  height: number
}

export interface PaneBox {
  leaf: PaneLeaf
  rect: PaneRect
}

export interface PaneDivider {
  splitId: string
  dir: SplitDir
  /** Boundary offset along the split axis, in percent of the container. */
  pos: number
  /** The split's own rect, which maps a pixel drag back onto the ratio. */
  rect: PaneRect
  /** Current ratio, for keyboard nudges and `aria-valuenow`. */
  ratio: number
}

export interface PaneLayoutBoxes {
  leaves: PaneBox[]
  dividers: PaneDivider[]
}

export type LayoutPreset = 'single' | 'cols2' | 'rows2' | 'grid4'

export const FULL_RECT: PaneRect = { left: 0, top: 0, width: 100, height: 100 }

/** Inline style for an absolutely positioned element covering a pane rect. */
export function paneRectStyle(rect: PaneRect): {
  left: string
  top: string
  width: string
  height: string
} {
  return {
    left: `${rect.left}%`,
    top: `${rect.top}%`,
    width: `${rect.width}%`,
    height: `${rect.height}%`
  }
}

/**
 * Fallback floor for a ratio set without knowing the container size. The real
 * constraint is `MIN_PANE_PX`; this only covers callers that have no pixels to
 * work with, such as parsing a stored layout.
 */
export const MIN_RATIO = 0.12

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio))
}

/**
 * Smallest pane that is still worth showing, per axis, in CSS pixels.
 *
 * A split pane spends a fixed amount of its box on chrome — `--pane-header-h`
 * plus the host padding in `global.css` — so anything under these leaves the
 * xterm host with zero usable rows or columns. Sized to keep roughly three rows
 * and twenty columns alive.
 */
export const MIN_PANE_PX: Record<SplitDir, number> = { row: 168, col: 92 }

/**
 * Panes in one tab. Only the tab on screen renders, and each of its panes draws
 * from a real GPU context; browsers cap those (commonly 16) and silently drop
 * the oldest once past it, which blanks a terminal that is still connected. So
 * this is the ceiling the GPU actually sees.
 */
export const MAX_PANES_PER_TAB = 12

/**
 * Panes across every tab. Background tabs stay mounted — that is what makes
 * switching instant — so each one keeps an xterm buffer and an `ssh:data`
 * subscription alive regardless of whether it is visible. Nothing about the GPU
 * bounds this, only memory, hence the much looser figure.
 */
export const MAX_PANES_TOTAL = 40

/**
 * Pixels `node` needs along `axis` before some pane inside it goes unusable.
 * A split along the same axis stacks its children's needs; across it they
 * overlap, so the larger of the two wins.
 */
export function minExtentPx(node: PaneNode, axis: SplitDir): number {
  if (node.kind === 'leaf') return MIN_PANE_PX[axis]
  return node.dir === axis
    ? minExtentPx(node.a, axis) + minExtentPx(node.b, axis)
    : Math.max(minExtentPx(node.a, axis), minExtentPx(node.b, axis))
}

/**
 * Clamp a ratio against what the split's subtrees actually need in pixels.
 *
 * `axisPx` is the split's own extent along its axis. Without it there is no way
 * to convert a pixel floor into a fraction, so the coarse `MIN_RATIO` stands in.
 * Nested splits are accounted for, which is what stops a drag on an outer
 * divider from crushing a grandchild it cannot see.
 */
export function clampSplitRatio(split: PaneSplit, ratio: number, axisPx?: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  if (axisPx === undefined || !Number.isFinite(axisPx) || axisPx <= 0) return clampRatio(ratio)
  const minA = minExtentPx(split.a, split.dir) / axisPx
  const minB = minExtentPx(split.b, split.dir) / axisPx
  // Container too small to satisfy both sides: share it out in proportion to
  // need instead of letting one side win and pinning the other at zero.
  if (minA + minB >= 1) return minA / (minA + minB)
  return Math.min(1 - minB, Math.max(minA, ratio))
}

/**
 * Last-resort bound for a ratio read straight out of the tree. Deliberately
 * looser than `clampRatio`: every write path already clamps, and re-applying
 * `MIN_RATIO` here would stop a drag from ever reaching the pixel floor.
 */
function boundRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(0.999, Math.max(0.001, ratio))
}

export function createLeaf(id: string, terminalId: string | null = null): PaneLeaf {
  return { kind: 'leaf', id, terminalId }
}

export function collectLeaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === 'leaf') return [node]
  return [...collectLeaves(node.a), ...collectLeaves(node.b)]
}

export function countLeaves(node: PaneNode): number {
  return node.kind === 'leaf' ? 1 : countLeaves(node.a) + countLeaves(node.b)
}

export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | undefined {
  return collectLeaves(node).find((leaf) => leaf.id === paneId)
}

export function findLeafByTerminal(node: PaneNode, terminalId: string): PaneLeaf | undefined {
  return collectLeaves(node).find((leaf) => leaf.terminalId === terminalId)
}

function walk(node: PaneNode, rect: PaneRect, out: PaneLayoutBoxes): void {
  if (node.kind === 'leaf') {
    out.leaves.push({ leaf: node, rect })
    return
  }
  const ratio = boundRatio(node.ratio)
  if (node.dir === 'row') {
    const aWidth = rect.width * ratio
    walk(node.a, { ...rect, width: aWidth }, out)
    walk(node.b, { ...rect, left: rect.left + aWidth, width: rect.width - aWidth }, out)
    out.dividers.push({ splitId: node.id, dir: 'row', pos: rect.left + aWidth, rect, ratio })
  } else {
    const aHeight = rect.height * ratio
    walk(node.a, { ...rect, height: aHeight }, out)
    walk(node.b, { ...rect, top: rect.top + aHeight, height: rect.height - aHeight }, out)
    out.dividers.push({ splitId: node.id, dir: 'col', pos: rect.top + aHeight, rect, ratio })
  }
}

/**
 * Resolve every pane to a percentage rect. A zoomed pane takes the whole area
 * and suppresses dividers, matching tmux's zoom.
 */
export function computeLayoutBoxes(
  root: PaneNode,
  zoomedPaneId?: string | null
): PaneLayoutBoxes {
  if (zoomedPaneId) {
    const zoomed = findLeaf(root, zoomedPaneId)
    if (zoomed) return { leaves: [{ leaf: zoomed, rect: FULL_RECT }], dividers: [] }
  }
  const out: PaneLayoutBoxes = { leaves: [], dividers: [] }
  walk(root, FULL_RECT, out)
  return out
}

/**
 * Place an existing leaf beside `targetId`. Used when a pane is dropped on an
 * edge: the dragged leaf keeps its id and pending binding instead of being
 * minted again.
 *
 * `before` puts the inserted pane in the `a` slot, which is what a drop on a
 * pane's left or top edge means: it appears on the side that was dropped on.
 */
export function insertLeaf(
  root: PaneNode,
  targetId: string,
  dir: SplitDir,
  splitId: string,
  leaf: PaneLeaf,
  before = false
): PaneNode {
  const replace = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      if (node.id !== targetId) return node
      return {
        kind: 'split',
        id: splitId,
        dir,
        ratio: 0.5,
        a: before ? leaf : node,
        b: before ? node : leaf
      }
    }
    const a = replace(node.a)
    const b = replace(node.b)
    return a === node.a && b === node.b ? node : { ...node, a, b }
  }
  return replace(root)
}

/**
 * Replace `paneId` with a split holding the original pane plus a new one.
 *
 * `before` puts the new pane in the `a` slot, which is what a drop on a pane's
 * left or top edge means: the new pane appears on the side that was dropped on.
 */
export function splitLeaf(
  root: PaneNode,
  paneId: string,
  dir: SplitDir,
  splitId: string,
  newPaneId: string,
  newTerminalId: string | null = null,
  before = false
): PaneNode {
  return insertLeaf(root, paneId, dir, splitId, createLeaf(newPaneId, newTerminalId), before)
}

/**
 * Drop a pane and promote its sibling. Returns null when `paneId` is the only
 * pane, which callers treat as "clear it instead of removing it".
 */
export function removeLeaf(root: PaneNode, paneId: string): PaneNode | null {
  if (root.kind === 'leaf') return root.id === paneId ? null : root
  if (root.a.kind === 'leaf' && root.a.id === paneId) return root.b
  if (root.b.kind === 'leaf' && root.b.id === paneId) return root.a
  const a = removeLeaf(root.a, paneId)
  const b = removeLeaf(root.b, paneId)
  if (a === root.a && b === root.b) return root
  if (!a) return b
  if (!b) return a
  return { ...root, a, b }
}

function mapLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.kind === 'leaf') return fn(node)
  const a = mapLeaves(node.a, fn)
  const b = mapLeaves(node.b, fn)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/**
 * Exchange two leaves in the tree, including their ids, so the dragged pane
 * keeps focus after a centre drop. Structure and ratios stay put.
 */
export function swapLeaves(root: PaneNode, aId: string, bId: string): PaneNode {
  if (aId === bId) return root
  const a = findLeaf(root, aId)
  const b = findLeaf(root, bId)
  if (!a || !b) return root
  return mapLeaves(root, (leaf) => {
    if (leaf.id === aId) return b
    if (leaf.id === bId) return a
    return leaf
  })
}

/**
 * Pull `sourceId` out of the tree (sibling promotes) and insert it beside
 * `targetId` in `dir`. Pane count is unchanged; orientation can change.
 */
export function moveLeaf(
  root: PaneNode,
  sourceId: string,
  targetId: string,
  dir: SplitDir,
  splitId: string,
  before = false
): PaneNode {
  if (sourceId === targetId) return root
  const source = findLeaf(root, sourceId)
  if (!source || !findLeaf(root, targetId)) return root
  const without = removeLeaf(root, sourceId)
  if (!without || !findLeaf(without, targetId)) return root
  return insertLeaf(without, targetId, dir, splitId, source, before)
}

export function setLeafTerminal(root: PaneNode, paneId: string, terminalId: string | null): PaneNode {
  return mapLeaves(root, (leaf) => {
    if (leaf.id === paneId) {
      if (leaf.terminalId === terminalId) return leaf
      // The pending binding has been honoured once a tab lands here.
      const { pendingConnectionId: _drop, ...rest } = leaf
      return terminalId === null ? { ...leaf, terminalId } : { ...rest, terminalId }
    }
    // A tab lives in at most one pane, so moving it clears the previous holder.
    if (terminalId !== null && leaf.terminalId === terminalId) return { ...leaf, terminalId: null }
    return leaf
  })
}

/** Bind an empty pane to a saved connection it should later be filled from. */
export function setLeafPending(
  root: PaneNode,
  paneId: string,
  connectionId: string | undefined
): PaneNode {
  return mapLeaves(root, (leaf) => {
    if (leaf.id !== paneId) return leaf
    if (leaf.pendingConnectionId === connectionId) return leaf
    if (!connectionId) {
      const { pendingConnectionId: _drop, ...rest } = leaf
      return rest
    }
    return { ...leaf, pendingConnectionId: connectionId }
  })
}

/** Detach a closed tab from whichever pane was showing it. */
export function clearTerminalsFromLayout(root: PaneNode, terminalIds: string[]): PaneNode {
  if (terminalIds.length === 0) return root
  const drop = new Set(terminalIds)
  return mapLeaves(root, (leaf) =>
    leaf.terminalId && drop.has(leaf.terminalId) ? { ...leaf, terminalId: null } : leaf
  )
}

/**
 * `axisPx` is the split's extent along its own axis, in pixels. Pass it whenever
 * it is known so the pane minimums can be enforced in real units.
 */
export function setSplitRatio(
  root: PaneNode,
  splitId: string,
  ratio: number,
  axisPx?: number
): PaneNode {
  const replace = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') return node
    if (node.id === splitId) {
      const next = clampSplitRatio(node, ratio, axisPx)
      return node.ratio === next ? node : { ...node, ratio: next }
    }
    const a = replace(node.a)
    const b = replace(node.b)
    return a === node.a && b === node.b ? node : { ...node, a, b }
  }
  return replace(root)
}

/**
 * Give every pane an equal share of the area.
 *
 * Each split is weighted by how many leaves sit under either side rather than
 * being reset to 0.5, because a lopsided tree — three panes as `leaf | (leaf /
 * leaf)` — needs 1/3 at the root to come out even.
 */
export function evenRatios(node: PaneNode): PaneNode {
  if (node.kind === 'leaf') return node
  const a = evenRatios(node.a)
  const b = evenRatios(node.b)
  const ratio = countLeaves(a) / (countLeaves(a) + countLeaves(b))
  if (a === node.a && b === node.b && node.ratio === ratio) return node
  return { ...node, a, b, ratio }
}

export type FocusDirection = 'left' | 'right' | 'up' | 'down'

/** Whether two 1-D spans share more than a shared border. */
function spansOverlap(aStart: number, aSize: number, bStart: number, bSize: number): boolean {
  return Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart) > 0.5
}

interface Candidate {
  id: string
  along: number
  across: number
  /** Shares rows (or columns) with the source pane. */
  aligned: boolean
}

/**
 * Geometric neighbour lookup, measured edge to edge rather than centre to
 * centre so a tall pane next to two short ones is judged by where it starts.
 *
 * A pane that shares rows or columns with the source always wins over one that
 * merely sits in the right half-plane, however close that one is — otherwise
 * moving `up` out of a bottom-right pane can jump diagonally into a column the
 * user was never in.
 */
export function nearestPaneInDirection(
  boxes: PaneLayoutBoxes,
  fromPaneId: string,
  dir: FocusDirection
): string | null {
  const from = boxes.leaves.find((box) => box.leaf.id === fromPaneId)
  if (!from) return null
  const horizontal = dir === 'left' || dir === 'right'
  const forward = dir === 'right' || dir === 'down'

  const alongOf = (rect: PaneRect): [start: number, size: number] =>
    horizontal ? [rect.left, rect.width] : [rect.top, rect.height]
  const acrossOf = (rect: PaneRect): [start: number, size: number] =>
    horizontal ? [rect.top, rect.height] : [rect.left, rect.width]

  const [fromStart, fromSize] = alongOf(from.rect)
  const fromEdge = forward ? fromStart + fromSize : fromStart
  const [fromCross, fromCrossSize] = acrossOf(from.rect)

  let best: Candidate | null = null
  for (const box of boxes.leaves) {
    if (box.leaf.id === fromPaneId) continue
    const [start, size] = alongOf(box.rect)
    // Gap from the source's trailing edge to the candidate's leading edge.
    // Negative means the candidate is not on the requested side at all.
    const along = forward ? start - fromEdge : fromEdge - (start + size)
    if (along < -0.5) continue

    const [cross, crossSize] = acrossOf(box.rect)
    const candidate: Candidate = {
      id: box.leaf.id,
      along,
      across: Math.abs(cross + crossSize / 2 - (fromCross + fromCrossSize / 2)),
      aligned: spansOverlap(fromCross, fromCrossSize, cross, crossSize)
    }

    if (!best) {
      best = candidate
      continue
    }
    if (best.aligned !== candidate.aligned) {
      if (candidate.aligned) best = candidate
      continue
    }
    if (
      candidate.along < best.along - 0.5 ||
      (candidate.along <= best.along + 0.5 && candidate.across < best.across)
    ) {
      best = candidate
    }
  }
  return best?.id ?? null
}

/**
 * Build a preset layout, reusing the given tab ids left-to-right so an existing
 * session keeps its pane instead of being unloaded.
 */
export function buildPreset(
  preset: LayoutPreset,
  nextId: () => string,
  terminalIds: (string | null)[]
): PaneNode {
  let cursor = 0
  const leaf = (): PaneLeaf => createLeaf(nextId(), terminalIds[cursor++] ?? null)
  const split = (dir: SplitDir, a: PaneNode, b: PaneNode): PaneSplit => ({
    kind: 'split',
    id: nextId(),
    dir,
    ratio: 0.5,
    a,
    b
  })

  switch (preset) {
    case 'cols2':
      return split('row', leaf(), leaf())
    case 'rows2':
      return split('col', leaf(), leaf())
    case 'grid4': {
      // Fill in reading order: top-left, top-right, bottom-left, bottom-right.
      const top = split('row', leaf(), leaf())
      const bottom = split('row', leaf(), leaf())
      return split('col', top, bottom)
    }
    case 'single':
    default:
      return leaf()
  }
}
