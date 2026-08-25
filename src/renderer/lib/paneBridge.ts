import { reconcileActiveSession, usePaneLayoutStore } from '../store/paneLayoutStore'
import { usePaneSyncStore } from '../store/paneSyncStore'
import { usePaneDiffStore } from '../store/paneDiffStore'
import { usePaneSearchStore } from '../store/paneSearchStore'
import { useSessionsStore } from '../store/sessionsStore'

/**
 * Bridge the session list into the pane stores: closed sessions are detached
 * from the layout, the sync group and the diff selection, and a session that
 * becomes active without a pane is placed automatically.
 *
 * `connect.ts` normally places a session before registering it, so the
 * automatic placement is a safety net for whatever adds a session directly.
 *
 * Lives outside the stores so none of them has to import another, which would
 * otherwise form a cycle through `paneDiffStore` reading the layout.
 *
 * Returns an unsubscribe function.
 */
export function attachPaneBridge(): () => void {
  reconcileActiveSession()

  return useSessionsStore.subscribe((state, prev) => {
    if (state.sessions !== prev.sessions) {
      const live = new Set(state.sessions.map((s) => s.id))
      const gone = prev.sessions.map((s) => s.id).filter((id) => !live.has(id))
      if (gone.length) {
        usePaneLayoutStore.getState().detachTerminals(gone)
        usePaneSyncStore.getState().detachTerminals(gone)
        usePaneDiffStore.getState().detachTerminals(gone)
        usePaneSearchStore.getState().detachTerminals(gone)
      }
    }
    reconcileActiveSession()
  })
}
