import { useState } from 'react'
import { useTabsStore } from '../../store/tabsStore'
import { isDangerous } from '../../lib/commands'

interface Props {
  command: string
}

export default function CommandCard({ command }: Props): JSX.Element {
  const [value, setValue] = useState(command)
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId))

  const dangerous = isDangerous(value)

  const run = (): void => {
    if (!activeTab) {
      window.alert('No active terminal. Connect to a host first.')
      return
    }
    if (dangerous) {
      const ok = window.confirm(
        `This command looks destructive:\n\n${value}\n\nRun it on ${activeTab.username}@${activeTab.host}?`
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
      {dangerous && <div className="danger-banner">⚠ Potentially destructive — review before running.</div>}
      <div className="cmd-actions">
        <button className="primary" onClick={run} title={`Run on ${activeTab?.title ?? 'terminal'}`}>
          Run
        </button>
        <button onClick={() => setEditing((v) => !v)}>{editing ? 'Done' : 'Edit'}</button>
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  )
}
