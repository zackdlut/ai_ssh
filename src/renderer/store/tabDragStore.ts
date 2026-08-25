import { create } from 'zustand'
import { isTabDrag } from '../lib/tabDrag'

interface TabDragState {
  /** True while one of our tabs is being dragged anywhere in the window. */
  dragging: boolean
  setDragging: (dragging: boolean) => void
}

export const useTabDragStore = create<TabDragState>((set) => ({
  dragging: false,
  setDragging: (dragging) => set((s) => (s.dragging === dragging ? s : { dragging }))
}))

/**
 * Track tab drags once for the whole window.
 *
 * Every pane used to subscribe on its own, which meant N listeners and N state
 * updates per drag. Worse, the pane that handled a drop called `stopPropagation`,
 * so a bubble-phase `drop` listener on `window` never fired and disarming leaned
 * entirely on `dragend` arriving afterwards. Listening in the capture phase runs
 * before any pane can stop the event.
 *
 * Returns an unsubscribe function.
 */
export function attachTabDragTracking(): () => void {
  const arm = (e: DragEvent): void => {
    if (isTabDrag(e.dataTransfer)) useTabDragStore.getState().setDragging(true)
  }
  const disarm = (): void => useTabDragStore.getState().setDragging(false)

  window.addEventListener('dragstart', arm, true)
  window.addEventListener('dragend', disarm, true)
  window.addEventListener('drop', disarm, true)
  return () => {
    window.removeEventListener('dragstart', arm, true)
    window.removeEventListener('dragend', disarm, true)
    window.removeEventListener('drop', disarm, true)
  }
}
