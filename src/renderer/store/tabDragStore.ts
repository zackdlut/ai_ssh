import { create } from 'zustand'
import { isLayoutDrag, isPaneDrag, readDraggedPaneId } from '../lib/tabDrag'

interface TabDragState {
  /** True while a tab or pane is being dragged anywhere in the window. */
  dragging: boolean
  /** Pane currently being dragged; null for a tab drag. */
  sourcePaneId: string | null
  setDragging: (dragging: boolean) => void
  setSourcePaneId: (paneId: string | null) => void
}

export const useTabDragStore = create<TabDragState>((set) => ({
  dragging: false,
  sourcePaneId: null,
  setDragging: (dragging) => set((s) => (s.dragging === dragging ? s : { dragging })),
  setSourcePaneId: (sourcePaneId) =>
    set((s) => (s.sourcePaneId === sourcePaneId ? s : { sourcePaneId }))
}))

/**
 * Track tab and pane drags once for the whole window.
 *
 * Every pane used to subscribe on its own, which meant N listeners and N state
 * updates per drag.
 *
 * `dragstart` is watched in the bubble phase, not capture: the payload that says
 * whether this is one of ours is written by the drag source's own handler, which
 * React dispatches at the root container. A capture-phase listener on `window`
 * runs before that and sees an empty `dataTransfer`, so it never armed anything.
 *
 * The two ends stay in the capture phase, because a pane that handles a drop
 * calls `stopPropagation` and a bubble-phase listener would never hear it.
 *
 * Returns an unsubscribe function.
 */
export function attachTabDragTracking(): () => void {
  const arm = (e: DragEvent): void => {
    if (!isLayoutDrag(e.dataTransfer)) return
    const store = useTabDragStore.getState()
    store.setDragging(true)
    if (isPaneDrag(e.dataTransfer)) {
      store.setSourcePaneId(readDraggedPaneId(e.dataTransfer))
    }
  }
  const disarm = (): void => useTabDragStore.setState({ dragging: false, sourcePaneId: null })

  window.addEventListener('dragstart', arm)
  window.addEventListener('dragend', disarm, true)
  window.addEventListener('drop', disarm, true)
  return () => {
    window.removeEventListener('dragstart', arm)
    window.removeEventListener('dragend', disarm, true)
    window.removeEventListener('drop', disarm, true)
  }
}
