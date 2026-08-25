import { isSessionCaptureActive } from './execCapture'
import { getTerminalHandle } from './terminalRegistry'
import { useSessionsStore } from '../store/sessionsStore'
import { usePaneLayoutStore } from '../store/paneLayoutStore'
import { MIN_SYNC_GROUP, lockedPeers, usePaneSyncStore } from '../store/paneSyncStore'

/**
 * Reasons a locked pane is skipped while broadcasting. Surfaced so the sync
 * banner can explain why a session did not receive the keystroke.
 */
export type SyncSkipReason = 'disconnected' | 'nlMode' | 'capturing' | 'readOnly'

export interface BroadcastResult {
  delivered: string[]
  skipped: { tabId: string; reason: SyncSkipReason }[]
}

/**
 * The locked peers of `sourceTerminalId` that share the tab on screen with it.
 *
 * A lock outlives switching tabs, but sync does not reach across one: typing
 * into hosts the user cannot see is how one typo becomes several incidents, and
 * scrolling panes nobody is watching only breaks their alignment. Output
 * arriving in a background tab scrolls it too, so the source is checked as well
 * as the targets.
 */
function peersOnScreen(sourceTerminalId: string): string[] {
  const peers = lockedPeers(sourceTerminalId)
  if (peers.length === 0) return []
  const onScreen = new Set(usePaneLayoutStore.getState().visibleTerminalIds())
  if (!onScreen.has(sourceTerminalId)) return []
  return peers.filter((id) => onScreen.has(id))
}

/**
 * Fan a keystroke out to the locked peers of `sourceTerminalId`.
 *
 * Peers are skipped rather than force-fed when writing to them would break
 * something: terminal AI mode keeps its input in a local buffer, and the agent's
 * `exec_command` capture parses a sentinel marker out of the raw SSH stream, so
 * an injected keystroke would corrupt either one.
 */
export function broadcastInput(sourceTerminalId: string, data: string): BroadcastResult {
  const result: BroadcastResult = { delivered: [], skipped: [] }
  const sync = usePaneSyncStore.getState()
  if (!sync.syncInput || sync.lockedTerminalIds.length < MIN_SYNC_GROUP) return result

  const peers = peersOnScreen(sourceTerminalId)
  if (peers.length === 0) return result
  // The source's own input is local while it is in AI mode; nothing to mirror.
  if (getTerminalHandle(sourceTerminalId)?.isNlMode()) return result

  const { sessions } = useSessionsStore.getState()
  for (const tabId of peers) {
    if (sync.readOnlyTerminalIds.includes(tabId)) {
      result.skipped.push({ tabId, reason: 'readOnly' })
      continue
    }
    const tab = sessions.find((t) => t.id === tabId)
    if (!tab?.sessionId || tab.status !== 'connected') {
      result.skipped.push({ tabId, reason: 'disconnected' })
      continue
    }
    if (getTerminalHandle(tabId)?.isNlMode()) {
      result.skipped.push({ tabId, reason: 'nlMode' })
      continue
    }
    if (isSessionCaptureActive(tab.sessionId)) {
      result.skipped.push({ tabId, reason: 'capturing' })
      continue
    }
    window.api.ssh.write(tab.sessionId, data)
    result.delivered.push(tabId)
  }
  return result
}

/** Re-entrancy guard, should a mirrored scroll ever call back synchronously. */
let applyingScroll = false

/**
 * Move every locked peer of `sourceTerminalId` by however far the source has
 * travelled from its alignment anchor.
 *
 * Anchors are what each pane was showing when the group was aligned (see
 * `realignScroll`), so hosts that printed different amounts of output still
 * stay on the content the user lined up. Targets are recomputed from the
 * anchor every time rather than accumulated, so a peer that hits the end of
 * its scrollback comes back to the right line instead of drifting.
 *
 * A mirrored scroll shows up on the peer's viewport a frame later and would
 * bounce straight back here, so each terminal drops the echo of the position
 * it was steered to (see `TerminalView`).
 */
export function broadcastScroll(sourceTerminalId: string): void {
  if (applyingScroll) return
  // Locking is the only switch: `peersOnScreen` is empty unless this terminal is
  // in a group of at least two.
  const peers = peersOnScreen(sourceTerminalId)
  if (peers.length === 0) return

  const sync = usePaneSyncStore.getState()
  const sourceTop = getTerminalHandle(sourceTerminalId)?.getViewportTop()
  const sourceAnchor = sync.scrollAnchors[sourceTerminalId]
  if (sourceTop === undefined || sourceAnchor === undefined) return
  const moved = sourceTop - sourceAnchor

  applyingScroll = true
  try {
    for (const tabId of peers) {
      const handle = getTerminalHandle(tabId)
      const anchor = sync.scrollAnchors[tabId]
      if (!handle || anchor === undefined) continue
      handle.scrollToAbsolute(anchor + moved)
    }
  } finally {
    applyingScroll = false
  }
}