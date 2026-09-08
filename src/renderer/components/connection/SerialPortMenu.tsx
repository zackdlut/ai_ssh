import { useBookmarksStore } from '../../store/bookmarksStore'
import { useSessionsStore, type TerminalSession } from '../../store/sessionsStore'
import ContextMenuItem from '../ContextMenuItem'
import ContextMenuSubmenu from '../ContextMenuSubmenu'
import { useT } from '../../lib/i18n'
import {
  connectDiscoveredPort,
  copyToClipboard,
  disconnectSerialTab,
  resetSerialDevice,
  revealSerialTab,
  saveDiscoveredPort,
  toggleSerialSignal
} from '../../lib/serialActions'
import { identifySerialDevice, type SerialPortInfo } from '../../../shared/deviceIdentity'
import type { ConnectionConfig } from '../../../shared/types'

/** Report an action's outcome to the sidebar's notice strip. */
export type NoticeFn = (text: string, error?: boolean) => void

/** The ESP ROM bootloader's rate, called out wherever it is offered. */
const ESP_ROM_BAUD = 74880

/**
 * Baud rates worth one click.
 *
 * Not the full preset list: a submenu of sixteen rates is a wall, and these
 * four cover what a wrong-baud symptom actually needs. 74880 earns its place
 * by being unguessable — it is the ESP8266/ESP32 ROM bootloader rate, so it is
 * the answer to "the first lines after a reset are garbage".
 */
const QUICK_BAUDS = [9600, ESP_ROM_BAUD, 115200, 921600] as const

/**
 * Actions that only exist while a port is open.
 *
 * Shared by the discovered-port menu and the saved-device menu because the
 * actions are identical once a session exists — the two rows differ only in how
 * they find it.
 */
function LiveSerialItems({
  tab,
  onNotice
}: {
  tab: TerminalSession
  onNotice: NoticeFn
}): JSX.Element {
  const t = useT()
  // Unset reads as asserted: that is what a serial port does when nobody said
  // otherwise, so the checkmark has to show it as on.
  const dtr = tab.serialOpts?.dtr ?? true
  const rts = tab.serialOpts?.rts ?? true

  const run = async (fn: () => Promise<string | undefined>): Promise<void> => {
    const err = await fn()
    if (err) onNotice(err, true)
  }

  return (
    <>
      <ContextMenuItem icon="terminal" onClick={() => revealSerialTab(tab.id)}>
        {t('devices.revealTab')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="refresh"
        title={t('devices.resetHint')}
        onClick={() => void run(() => resetSerialDevice(tab.id))}
      >
        {t('devices.reset')}
      </ContextMenuItem>
      <ContextMenuSubmenu icon="serial" label={t('devices.signals')} title={t('devices.signalsHint')}>
        <ContextMenuItem onClick={() => void run(() => toggleSerialSignal(tab.id, 'dtr'))}>
          <span className="context-menu-check">{dtr ? '✓' : ''}</span>
          {t('devices.dtr')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void run(() => toggleSerialSignal(tab.id, 'rts'))}>
          <span className="context-menu-check">{rts ? '✓' : ''}</span>
          {t('devices.rts')}
        </ContextMenuItem>
      </ContextMenuSubmenu>
      <ContextMenuItem
        icon="unplug"
        title={t('devices.disconnectHint')}
        onClick={() => disconnectSerialTab(tab.id)}
      >
        {t('devices.disconnect')}
      </ContextMenuItem>
    </>
  )
}

/**
 * Right-click menu for a port that is plugged in right now.
 *
 * The menu splits on whether the port is open, because a serial port is
 * exclusive: the connect actions are impossible while a session holds it, and
 * the reset and signal actions are impossible until one does.
 */
export default function SerialPortMenu({
  port,
  onConfigure,
  onNotice
}: {
  port: SerialPortInfo
  onConfigure: (path: string) => void
  onNotice: NoticeFn
}): JSX.Element {
  const t = useT()
  const sessions = useSessionsStore((s) => s.sessions)
  const connections = useBookmarksStore((s) => s.connections)
  const identity = identifySerialDevice(port)

  // Read from the subscribed list rather than the store snapshot, so the
  // checkmarks in the signal submenu update while the menu is open.
  const tab = sessions.find(
    (s) => s.kind === 'serial' && s.status === 'connected' && s.serialOpts?.path === port.path
  )
  const saved = connections.some((c) => c.kind === 'serial' && c.serial?.path === port.path)

  const connect = async (baudRate?: number): Promise<void> => {
    const err = await connectDiscoveredPort(port, baudRate ? { baudRate } : undefined)
    if (err) onNotice(err, true)
  }

  return (
    <>
      {tab ? (
        <LiveSerialItems tab={tab} onNotice={onNotice} />
      ) : (
        <>
          <ContextMenuItem
            icon="connect"
            title={t('devices.connectDefaultHint', {
              baud: String(identity.baudRate),
              board: identity.label
            })}
            onClick={() => void connect()}
          >
            {t('devices.connectDefault', { baud: String(identity.baudRate) })}
          </ContextMenuItem>
          <ContextMenuSubmenu
            icon="serial"
            label={t('devices.connectAtBaud')}
            title={t('devices.connectAtBaudHint')}
          >
            {QUICK_BAUDS.map((baud) => (
              <ContextMenuItem
                key={baud}
                onClick={() => void connect(baud)}
                title={baud === ESP_ROM_BAUD ? t('devices.romBaudHint') : undefined}
              >
                {baud === ESP_ROM_BAUD
                  ? `${baud} · ${t('serial.baudRomBootloader')}`
                  : String(baud)}
              </ContextMenuItem>
            ))}
          </ContextMenuSubmenu>
          <ContextMenuItem icon="settings" onClick={() => onConfigure(port.path)}>
            {t('devices.configure')}
          </ContextMenuItem>
        </>
      )}

      <div className="context-menu-divider" role="separator" />

      {/* Saving is about the bookmark tree, not the session, so it stays
          available whether or not the port is currently open. */}
      {!saved && (
        <ContextMenuItem icon="save" onClick={() => void saveDiscoveredPort(port)}>
          {t('devices.saveAsDevice')}
        </ContextMenuItem>
      )}
      <ContextMenuItem
        icon="copy"
        title={t('devices.copyPathHint')}
        onClick={() => void copyToClipboard(port.path)}
      >
        {t('devices.copyPath')}
      </ContextMenuItem>
    </>
  )
}

/**
 * The live-session items for a SAVED serial device, appended to its ordinary
 * connect / edit / delete menu.
 *
 * Returns nothing when the device is not currently open, which is the common
 * case for a saved entry: the board may not even be plugged in.
 */
export function SavedSerialMenuItems({
  conn,
  onNotice
}: {
  conn: ConnectionConfig
  onNotice: NoticeFn
}): JSX.Element | null {
  const sessions = useSessionsStore((s) => s.sessions)
  const t = useT()
  const path = conn.serial?.path
  const tab = sessions.find(
    (s) => s.kind === 'serial' && s.status === 'connected' && s.serialOpts?.path === path
  )

  if (!path) return null
  return (
    <>
      <div className="context-menu-divider" role="separator" />
      {tab && <LiveSerialItems tab={tab} onNotice={onNotice} />}
      <ContextMenuItem
        icon="copy"
        title={t('devices.copyPathHint')}
        onClick={() => void copyToClipboard(path)}
      >
        {t('devices.copyPath')}
      </ContextMenuItem>
    </>
  )
}