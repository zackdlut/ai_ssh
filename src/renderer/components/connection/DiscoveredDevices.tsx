import { useMemo, useState } from 'react'
import { useDevicesStore } from '../../store/devicesStore'
import { useSessionsStore } from '../../store/sessionsStore'
import {
  connectDiscoveredPort,
  findSerialTabByPath,
  revealSerialTab,
  shortPortPath
} from '../../lib/serialActions'
import { useT } from '../../lib/i18n'
import UiIcon from '../UiIcon'
import { deviceIconName } from './deviceIcon'
import {
  deviceKindLabel,
  identifySerialDevice,
  type DeviceIdentity,
  type SerialPortInfo
} from '../../../shared/deviceIdentity'

interface Props {
  /** Open the serial dialog pre-filled with this port, for tuning before connecting. */
  onConfigure: (path: string) => void
  /** Right-click on a port row. The menu itself is owned by the sidebar. */
  onPortMenu: (e: React.MouseEvent, port: SerialPortInfo) => void
}

/**
 * Serial ports currently plugged in, above the saved bookmark tree.
 *
 * This is the part of "device discovery" that a saved-bookmark list cannot do:
 * a board arrives with a port path assigned by the OS, which changes between
 * reboots and between USB sockets, so the thing the user wants to click was
 * never something they could have saved in advance.
 *
 * A plate connects on click using the board's own defaults. That is deliberate —
 * making the common case one click is the whole point, and the settings that
 * would need a dialog are exactly the ones `identifySerialDevice` already
 * knows. "Configure" is there for when the guess is wrong.
 */
export default function DiscoveredDevices({ onConfigure, onPortMenu }: Props): JSX.Element | null {
  const ports = useDevicesStore((s) => s.ports)
  const portsError = useDevicesStore((s) => s.portsError)
  const loadingPorts = useDevicesStore((s) => s.loadingPorts)
  const refreshPorts = useDevicesStore((s) => s.refreshPorts)
  const sessions = useSessionsStore((s) => s.sessions)
  const t = useT()

  const [open, setOpen] = useState(true)
  const [legacyOpen, setLegacyOpen] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  /** Port paths with a live session, so a plate shows as in use. */
  const openPaths = useMemo(
    () =>
      new Set(
        sessions
          .filter((s) => s.kind === 'serial' && s.status === 'connected' && s.serialOpts?.path)
          .map((s) => s.serialOpts?.path as string)
      ),
    [sessions]
  )

  const { usbPorts, legacyPorts } = useMemo(() => {
    const usb: SerialPortInfo[] = []
    const legacy: SerialPortInfo[] = []
    for (const port of ports) {
      if (identifySerialDevice(port).usb) usb.push(port)
      else legacy.push(port)
    }
    return { usbPorts: usb, legacyPorts: legacy }
  }, [ports])

  const handleConnect = async (port: SerialPortInfo): Promise<void> => {
    const tab = findSerialTabByPath(port.path)
    if (tab) {
      revealSerialTab(tab.id)
      return
    }
    setConnecting(port.path)
    setError('')
    try {
      const err = await connectDiscoveredPort(port)
      if (err) setError(err)
    } finally {
      setConnecting(null)
    }
  }

  const plateFor = (port: SerialPortInfo, compact?: boolean): JSX.Element => {
    const identity = identifySerialDevice(port)
    return (
      <DevicePlate
        key={port.path}
        port={port}
        identity={identity}
        compact={compact}
        isOpen={openPaths.has(port.path)}
        connecting={connecting === port.path}
        onActivate={() => void handleConnect(port)}
        onConfigure={() => onConfigure(port.path)}
        onMenu={(e) => onPortMenu(e, port)}
      />
    )
  }

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshPorts()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="device-section">
      <div className="device-section-header" onClick={() => setOpen((v) => !v)}>
        <span className={`caret ${open ? 'open' : ''}`}>▸</span>
        <span className="device-section-title">{t('devices.discovered')}</span>
        {usbPorts.length > 0 ? (
          <span className="conn-count">{usbPorts.length}</span>
        ) : (
          ports.length > 0 && <span className="conn-count">{ports.length}</span>
        )}
        <button
          type="button"
          className={`toolbar-btn toolbar-btn--icon device-refresh ${refreshing ? 'is-busy' : ''}`}
          title={t('serial.refresh')}
          aria-busy={refreshing}
          onClick={(e) => {
            e.stopPropagation()
            void handleRefresh()
          }}
        >
          <UiIcon name="refresh" size="sm" />
        </button>
      </div>

      {open && (
        <div className="device-list">
          {portsError && <div className="conn-notice error">{portsError}</div>}
          {error && <div className="conn-notice error">{error}</div>}

          {loadingPorts && ports.length === 0 && (
            <div className="conn-empty device-empty">{t('devices.scanning')}</div>
          )}

          {/*
            An empty list is normal rather than broken — under WSL it is the only
            possible answer — so it gets an explanation instead of blank space.
          */}
          {!loadingPorts && !portsError && ports.length === 0 && (
            <div className="conn-empty device-empty">{t('serial.noPorts')}</div>
          )}

          {usbPorts.map((port) => plateFor(port))}

          {legacyPorts.length > 0 && usbPorts.length > 0 && (
            <div className="device-legacy">
              <button
                type="button"
                className="device-legacy-toggle"
                title={t('devices.legacyHint')}
                aria-expanded={legacyOpen}
                onClick={() => setLegacyOpen((v) => !v)}
              >
                <span className={`caret ${legacyOpen ? 'open' : ''}`}>▸</span>
                <span className="device-legacy-label">{t('devices.legacyPorts')}</span>
                <span className="conn-count">{legacyPorts.length}</span>
              </button>
              {legacyOpen && legacyPorts.map((port) => plateFor(port, true))}
            </div>
          )}

          {usbPorts.length === 0 && legacyPorts.map((port) => plateFor(port, true))}
        </div>
      )}
    </div>
  )
}

