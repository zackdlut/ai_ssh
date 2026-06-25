import { useEffect, useState } from 'react'
import { useTabsStore } from '../../store/tabsStore'
import type { ConnectionConfig } from '../../../shared/types'

interface Props {
  onClose: () => void
}

type AuthMode = 'password' | 'key'

export default function ConnectModal({ onClose }: Props): JSX.Element {
  const addTab = useTabsStore((s) => s.addTab)

  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [authMode, setAuthMode] = useState<AuthMode>('password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [saved, setSaved] = useState<ConnectionConfig[]>([])

  useEffect(() => {
    void window.api.config.getConnections().then(setSaved)
  }, [])

  const loadSaved = (c: ConnectionConfig): void => {
    setName(c.name)
    setHost(c.host)
    setPort(String(c.port))
    setUsername(c.username)
    if (c.privateKey) {
      setAuthMode('key')
      setPrivateKey(c.privateKey)
      setPassphrase(c.passphrase ?? '')
    } else {
      setAuthMode('password')
      setPassword(c.password ?? '')
    }
  }

  const deleteSaved = async (e: React.MouseEvent, id: string): Promise<void> => {
    e.stopPropagation()
    setSaved(await window.api.config.deleteConnection(id))
  }

  const handleConnect = async (): Promise<void> => {
    setError('')
    if (!host || !username) {
      setError('Host and username are required.')
      return
    }
    setConnecting(true)
    const opts = {
      host,
      port: Number(port) || 22,
      username,
      password: authMode === 'password' ? password : undefined,
      privateKey: authMode === 'key' ? privateKey : undefined,
      passphrase: authMode === 'key' ? passphrase : undefined
    }
    const result = await window.api.ssh.connect(opts)
    setConnecting(false)

    if (result.error || !result.sessionId) {
      setError(result.error ?? 'Failed to connect.')
      return
    }

    const title = name || `${username}@${host}`
    addTab({
      id: result.sessionId,
      sessionId: result.sessionId,
      title,
      status: 'connected',
      host,
      username
    })

    if (remember) {
      const conn: ConnectionConfig = {
        id: `${username}@${host}:${port}`,
        name: title,
        host,
        port: Number(port) || 22,
        username,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        passphrase: authMode === 'key' ? passphrase : undefined
      }
      void window.api.config.saveConnection(conn)
    }

    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">New SSH Connection</div>
        <div className="modal-body">
          {saved.length > 0 && (
            <div className="field">
              <label>Saved connections</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {saved.map((c) => (
                  <button key={c.id} onClick={() => loadSaved(c)} title="Load">
                    {c.name}
                    <span
                      onClick={(e) => deleteSaved(e, c.id)}
                      style={{ marginLeft: 8, color: 'var(--danger)' }}
                    >
                      ×
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="field">
            <label>Name (optional)</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" />
          </div>

          <div className="field-row">
            <div className="field" style={{ flex: 3 }}>
              <label>Host</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Port</label>
              <input value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
          </div>

          <div className="field">
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
          </div>

          <div className="seg">
            <button
              className={authMode === 'password' ? 'active' : ''}
              onClick={() => setAuthMode('password')}
            >
              Password
            </button>
            <button className={authMode === 'key' ? 'active' : ''} onClick={() => setAuthMode('key')}>
              Private Key
            </button>
          </div>

          {authMode === 'password' ? (
            <div className="field">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          ) : (
            <>
              <div className="field">
                <label>Private key (file path or contents)</label>
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  style={{ minHeight: 60, resize: 'vertical' }}
                />
              </div>
              <div className="field">
                <label>Passphrase (optional)</label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </div>
            </>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              style={{ width: 'auto' }}
            />
            Save this connection locally
          </label>

          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={handleConnect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
