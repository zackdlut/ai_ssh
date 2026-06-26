import { useMemo, useState } from 'react'
import { useBookmarksStore, type TreeNode } from '../../store/bookmarksStore'
import { connect } from '../../lib/connect'
import { useT } from '../../lib/i18n'
import type { ConnectionConfig } from '../../../shared/types'

interface Props {
  onClose: () => void
  /** When set, edit an existing saved connection instead of creating one. */
  editConn?: ConnectionConfig | null
  /** Default parent folder for a newly saved connection. */
  defaultParentId?: string | null
}

type AuthMode = 'password' | 'key'

interface FolderOption {
  id: string | null
  label: string
}

export default function ConnectModal({ onClose, editConn, defaultParentId }: Props): JSX.Element {
  const getTree = useBookmarksStore((s) => s.getTree)
  const upsertConnection = useBookmarksStore((s) => s.upsertConnection)
  const t = useT()

  const [name, setName] = useState(editConn?.name ?? '')
  const [host, setHost] = useState(editConn?.host ?? '')
  const [port, setPort] = useState(String(editConn?.port ?? 22))
  const [username, setUsername] = useState(editConn?.username ?? '')
  const [authMode, setAuthMode] = useState<AuthMode>(editConn?.privateKey ? 'key' : 'password')
  const [password, setPassword] = useState(editConn?.password ?? '')
  const [privateKey, setPrivateKey] = useState(editConn?.privateKey ?? '')
  const [passphrase, setPassphrase] = useState(editConn?.passphrase ?? '')
  const [remember, setRemember] = useState(Boolean(editConn))
  const [parentId, setParentId] = useState<string | null>(
    editConn?.parentId ?? defaultParentId ?? null
  )
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)

  const isEditing = Boolean(editConn)

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

  const buildConfig = (): ConnectionConfig => {
    const title = name || `${username}@${host}`
    return {
      id: editConn?.id ?? `${username}@${host}:${port}`,
      name: title,
      host,
      port: Number(port) || 22,
      username,
      password: authMode === 'password' ? password : undefined,
      privateKey: authMode === 'key' ? privateKey : undefined,
      passphrase: authMode === 'key' ? passphrase : undefined,
      parentId,
      order: editConn?.order
    }
  }

  const validate = (): boolean => {
    if (!host || !username) {
      setError(t('connect.error.hostRequired'))
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
    const title = name || `${username}@${host}`
    setError('')
    setConnecting(true)
    const err = await connect({
      opts: {
        host,
        port: Number(port) || 22,
        username,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        passphrase: authMode === 'key' ? passphrase : undefined
      },
      title
    })
    setConnecting(false)
    if (err) {
      setError(err)
      return
    }
    if (remember) await upsertConnection(buildConfig())
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{isEditing ? t('connect.editTitle') : t('connect.newTitle')}</div>
        <div className="modal-body">
          <div className="field">
            <label>{t('connect.name')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" />
          </div>

          <div className="field-row">
            <div className="field" style={{ flex: 3 }}>
              <label>{t('connect.host')}</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{t('connect.port')}</label>
              <input value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
          </div>

          <div className="field">
            <label>{t('connect.username')}</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
          </div>

          <div className="seg">
            <button
              className={authMode === 'password' ? 'active' : ''}
              onClick={() => setAuthMode('password')}
            >
              {t('connect.password')}
            </button>
            <button className={authMode === 'key' ? 'active' : ''} onClick={() => setAuthMode('key')}>
              {t('connect.privateKey')}
            </button>
          </div>

          {authMode === 'password' ? (
            <div className="field">
              <label>{t('connect.password')}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          ) : (
            <>
              <div className="field">
                <label>{t('connect.privateKeyLabel')}</label>
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  style={{ minHeight: 60, resize: 'vertical' }}
                />
              </div>
              <div className="field">
                <label>{t('connect.passphrase')}</label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </div>
            </>
          )}

          {!isEditing && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                style={{ width: 'auto' }}
              />
              {t('connect.saveLocally')}
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
          <button className="primary" onClick={() => void handleConnect()} disabled={connecting}>
            {connecting
              ? t('common.connecting')
              : isEditing
                ? t('connect.saveAndConnect')
                : t('common.connect')}
          </button>
        </div>
      </div>
    </div>
  )
}
