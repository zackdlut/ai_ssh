import type { SplitDir } from './paneLayout'

/** Custom MIME so a pane only accepts drops that came from the tab bar. */
export const TAB_DRAG_MIME = 'application/x-aissh-tab'

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

/** The dragged tab id. Only meaningful inside a `drop` handler. */
export function readDraggedTabId(dataTransfer: DataTransfer | null): string | null {
  return dataTransfer?.getData(TAB_DRAG_MIME) || null
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