interface PlateProps {
  port: SerialPortInfo
  identity: DeviceIdentity
  isOpen: boolean
  connecting: boolean
  /** Single-line layout for onboard / virtual ports that are not a board. */
  compact?: boolean
  onActivate: () => void
  onConfigure: () => void
  onMenu: (e: React.MouseEvent) => void
}

function DevicePlate({
  port,
  identity,
  isOpen,
  connecting,
  compact,
  onActivate,
  onConfigure,
  onMenu
}: PlateProps): JSX.Element {
  const t = useT()
  const name = plateName(port, identity)
  const guess =
    identity.ambiguous && identity.candidates[0]
      ? t('devices.maybeKind', { board: deviceKindLabel(identity.candidates[0]) })
      : ''
  const title = isOpen
    ? t('devices.revealTab')
    : t('devices.connectDefault', {
        baud: identity.baudRate,
        board: deviceKindLabel(identity.kind)
      })

  const cls = [
    'device-plate',
    compact ? 'device-plate--compact' : '',
    !identity.usb ? 'device-plate--ghost' : '',
    isOpen ? 'device-plate--open' : '',
    connecting ? 'device-plate--busy' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} data-kind={identity.kind} onContextMenu={onMenu}>
      <button
        type="button"
        className="device-plate-main"
        title={`${title}\n${describePort(port)}`}
        aria-label={
          isOpen
            ? `${name}, ${t('devices.inUse')}. ${t('devices.revealTab')}`
            : `${name}, ${shortPortPath(port.path)}, ${identity.baudRate}`
        }
        disabled={connecting}
        aria-busy={connecting}
        onClick={onActivate}
      >
        <span className="device-well" aria-hidden>
          <UiIcon name={deviceIconName(identity.kind)} size="sm" className="device-icon" />
          {identity.ambiguous && <span className="device-maybe-mark">?</span>}
          {isOpen && <span className="device-led" />}
        </span>
        <span className="device-copy">
          <span className="device-name">{name}</span>
          {!compact && (
            <span className="device-meta">
              <span className="device-path">{shortPortPath(port.path)}</span>
              {guess && <span className="device-guess">{guess}</span>}
            </span>
          )}
        </span>
        <span className="device-rate">{identity.baudRate}</span>
      </button>
      <button
        type="button"
        className="device-action"
        title={t('devices.configure')}
        onClick={onConfigure}
      >
        <UiIcon name="settings" size="sm" />
      </button>
    </div>
  )
}

/**
 * What to paint as the plate headline.
 *
 * USB boards are named by the chip, with the generic "USB-UART" suffix dropped
 * because every row here is already a serial port. A legacy ttyS* has no chip,
 * so the path is the only name the OS gave us.
 */
function plateName(port: SerialPortInfo, identity: DeviceIdentity): string {
  if (!identity.usb) return shortPortPath(port.path)
  const raw = identity.chip ?? identity.label
  return raw.replace(/\s+USB-UART$/i, '')
}

/** Tooltip: everything the OS knows, since the plate itself shows only two lines. */
function describePort(port: SerialPortInfo): string {
  const identity = identifySerialDevice(port)
  const parts = [port.path, identity.chip ?? identity.label]
  if (identity.ambiguous) parts.push(`? ${identity.candidates.join(' / ')}`)
  if (port.vendorId) parts.push(`${port.vendorId}:${port.productId ?? '????'}`)
  if (port.serialNumber) parts.push(`SN ${port.serialNumber}`)
  parts.push(`${identity.baudRate} baud`)
  return parts.join(' · ')
}
