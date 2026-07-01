import { useState } from 'react'
import { useTabsStore } from '../../store/tabsStore'
import { isDangerous } from '../../lib/commands'
import { useT } from '../../lib/i18n'

interface Props {
  command: string
}

export default function CommandCard({ command }: Props): JSX.Element {
  const [value, setValue] = useState(command)
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const t = useT()

  const dangerous = isDangerous(value)

  const run = (): void => {
    if (!activeTab?.sessionId || activeTab.status !== 'connected') {
      window.alert(t('cmd.noTerminal'))
      return
    }
    if (dangerous) {
      const ok = window.confirm(
        t('cmd.dangerConfirm', {
          command: value,
          host: `${activeTab.username}@${activeTab.host}`
        })
      )
      if (!ok) return
    }
    window.api.ssh.write(activeTab.sessionId, value.trim() + '\n')
  }

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className={`command-card ${dangerous ? 'danger' : ''}`}>
      {editing ? (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ border: 'none', borderRadius: 0, minHeight: 60 }}
        />
      ) : (
        <pre>{value}</pre>
      )}
      {dangerous && <div className="danger-banner">{t('cmd.dangerBanner')}</div>}
      <div className="cmd-actions">
        <button
          className="primary"
          onClick={run}
          title={t('cmd.runOn', { target: activeTab?.title ?? t('cmd.terminal') })}
        >
          {t('cmd.run')}
        </button>
        <button onClick={() => setEditing((v) => !v)}>{editing ? t('cmd.done') : t('cmd.edit')}</button>
        <button onClick={copy}>{copied ? t('cmd.copied') : t('cmd.copy')}</button>
      </div>
    </div>
  )
}
