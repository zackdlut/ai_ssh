import { useEffect, useMemo, useState } from 'react'
import { useBookmarksStore, type TreeNode } from '../../store/bookmarksStore'
import { connectLocal } from '../../lib/connect'
import { useT } from '../../lib/i18n'
import type { ConnectionConfig, LocalShellInfo } from '../../../shared/types'
import UiIcon from '../UiIcon'

interface Props {
  onClose: () => void
  /** When set, edit an existing saved local shell instead of creating one. */
  editConn?: ConnectionConfig | null
  defaultParentId?: string | null
}

interface FolderOption {
  id: string | null
  label: string
}

/**
 * Save a shell on this machine as a bookmark.
 *
 * Much shorter than the serial dialog because there is almost nothing to get
 * wrong: no baud rate, no flow control, no board to guess at. The two things
 * worth recording are which shell and where it starts, and both have a working
 * default — so this is really a naming dialog with two overrides attached.
 */
export default function LocalShellModal({
  onClose,
  editConn,
  defaultParentId
}: Props): JSX.Element {
  const getTree = useBookmarksStore((s) => s.getTree)
  const upsertConnection = useBookmarksStore((s) => s.upsertConnection)
  const t = useT()

  const saved = editConn?.local
  const [shells, setShells] = useState<LocalShellInfo[]>([])
  const [name, setName] = useState(editConn?.name ?? '')
  const [shell, setShell] = useState(saved?.shell ?? '')
  const [cwd, setCwd] = useState(saved?.cwd ?? '')
  const [parentId, setParentId] = useState<string | null>(
    editConn?.parentId ?? defaultParentId ?? null
  )
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)

  const isEditing = Boolean(editConn)

  useEffect(() => {
    void window.api.localShell.list().then(setShells)
  }, [])

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

  const shellName = (path: string): string =>
    path.replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/i, '') ?? path

  const buildConfig = (): ConnectionConfig => ({
    id: editConn?.id ?? `local:${crypto.randomUUID()}`,
    name: name.trim() || (shell ? shellName(shell) : t('localShell.title')),
    kind: 'local',
    // Nothing to dial: this entry names a shell, not a machine.
    host: '',
    port: 0,
    username: '',
    local: { shell: shell || undefined, cwd: cwd.trim() || undefined },
    parentId,
    order: editConn?.order
  })

  const browseCwd = async (): Promise<void> => {
    const res = await window.api.local.pickDirectory(cwd || undefined)
    if (res.path) setCwd(res.path)
  }

  const handleSaveOnly = async (): Promise<void> => {
    await upsertConnection(buildConfig())
    onClose()
  }

  const handleConnect = async (): Promise<void> => {
    setError('')
    setConnecting(true)
    const config = buildConfig()
    const err = await connectLocal(
      { shell: shell || undefined, cwd: cwd.trim() || undefined },
      { title: config.name, connectionId: config.id }
    )
    setConnecting(false)
    if (err) {
      setError(err)
      return
    }
    await upsertConnection(config)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{t('localShell.title')}</div>
        <div className="modal-body">
          <div className="field">
            <label>{t('localShell.name')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('localShell.namePlaceholder')}
            />
          </div>

          <div className="field">
            <label>{t('localShell.shell')}</label>
            <select value={shell} onChange={(e) => setShell(e.target.value)}>
              <option value="">{t('localShell.shellDefault')}</option>
              {shells.map((s) => (
                <option key={s.path} value={s.path}>
                  {s.name} — {s.path}
                </option>
              ))}
              {/* Keep a saved shell selectable after it has been uninstalled. */}
              {shell && !shells.some((s) => s.path === shell) && (
                <option value={shell}>{shell}</option>
              )}
            </select>
          </div>

          <div className="field-row">
            <div className="field" style={{ flex: 3 }}>
              <label>{t('localShell.cwd')}</label>
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={t('localShell.cwdPlaceholder')}
              />
            </div>
            <div className="field" style={{ flex: 0 }}>
              <label>&nbsp;</label>
              <button onClick={() => void browseCwd()} title={t('localShell.browse')}>
                <UiIcon name="folder" size="sm" />
              </button>
            </div>
          </div>

          <div className="field">
            <label>{t('connect.group')}</label>
            <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || null)}>
              {folderOptions.map((o) => (
                <option key={o.id ?? '__root__'} value={o.id ?? ''}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button onClick={() => void handleSaveOnly()}>
            {isEditing ? t('common.saveOnly') : t('localShell.save')}
          </button>
          <button className="primary" onClick={() => void handleConnect()} disabled={connecting}>
            {connecting ? t('common.connecting') : t('localShell.saveAndOpen')}
          </button>
        </div>
      </div>
    </div>
  )
}
