import type { SplitDir } from './paneLayout'

/** Custom MIME so a pane only accepts drops that came from the tab bar. */
export const TAB_DRAG_MIME = 'application/x-aissh-tab'

/** Custom MIME for a pane dragged by its header within the same tab. */
export const PANE_DRAG_MIME = 'application/x-aissh-pane'

/**
 * Whether a drag carries one of our tabs.
 *
 * Uses `types` rather than `getData`, because during `dragover` the data itself
 * is in protected mode and reads back as an empty string — only the type list
 * is visible until the drop actually happens.
 */
export function isTabDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer?.types.includes(TAB_DRAG_MIME))
}

export function isPaneDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer?.types.includes(PANE_DRAG_MIME))
}

/** Tab or pane drag — either one should arm the in-pane drop zones. */
export function isLayoutDrag(dataTransfer: DataTransfer | null): boolean {
  return isTabDrag(dataTransfer) || isPaneDrag(dataTransfer)
}

/** The dragged tab id. Only meaningful inside a `drop` handler. */
export function readDraggedTabId(dataTransfer: DataTransfer | null): string | null {
  return dataTransfer?.getData(TAB_DRAG_MIME) || null
}

/** The dragged pane id. Only meaningful inside a `drop` handler. */
export function readDraggedPaneId(dataTransfer: DataTransfer | null): string | null {
  return dataTransfer?.getData(PANE_DRAG_MIME) || null
}

export type PaneDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

/**
 * How a zone turns into a split. `center` means "show it in this pane", so it
 * has no split at all; the edges put the new pane on the side dropped on.
 */
export function dropZoneSplit(
  zone: PaneDropZone
): { dir: SplitDir; before: boolean } | null {
  switch (zone) {
    case 'left':
      return { dir: 'row', before: true }
    case 'right':
      return { dir: 'row', before: false }
    case 'top':
      return { dir: 'col', before: true }
    case 'bottom':
      return { dir: 'col', before: false }
    case 'center':
      return null
  }
}

/** What a drop on `targetPaneId` should do, decided from the payload alone. */
export type PaneDropAction =
  | { kind: 'swapPanes'; sourcePaneId: string }
  | { kind: 'movePane'; sourcePaneId: string; dir: SplitDir; before: boolean }
  | { kind: 'showTerminal'; terminalId: string }
  | { kind: 'splitWithTerminal'; terminalId: string; dir: SplitDir; before: boolean }

/**
 * Resolve a drop without consulting any React state.
 *
 * This has to be driven by the payload alone. The window-level drag tracking
 * disarms on `drop` in the capture phase, so by the time the drop reaches the
 * zone the "a drag is in flight" flag has already been cleared — a handler that
 * checked it would refuse every drop it was meant to handle.
 */
export function paneDropAction(
  dataTransfer: DataTransfer | null,
  zone: PaneDropZone,
  targetPaneId: string
): PaneDropAction | null {
  const split = dropZoneSplit(zone)
  const sourcePaneId = readDraggedPaneId(dataTransfer)
  if (sourcePaneId) {
    // Dropping a pane on itself would remove it and put it straight back.
    if (sourcePaneId === targetPaneId) return null
    return split
      ? { kind: 'movePane', sourcePaneId, dir: split.dir, before: split.before }
      : { kind: 'swapPanes', sourcePaneId }
  }
  const terminalId = readDraggedTabId(dataTransfer)
  if (!terminalId) return null
  // A centre drop means "show it here", so it targets this pane directly
  // instead of letting `showTerminal` hunt for an empty one somewhere else.
  return split
    ? { kind: 'splitWithTerminal', terminalId, dir: split.dir, before: split.before }
    : { kind: 'showTerminal', terminalId }
}
