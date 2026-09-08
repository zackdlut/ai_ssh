/**
 * Actions the sidebar offers on a serial device.
 *
 * They live outside the components because the same five actions are reachable
 * from two rows that share no code: a discovered port (identified by its path,
 * which is all the OS gave us) and a saved device (identified by its config,
 * whose stored path may not be plugged in right now). Both resolve to the same
 * live session in the end, so the resolution and the error wording belong in
 * one place rather than being written twice and drifting.
 */
import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'
import { usePaneLayoutStore } from '../store/paneLayoutStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import { connectSerial } from './connect'
import { debugLog } from './debugLog'
import {
  identifySerialDevice,
  type DeviceKind,
  type SerialPortInfo
} from '../../shared/deviceIdentity'
import type { ConnectionConfig } from '../../shared/types'

/** Strip `/dev/` so a row and a tab title read as `ttyUSB0`, not a full path. */
export function shortPortPath(path: string): string {
  return path.replace(/^\/dev\//, '')
}

/**
 * Open a discovered port using the board's own defaults.
 *
 * `baudRate` overrides the guess, which is the whole point of the menu's baud
 * list: a wrong baud shows as garbage or silence, and the fastest way to settle
 * it is to reopen at another rate rather than reason about it.
 */
export async function connectDiscoveredPort(
  port: SerialPortInfo,
  opts?: { baudRate?: number }
): Promise<string | undefined> {
  const identity = identifySerialDevice(port)
  return connectSerial(
    {
      path: port.path,
      baudRate: opts?.baudRate ?? identity.baudRate,
      dtr: identity.dtr,
      rts: identity.rts,
      newline: identity.newline
    },
    { deviceKind: identity.kind }
  )
}

/**
 * A bookmark for a discovered port, carrying the guessed settings.
 *
 * The id is derived from the path so saving the same port twice updates the one
 * entry instead of growing duplicates — the path is the only stable handle the
 * OS offers, and it is what the user recognises.
 */
export function serialConfigFromPort(port: SerialPortInfo): ConnectionConfig {
  const identity = identifySerialDevice(port)
  return {
    id: `serial:${port.path}`,
    name: identity.chip
      ? `${identity.label} (${shortPortPath(port.path)})`
      : shortPortPath(port.path),
    kind: 'serial',
    host: '',
    port: 0,
    username: '',
    serial: {
      path: port.path,
      baudRate: identity.baudRate,
      dtr: identity.dtr,
      rts: identity.rts,
      newline: identity.newline
    },
    deviceKind: identity.kind,
    parentId: null
  }
}

/** Write a discovered port into the bookmark tree as a saved device. */
export async function saveDiscoveredPort(port: SerialPortInfo): Promise<void> {
  await useBookmarksStore.getState().upsertConnection(serialConfigFromPort(port))
}

/** The live serial session holding a port, if any. */
export function findSerialTabByPath(path: string | undefined): TerminalSession | undefined {
  if (!path) return undefined
  return useSessionsStore
    .getState()
    .sessions.find(
      (s) => s.kind === 'serial' && s.status === 'connected' && s.serialOpts?.path === path
    )
}

/**
 * Bring a serial tab on screen.
 *
 * This is what the "in use" badge was missing: the sidebar could tell the user
 * a port was already open and then leave them to find the tab themselves.
 */
export function revealSerialTab(terminalId: string): void {
  usePaneLayoutStore.getState().showTerminal(terminalId)
  useSessionsStore.getState().setActive(terminalId)
}

/** Pulse the board's reset line and let its boot log land in the terminal. */
export async function resetSerialDevice(
  terminalId: string,
  kind?: DeviceKind
): Promise<string | undefined> {
  const tab = useSessionsStore.getState().sessions.find((s) => s.id === terminalId)
  if (!tab?.sessionId) return 'That device is no longer connected.'

  // Show the tab first. A reset produces a burst of output that IS the result
  // of the action, so leaving the user on another pane hides the only feedback
  // this action has.
  revealSerialTab(terminalId)
  debugLog({
    category: 'user.action',
    tabId: terminalId,
    message: 'serial.reset',
    data: { kind: kind ?? tab.deviceKind }
  })
  const res = await window.api.serial.reset(tab.sessionId, kind ?? tab.deviceKind)
  if (res.error) return res.error
  applyReportedSignals(terminalId, res)
  return undefined
}

/**
 * Flip one of the two control lines on a live session.
 *
 * Worth a menu item because the failure it fixes is silent: on an ESP32 devkit
 * both lines asserted holds the chip in reset, so the terminal stays empty with
 * no error to explain it. Toggling here fixes that without closing the port,
 * which matters because reopening it would lose the scrollback.
 */
export async function toggleSerialSignal(
  terminalId: string,
  line: 'dtr' | 'rts'
): Promise<string | undefined> {
  const tab = useSessionsStore.getState().sessions.find((s) => s.id === terminalId)
  if (!tab?.sessionId) return 'That device is no longer connected.'

  // An unset line reads as asserted, because that is what a serial port does
  // when nobody said otherwise — so the first toggle clears it.
  const current = tab.serialOpts?.[line] ?? true
  const next = !current
  debugLog({
    category: 'user.action',
    tabId: terminalId,
    message: 'serial.setSignals',
    data: { [line]: next }
  })
  const res = await window.api.serial.setSignals(tab.sessionId, { [line]: next })
  if (res.error) return res.error
  // Fall back to the value we asked for: an older main process answers without
  // echoing the state, and a toggle that does not move is worse than one that
  // trusts the successful call.
  applyReportedSignals(terminalId, { [line]: next, ...res })
  return undefined
}

/** Mirror whatever the main process reported into the tab's stored options. */
function applyReportedSignals(
  terminalId: string,
  res: { dtr?: boolean; rts?: boolean }
): void {
  const signals: { dtr?: boolean; rts?: boolean } = {}
  if (typeof res.dtr === 'boolean') signals.dtr = res.dtr
  if (typeof res.rts === 'boolean') signals.rts = res.rts
  if (Object.keys(signals).length > 0) {
    useSessionsStore.getState().setSerialSignals(terminalId, signals)
  }
}

/**
 * Release the port, keeping the tab.
 *
 * A serial port is exclusive, so this is the action that lets `esptool` or
 * `arduino-cli` have it — which is the normal next step after reading a boot
 * log, and the reason "port is busy" is the most common upload failure.
 */
export function disconnectSerialTab(terminalId: string): void {
  const tab = useSessionsStore.getState().sessions.find((s) => s.id === terminalId)
  if (!tab?.sessionId) return
  debugLog({ category: 'user.action', tabId: terminalId, message: 'serial.disconnect', data: {} })
  window.api.ssh.close(tab.sessionId)
}

/**
 * Put text on the clipboard.
 *
 * Exists for the port path. The app deliberately does not flash, so the user
 * runs `esptool --port /dev/ttyUSB0` themselves in a shell tab; this is the
 * bridge between the two halves, and retyping a path is exactly the kind of
 * transcription error that reads afterwards as a hardware fault.
 */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard permission can be refused; a failed copy is not worth an error
    // dialog, and the path is still visible in the row's tooltip.
  }
}
