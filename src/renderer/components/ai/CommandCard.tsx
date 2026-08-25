import { useState } from 'react'
import { useSessionsStore } from '../../store/sessionsStore'
import { isDangerous } from '../../lib/commands'
import { useT } from '../../lib/i18n'
import { debugLog } from '../../lib/debugLog'
import LinkifiedText from './LinkifiedText'

interface Props {
  command: string
}

export default function CommandCard({ command }: Props): JSX.Element {
  const [value, setValue] = useState(command)
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const activeSession = useSessionsStore((s) => s.sessions.find((t) => t.id === s.activeSessionId))
  const t = useT()

  const dangerous = isDangerous(value)

  const run = (): void => {
    if (!activeSession?.sessionId || activeSession.status !== 'connected') {
      window.alert(t('cmd.noTerminal'))
      return
    }
    if (dangerous) {
      const ok = window.confirm(
        t('cmd.dangerConfirm', {
          command: value,
          host: `${activeSession.username}@${activeSession.host}`
        })
      )
      if (!ok) return
    }
    debugLog({
      category: 'user.action',
      tabId: activeSession.id,
      sessionId_ssh: activeSession.sessionId,
      message: 'commandCard.run',
      data: { command: value.trim() }
    })
    window.api.ssh.write(activeSession.sessionId, value.trim() + '\n')
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
        <pre>
          <LinkifiedText text={value} />
        </pre>
      )}
      {dangerous && <div className="danger-banner">{t('cmd.dangerBanner')}</div>}
      <div className="cmd-actions">
        <button
          className="primary"
          onClick={run}
          title={t('cmd.runOn', { target: activeSession?.title ?? t('cmd.terminal') })}
        >
          {t('cmd.run')}
        </button>
        <button onClick={() => setEditing((v) => !v)}>{editing ? t('cmd.done') : t('cmd.edit')}</button>
        <button onClick={copy}>{copied ? t('cmd.copied') : t('cmd.copy')}</button>
      </div>
    </div>
  )
}
