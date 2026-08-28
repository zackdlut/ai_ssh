import { matchesKeyEvent } from './keybindingMatch'
import { closePaneWithSession } from './connect'
import { usePaneLayoutStore } from '../store/paneLayoutStore'
import { usePaneSyncStore } from '../store/paneSyncStore'
import { usePaneSearchStore } from '../store/paneSearchStore'
import { useKeybindingsStore } from '../store/keybindingsStore'
import type { KeybindingId, KeybindingsSettings } from '../../shared/keybindings'
import type { FocusDirection } from './paneLayout'

const FOCUS_BINDINGS: [KeybindingId, FocusDirection][] = [
  ['focusPaneLeft', 'left'],
  ['focusPaneRight', 'right'],
  ['focusPaneUp', 'up'],
  ['focusPaneDown', 'down']
]

/**
 * Split-pane shortcuts.
 *
 * Returns true when the key was consumed. `terminalId` is null for an empty
 * focused pane, which is why the search binding checks it: search acts on
 * a scrollback, while the layout bindings only need the pane.
 */
export function handlePaneKey(
  bindings: KeybindingsSettings,
  e: KeyboardEvent,
  paneId: string | null,
  terminalId: string | null
): boolean {
  const layout = usePaneLayoutStore.getState()

  if (paneId && matchesKeyEvent(bindings.splitVertical, e)) {
    e.preventDefault()
    layout.splitPane(paneId, 'row')
    return true
  }
  if (paneId && matchesKeyEvent(bindings.splitHorizontal, e)) {
    e.preventDefault()
    layout.splitPane(paneId, 'col')
    return true
  }
  if (paneId && matchesKeyEvent(bindings.closePane, e)) {
    e.preventDefault()
    closePaneWithSession(paneId)
    return true
  }
  if (paneId && matchesKeyEvent(bindings.zoomPane, e)) {
    e.preventDefault()
    layout.toggleZoom(paneId)
    return true
  }
  for (const [binding, dir] of FOCUS_BINDINGS) {
    if (matchesKeyEvent(bindings[binding], e)) {
      e.preventDefault()
      layout.focusDirection(dir)
      return true
    }
  }
  if (matchesKeyEvent(bindings.evenPanes, e)) {
    e.preventDefault()
    layout.evenOut()
    return true
  }
  if (terminalId && matchesKeyEvent(bindings.paneSearch, e)) {
    e.preventDefault()
    usePaneSearchStore.getState().open(terminalId)
    return true
  }
  if (matchesKeyEvent(bindings.toggleSyncInput, e)) {
    e.preventDefault()
    const sync = usePaneSyncStore.getState()
    sync.setSyncInput(!sync.syncInput)
    return true
  }
  return false
}

const EDITABLE_TAGS = /^(INPUT|TEXTAREA|SELECT)$/

/**
 * Window-level fallback for the pane shortcuts. While a terminal has focus xterm
 * owns the keyboard and handles these itself, calling `preventDefault`; this
 * covers the rest of the app — most importantly a focused *empty* pane, where no
 * terminal exists to route the keys through.
 *
 * Returns an unsubscribe function.
 */
export function attachGlobalPaneShortcuts(): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return
    const target = e.target as HTMLElement | null
    // xterm's hidden textarea already had its chance; other fields keep their keys.
    if (target && EDITABLE_TAGS.test(target.tagName)) return

    const layout = usePaneLayoutStore.getState()
    handlePaneKey(
      useKeybindingsStore.getState(),
      e,
      layout.activeTab().focusedPaneId,
      layout.focusedTerminalId()
    )
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}
