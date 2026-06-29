import { approveToolCall, rejectToolCall } from '../../lib/aiService'
import { isDangerousTool } from '../../../shared/aiTools'
import { useT, type TranslationKey } from '../../lib/i18n'
import type { ToolCallView } from '../../../shared/types'

interface Props {
  tabId: string
  messageId: string
  call: ToolCallView
}

const SECRET_KEYS = new Set(['password', 'privateKey', 'passphrase'])

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function parseList(raw?: string): Record<string, unknown>[] | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : null
  } catch {
    return null
  }
}

const TAB_STATUS_TONE: Record<string, string> = {
  connected: 'ok',
  connecting: 'warn',
  closed: 'muted',
  error: 'bad'
}

/**
 * Friendly rendering for the read-only list tools. The raw JSON is still fed
 * back to the model; this only changes what the user sees in the card.
 */
function ListResult({
  name,
  result
}: {
  name: string
  result?: string
}): JSX.Element | null {
  const t = useT()
  const items = parseList(result)
  if (!items) return null
  if (items.length === 0) {
    return <div className="tool-list-empty">{t('tool.list.empty')}</div>
  }

  return (
    <div className="tool-list">
      {items.map((item, i) => {
        const isConfig = name === 'list_ssh_configs'
        const title = String(item.name ?? item.title ?? item.host ?? '—')
        const user = item.username ? `${String(item.username)}@` : ''
        const sub = `${user}${String(item.host ?? '')}:${String(item.port ?? 22)}`
        const status = typeof item.status === 'string' ? item.status : undefined
        return (
          <div className="tool-list-row" key={i}>
            <div className="tool-list-main">
              <span className="tool-list-title">{title}</span>
              <span className="tool-list-sub">{sub}</span>
            </div>
            <div className="tool-list-tags">
              {isConfig && item.hasPassword === true && (
                <span className="tool-tag">{t('tool.auth.password')}</span>
              )}
              {isConfig && item.hasPrivateKey === true && (
                <span className="tool-tag">{t('tool.auth.key')}</span>
              )}
              {status && (
                <span className={`tool-tag status-${TAB_STATUS_TONE[status] ?? 'muted'}`}>
                  {status}
                </span>
              )}
            </div>
          </div>
        )
      })}
      <div className="tool-list-count">{t('tool.list.count', { count: items.length })}</div>
    </div>
  )
}

function parseObj(raw?: string): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function ConfigRow({ obj }: { obj: Record<string, unknown> }): JSX.Element {
  const t = useT()
  const user = obj.username ? `${String(obj.username)}@` : ''
  return (
    <div className="tool-list">
      <div className="tool-list-row">
        <div className="tool-list-main">
          <span className="tool-list-title">{String(obj.name ?? obj.host ?? '—')}</span>
          <span className="tool-list-sub">{`${user}${String(obj.host ?? '')}:${String(obj.port ?? 22)}`}</span>
        </div>
        <div className="tool-list-tags">
          {obj.hasPassword === true && <span className="tool-tag">{t('tool.auth.password')}</span>}
          {obj.hasPrivateKey === true && <span className="tool-tag">{t('tool.auth.key')}</span>}
        </div>
      </div>
    </div>
  )
}

/**
 * Human-friendly rendering of a completed tool result, replacing the raw JSON
 * blob. The full JSON is still what was fed back to the model.
 */
function ToolResult({ name, result }: { name: string; result?: string }): JSX.Element | null {
  if (name === 'list_ssh_configs' || name === 'list_open_tabs') {
    return <ListResult name={name} result={result} />
  }
  if (!result) return null

  if (name === 'exec_command') {
    return (
      <div className="tool-output-wrap">
        <pre className="tool-output">{result.slice(0, 8000)}</pre>
      </div>
    )
  }

  const obj = parseObj(result)

  if (name === 'open_ssh' && obj) {
    const user = obj.username ? `${String(obj.username)}@` : ''
    const status = typeof obj.status === 'string' ? obj.status : undefined
    return (
      <div className="tool-result-line">
        <span className="tool-result-target">{`${user}${String(obj.host ?? '')}`}</span>
        {status && (
          <span className={`tool-tag status-${TAB_STATUS_TONE[status] ?? 'muted'}`}>{status}</span>
        )}
      </div>
    )
  }

  if ((name === 'create_ssh_config' || name === 'update_ssh_config') && obj) {
    return <ConfigRow obj={obj} />
  }

  // close_tab returns a plain sentence; anything else falls back to plain text.
  return <div className="tool-result-line">{result}</div>
}

/** Render argument key/values, masking secrets and nesting `updates`. */
function ParamRows({ args }: { args: Record<string, unknown> }): JSX.Element | null {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (entries.length === 0) return null
  return (
    <dl className="tool-params">
      {entries.map(([key, value]) => {
        const display = SECRET_KEYS.has(key)
          ? '••••••'
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value)
        return (
          <div className="tool-param-row" key={key}>
            <dt>{key}</dt>
            <dd>{display}</dd>
          </div>
        )
      })}
    </dl>
  )
}

export default function ToolCallCard({ tabId, messageId, call }: Props): JSX.Element {
  const t = useT()
  const args = parseArgs(call.args)
  const dangerous = isDangerousTool(call.name)
  const pending = call.status === 'pending'
  const actionLabel = t(`tool.action.${call.name}` as TranslationKey)

  const statusLabel =
    call.status === 'running'
      ? t('tool.running')
      : call.status === 'done'
        ? t('tool.done')
        : call.status === 'rejected'
          ? t('tool.rejected')
          : call.status === 'error'
            ? t('tool.error')
            : t('tool.pending')

  const command = call.name === 'exec_command' ? String(args.command ?? '') : null
  const isListTool = call.name === 'list_ssh_configs' || call.name === 'list_open_tabs'

  return (
    <div className={`command-card tool-call-card ${dangerous ? 'danger' : ''} status-${call.status}`}>
      <div className="tool-call-head">
        <span className="tool-call-name">{actionLabel}</span>
        <span className={`tool-call-status status-${call.status}`}>{statusLabel}</span>
      </div>

      {!isListTool &&
        (command !== null ? (
          <pre className="tool-command">{command}</pre>
        ) : (
          <ParamRows args={args} />
        ))}
      {command !== null && (
        <ParamRows args={Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'command'))} />
      )}

      {dangerous && pending && <div className="danger-banner">{t('tool.dangerHint')}</div>}

      {call.status === 'error' && call.error && (
        <div className="tool-call-error">{call.error}</div>
      )}
      {call.status === 'done' && <ToolResult name={call.name} result={call.result} />}

      {pending && (
        <div className="cmd-actions">
          <button className="primary" onClick={() => approveToolCall(tabId, messageId, call.id)}>
            {t('tool.approve')}
          </button>
          <button onClick={() => rejectToolCall(tabId, messageId, call.id)}>
            {t('tool.reject')}
          </button>
        </div>
      )}
    </div>
  )
}
