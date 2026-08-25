import { clampRatio, createLeaf, type PaneNode, type SplitDir } from './paneLayout'
import type { SavedLayoutNode } from '../../shared/types'

/**
 * Live tab ids mean nothing after a restart, so a stored layout keeps only the
 * tree shape, the ratios, and each pane's saved-connection binding.
 */
export function serializeLayout(
  root: PaneNode,
  connectionIdForTerminal: (terminalId: string) => string | undefined
): SavedLayoutNode {
  if (root.kind === 'leaf') {
    const connectionId = root.terminalId
      ? connectionIdForTerminal(root.terminalId) ?? root.pendingConnectionId
      : root.pendingConnectionId
    return connectionId ? { kind: 'leaf', connectionId } : { kind: 'leaf' }
  }
  return {
    kind: 'split',
    dir: root.dir,
    ratio: clampRatio(root.ratio),
    a: serializeLayout(root.a, connectionIdForTerminal),
    b: serializeLayout(root.b, connectionIdForTerminal)
  }
}

function isDir(value: unknown): value is SplitDir {
  return value === 'row' || value === 'col'
}

/**
 * Rebuild a tree from stored JSON, minting fresh pane ids.
 *
 * Everything here is defensive because the input is a file a user can edit: a
 * malformed node collapses to an empty pane rather than throwing, and a tree
 * that is entirely unusable is rejected by the caller via `null`.
 */
export function parseLayout(
  node: unknown,
  nextId: () => string,
  depth = 0
): PaneNode | null {
  // Guards against a hand-edited config nesting deep enough to blow the stack.
  if (depth > 32) return null
  if (!node || typeof node !== 'object') return null
  const raw = node as Record<string, unknown>

  if (raw.kind === 'leaf') {
    const leaf = createLeaf(nextId())
    return typeof raw.connectionId === 'string' && raw.connectionId
      ? { ...leaf, pendingConnectionId: raw.connectionId }
      : leaf
  }

  if (raw.kind === 'split') {
    const a = parseLayout(raw.a, nextId, depth + 1)
    const b = parseLayout(raw.b, nextId, depth + 1)
    // A split with a broken half degrades to its surviving child.
    if (!a && !b) return null
    if (!a) return b
    if (!b) return a
    return {
      kind: 'split',
      id: nextId(),
      dir: isDir(raw.dir) ? raw.dir : 'row',
      ratio: clampRatio(typeof raw.ratio === 'number' ? raw.ratio : 0.5),
      a,
      b
    }
  }
  return null
}

/** Saved-connection ids bound to a stored layout, in visual order. */
export function layoutConnectionIds(node: SavedLayoutNode): string[] {
  if (node.kind === 'leaf') return node.connectionId ? [node.connectionId] : []
  return [...layoutConnectionIds(node.a), ...layoutConnectionIds(node.b)]
}

export function countLayoutLeaves(node: SavedLayoutNode): number {
  return node.kind === 'leaf' ? 1 : countLayoutLeaves(node.a) + countLayoutLeaves(node.b)
}
