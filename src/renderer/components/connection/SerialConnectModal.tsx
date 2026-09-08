import { useEffect, useMemo, useState } from 'react'
import { useBookmarksStore, type TreeNode } from '../../store/bookmarksStore'
import { connectSerial } from '../../lib/connect'
import { useT } from '../../lib/i18n'
import {
  identifySerialDevice,
  SERIAL_BAUD_PRESETS,
  type DeviceKind,
  type SerialNewline,
  type SerialPortInfo
} from '../../../shared/deviceIdentity'
import type { ConnectionConfig, SerialConnectOptions } from '../../../shared/types'
import UiIcon from '../UiIcon'

interface Props {
  onClose: () => void
  /** Pre-select this port, e.g. when opened from a discovered device row. */
  initialPath?: string
  /** When set, edit an existing saved serial device instead of creating one. */
  editConn?: ConnectionConfig | null
  defaultParentId?: string | null
}

interface FolderOption {
  id: string | null
  label: string
}

const DATA_BITS = [8, 7, 6, 5] as const
const STOP_BITS = [1, 1.5, 2] as const
const PARITIES = ['none', 'even', 'odd', 'mark', 'space'] as const
const NEWLINES: SerialNewline[] = ['cr', 'lf', 'crlf', 'none']

export default function SerialConnectModal({
  onClose,
  initialPath,
  editConn,
  defaultParentId
}: Props): JSX.Element {
  const getTree = useBookmarksStore((s) => s.getTree)
  const upsertConnection = useBookmarksStore((s) => s.upsertConnection)
  const t = useT()

  const saved = editConn?.serial
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [listError, setListError] = useState('')
  const [listing, setListing] = useState(true)

  const [name, setName] = useState(editConn?.name ?? '')
  const [path, setPath] = useState(saved?.path ?? initialPath ?? '')
  const [baudRate, setBaudRate] = useState(String(saved?.baudRate ?? 115200))
  const [dataBits, setDataBits] = useState<number>(saved?.dataBits ?? 8)
  const [stopBits, setStopBits] = useState<number>(saved?.stopBits ?? 1)
  const [parity, setParity] = useState<string>(saved?.parity ?? 'none')
  const [dtr, setDtr] = useState(saved?.dtr ?? true)
  const [rts, setRts] = useState(saved?.rts ?? true)
  const [rtscts, setRtscts] = useState(saved?.rtscts ?? false)
  const [newline, setNewline] = useState<SerialNewline>(saved?.newline ?? 'cr')
  const [echo, setEcho] = useState(saved?.echo ?? false)
  const [advanced, setAdvanced] = useState(false)
  const [remember, setRemember] = useState(Boolean(editConn))
  const [parentId, setParentId] = useState<string | null>(
    editConn?.parentId ?? defaultParentId ?? null
  )
  const [deviceKind, setDeviceKind] = useState<DeviceKind | undefined>(editConn?.deviceKind)
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)
  /**
   * Set once the user changes a setting the board guess would otherwise own.
   * Re-picking a port must be able to re-apply the defaults for the new board,
   * but not silently undo a baud rate the user typed on purpose.
   */
  const [touched, setTouched] = useState(Boolean(editConn))

  const isEditing = Boolean(editConn)

  const refreshPorts = async (): Promise<void> => {
    setListing(true)
    const res = await window.api.serial.list()
    setListing(false)
    if (res.error) {
      setListError(res.error)
      return
    }
    setListError('')
    setPorts(res.ports ?? [])
  }

  useEffect(() => {
    void refreshPorts()
  }, [])

  const selected = useMemo(() => ports.find((p) => p.path === path), [ports, path])
  const identity = useMemo(
    () => (selected ? identifySerialDevice(selected) : undefined),
    [selected]
  )

  /**
   * Apply the board's own defaults when a port is picked.
   *
   * This is the part that decides whether the terminal shows anything: the baud
   * rate and the DTR/RTS state have no discoverable correct value, and both
   * wrong-by-default cases look identical to a dead board. Anything the user
   * has already set is left alone.
   */
  useEffect(() => {
    if (!identity || touched) return
    setBaudRate(String(identity.baudRate))
    setDtr(identity.dtr)
    setRts(identity.rts)
    setNewline(identity.newline)
    setDeviceKind(identity.kind)
  }, [identity, touched])

  const folderOptions = useMemo<FolderOption[]>(() => {
    const opts: FolderOption[] = [{ id: null, label: t('common.root') }]
    const walk = (nodes: TreeNode[], depth: number): void => {
      for (const n of nodes) {
        if (n.kind === 'folder') {
          opts.push({ id: n.id, label: `${'　'.repeat(depth)}${n.folder.name}` })
          walk(n.children, depth + 1)
        }
      }
    }
    walk(getTree(), 0)
    return opts
  }, [getTree, t])

  const buildOpts = (): SerialConnectOptions => ({
    path: path.trim(),
    baudRate: Number(baudRate) || 115200,
    dataBits: dataBits as 5 | 6 | 7 | 8,
    stopBits: stopBits as 1 | 1.5 | 2,
    parity: parity as SerialConnectOptions['parity'],
    rtscts,
    dtr,
    rts,
    newline,
    echo
  })

  const buildConfig = (): ConnectionConfig => {
    const opts = buildOpts()
    return {
      id: editConn?.id ?? `serial:${opts.path}`,
      name: name.trim() || opts.path.replace(/^\/dev\//, ''),
      kind: 'serial',
      // A serial device has no network identity. These stay empty rather than
      // carrying a placeholder, so nothing downstream tries to dial them.
      host: '',
      port: 0,
      username: '',
      serial: opts,
      deviceKind,
      parentId,
      order: editConn?.order
    }
  }

  const validate = (): boolean => {
    if (!path.trim()) {
      setError(t('serial.error.portRequired'))
      return false
    }
    const baud = Number(baudRate)
    if (!Number.isFinite(baud) || baud <= 0) {
      setError(t('serial.error.baudInvalid'))
      return false
    }
    return true
  }

  const handleSaveOnly = async (): Promise<void> => {
    if (!validate()) return
    await upsertConnection(buildConfig())
    onClose()
  }

  const handleConnect = async (): Promise<void> => {
    if (!validate()) return
    setError('')
    setConnecting(true)
    const err = await connectSerial(buildOpts(), {
      title: name.trim() || undefined,
      deviceKind
    })
    setConnecting(false)
    if (err) {
      setError(err)
      return
    }
    if (remember || isEditing) await upsertConnection(buildConfig())
    onClose()
  }

  const markTouched = (): void => setTouched(true)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          {isEditing ? t('serial.editTitle') : t('serial.newTitle')}
        </div>
        <div className="modal-body">
          <div className="field">
            <label>{t('connect.name')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="esp32-devkit"
            />
          </div>

          <div className="field-row">
            <div className="field" style={{ flex: 3 }}>
              <label>{t('serial.port')}</label>
              <select
                value={path}
                onChange={(e) => {
                  // A new port means a new board, so let its defaults apply again.
                  setTouched(false)
                  setPath(e.target.value)
                }}
              >
                <option value="">{t('serial.selectPort')}</option>
                {ports.map((p) => (
                  <option key={p.path} value={p.path}>
                    {serialOptionLabel(p)}
                  </option>
                ))}
                {/* Keep a saved port selectable while the device is unplugged. */}
                {path && !ports.some((p) => p.path === path) && (
                  <option value={path}>{path}</option>
                )}
              </select>
            </div>
            <div className="field" style={{ flex: 0 }}>
              <label>&nbsp;</label>
              <button onClick={() => void refreshPorts()} title={t('serial.refresh')}>
                <UiIcon name="refresh" size="sm" />
              </button>
            </div>
          </div>

          {listError && <div className="error-text">{listError}</div>}

          {/*
            An empty list is the normal case in WSL, which cannot see Windows COM
            ports at all, so it needs an explanation rather than looking broken.
          */}
          {!listing && !listError && ports.length === 0 && (
            <div className="hint-text">{t('serial.noPorts')}</div>
          )}

          {identity && (
            <div className="hint-text">
              {identity.ambiguous
                ? t('serial.detectedAmbiguous', { chip: identity.label })
                : t('serial.detected', { device: identity.label })}
            </div>
          )}

          <div className="field-row">
            <div className="field" style={{ flex: 2 }}>
              <label>{t('serial.baudRate')}</label>
              <select
                value={
                  SERIAL_BAUD_PRESETS.some((b) => String(b) === baudRate) ? baudRate : '__custom__'
                }
                onChange={(e) => {
                  if (e.target.value === '__custom__') return
                  markTouched()
                  setBaudRate(e.target.value)
                }}
              >
                {SERIAL_BAUD_PRESETS.map((b) => (
                  <option key={b} value={String(b)}>
                    {b}
                    {b === 74880 ? ` — ${t('serial.baudRomBootloader')}` : ''}
                  </option>
                ))}
                <option value="__custom__">{t('serial.baudCustom')}</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{t('serial.baudCustom')}</label>
              <input
                value={baudRate}
                onChange={(e) => {
                  markTouched()
                  setBaudRate(e.target.value.replace(/[^\d]/g, ''))
                }}
                inputMode="numeric"
              />
            </div>
          </div>

          {/*
            DTR and RTS are the two settings whose wrong value produces silence
            rather than an error, so they stay above the advanced fold with the
            reason attached.
          */}
          <div className="field">
            <label>{t('serial.signals')}</label>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label style={checkboxStyle}>
                <input
                  type="checkbox"
                  checked={dtr}
                  onChange={(e) => {
                    markTouched()
                    setDtr(e.target.checked)
                  }}
                  style={{ width: 'auto' }}
                />
                DTR
              </label>
              <label style={checkboxStyle}>
                <input
                  type="checkbox"
                  checked={rts}
                  onChange={(e) => {
                    markTouched()
                    setRts(e.target.checked)
                  }}
                  style={{ width: 'auto' }}
                />
                RTS
              </label>
            </div>
            <div className="hint-text">{t('serial.signalsHint')}</div>
          </div>

          <div className="field-row">
            <div className="field" style={{ flex: 1 }}>
              <label>{t('serial.newline')}</label>
              <select
                value={newline}
                onChange={(e) => {
                  markTouched()
                  setNewline(e.target.value as SerialNewline)
                }}
              >
                {NEWLINES.map((n) => (
                  <option key={n} value={n}>
                    {t(`serial.newline.${n}` as 'serial.newline.cr')}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: 1, justifyContent: 'flex-end' }}>
              <label style={checkboxStyle}>
                <input
                  type="checkbox"
                  checked={echo}
                  onChange={(e) => setEcho(e.target.checked)}
                  style={{ width: 'auto' }}
                />
                {t('serial.echo')}
              </label>
              <div className="hint-text">{t('serial.echoHint')}</div>
            </div>
          </div>

          <button
            className="link-btn"
            onClick={() => setAdvanced((v) => !v)}
            style={{ alignSelf: 'flex-start' }}
          >
            {advanced ? t('serial.hideAdvanced') : t('serial.showAdvanced')}
          </button>

          {advanced && (
            <div className="field-row">
              <div className="field" style={{ flex: 1 }}>
                <label>{t('serial.dataBits')}</label>
                <select value={dataBits} onChange={(e) => setDataBits(Number(e.target.value))}>
                  {DATA_BITS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>{t('serial.stopBits')}</label>
                <select value={stopBits} onChange={(e) => setStopBits(Number(e.target.value))}>
                  {STOP_BITS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>{t('serial.parity')}</label>
                <select value={parity} onChange={(e) => setParity(e.target.value)}>
                  {PARITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: 1, justifyContent: 'flex-end' }}>
                <label style={checkboxStyle}>
                  <input
                    type="checkbox"
                    checked={rtscts}
                    onChange={(e) => setRtscts(e.target.checked)}
                    style={{ width: 'auto' }}
                  />
                  {t('serial.rtscts')}
                </label>
              </div>
            </div>
          )}

          {!isEditing && (
            <label style={checkboxStyle}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                style={{ width: 'auto' }}
              />
              {t('serial.saveDevice')}
            </label>
          )}

          {(remember || isEditing) && (
            <div className="field">
              <label>{t('connect.group')}</label>
              <select
                value={parentId ?? ''}
                onChange={(e) => setParentId(e.target.value || null)}
              >
                {folderOptions.map((o) => (
                  <option key={o.id ?? '__root__'} value={o.id ?? ''}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.cancel')}</button>
          {isEditing && (
            <button onClick={() => void handleSaveOnly()}>{t('common.saveOnly')}</button>
          )}
          <button
            className="primary"
            onClick={() => void handleConnect()}
            disabled={connecting || !path.trim()}
          >
            {connecting ? t('common.connecting') : t('common.connect')}
          </button>
        </div>
      </div>
    </div>
  )
}

const checkboxStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13
} as const

/** `/dev/ttyUSB0 — CP2102 USB-UART`, so a hub of boards is tellable apart. */
function serialOptionLabel(port: SerialPortInfo): string {
  const identity = identifySerialDevice(port)
  const detail = identity.chip || port.friendlyName || port.manufacturer
  return detail ? `${port.path} — ${detail}` : port.path
}
