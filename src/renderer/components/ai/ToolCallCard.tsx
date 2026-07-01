import { useEffect, useRef, useState } from 'react'
import { approveToolCall, rejectToolCall } from '../../lib/aiService'
import { isDangerous } from '../../lib/commands'
import { isDangerousTool } from '../../../shared/aiTools'
import { useT, type TranslationKey } from '../../lib/i18n'
import { useAIStore } from '../../store/aiStore'
import AppSettingsToolPanel from './AppSettingsToolPanel'
import type { ToolCallView } from '../../../shared/types'

interface Props {
  tabId: string
  messageId: string
  call: ToolCallView
}

const SECRET_KEYS = new Set(['password', 'privateKey', 'passphrase', 'apiKey'])

type ToolCategory = 'connection' | 'config' | 'command' | 'settings' | 'read'

const TOOL_CATEGORY: Record<string, ToolCategory> = {
  open_ssh: 'connection',
  close_tab: 'connection',
  close_tabs: 'connection',
  list_open_tabs: 'read',
  create_ssh_config: 'config',
  update_ssh_config: 'config',
  create_folder: 'config',
  move_connection_to_folder: 'config',
  list_ssh_configs: 'read',
  list_folders: 'read',
  exec_command: 'command',
  get_app_settings: 'settings',
  update_app_settings: 'settings'
}

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

function ToolGlyph({ category }: { category: ToolCategory }): JSX.Element {
  return (
    <span className={`tool-glyph tool-glyph--${category}`} aria-hidden>
      {category === 'connection' && (
        <svg viewBox="0 0 20 20" fill="none">
          <rect x="3" y="4.5" width="14" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M6.2 9.2 5 10.5l1.2 1.3M8.2 12h4.8"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {category === 'config' && (
        <svg viewBox="0 0 20 20" fill="none">
          <path
            d="M6 4h8l1 2h2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2l1-2Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <circle cx="10" cy="11" r="2.2" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )}
      {category === 'command' && (
        <svg viewBox="0 0 20 20" fill="none">
          <path
            d="M5.5 7.5 3 10l2.5 2.5M8 14h6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {category === 'settings' && (
        <svg viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M10 3v1.6M10 15.4V17M3 10h1.6M15.4 10H17M5.05 5.05l1.13 1.13M13.82 13.82l1.13 1.13M5.05 14.95l1.13-1.13M13.82 6.18l1.13-1.13"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      )}
      {category === 'read' && (
        <svg viewBox="0 0 20 20" fill="none">
          <path
            d="M4 5.5h12M4 10h12M4 14.5h8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )}
    </span>
  )
}

function StatusPill({
  status,
  label
}: {
  status: ToolCallView['status']
  label: string
}): JSX.Element {
  return (
    <span className={`tool-call-status status-${status}`}>
      {(status === 'pending' || status === 'running') && (
        <span className="tool-status-dot" aria-hidden />
      )}
      {status === 'done' && (
        <svg className="tool-status-icon" viewBox="0 0 12 12" aria-hidden>
          <path
            d="M2.5 6.2 4.8 8.5 9.5 3.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {(status === 'error' || status === 'rejected') && (
        <svg className="tool-status-icon" viewBox="0 0 12 12" aria-hidden>
          <path
            d="M3.2 3.2 8.8 8.8M8.8 3.2 3.2 8.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )}
      <span>{label}</span>
    </span>
  )
}

function SectionLabel({ children }: { children: string }): JSX.Element {
  return <div className="tool-section-label">{children}</div>
}

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
            <span className="tool-list-index">{i + 1}</span>
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

function FolderListResult({ result }: { result?: string }): JSX.Element | null {
  const t = useT()
  const items = parseList(result)
  if (!items) return null
  if (items.length === 0) {
    return <div className="tool-list-empty">{t('tool.list.empty')}</div>
  }
  const nameById = new Map(items.map((it) => [String(it.folder_id ?? ''), String(it.name ?? '')]))
  return (
    <div className="tool-list">
      {items.map((item, i) => {
        const parentId = item.parent_folder_id ? String(item.parent_folder_id) : null
        const parentName = parentId ? nameById.get(parentId) : undefined
        return (
          <div className="tool-list-row" key={i}>
            <span className="tool-list-index">{i + 1}</span>
            <div className="tool-list-main">
              <span className="tool-list-title">{String(item.name ?? '—')}</span>
              <span className="tool-list-sub">
                {parentName ? `${t('tool.folder.parent')}: ${parentName}` : t('tool.folder.root')}
              </span>
            </div>
          </div>
        )
      })}
      <div className="tool-list-count">{t('tool.list.count', { count: items.length })}</div>
    </div>
  )
}

function FolderResultRow({
  name,
  obj
}: {
  name: string
  obj: Record<string, unknown>
}): JSX.Element {
  const t = useT()
  const title = String(obj.name ?? '—')
  let sub: string
  if (name === 'move_connection_to_folder') {
    const folderName = obj.folder_name ? String(obj.folder_name) : null
    sub = folderName ? `→ ${folderName}` : `→ ${t('tool.folder.root')}`
  } else {
    sub = obj.parent_folder_id ? t('tool.folder.parent') : t('tool.folder.root')
  }
  return (
    <div className="tool-list">
      <div className="tool-list-row tool-list-row--solo">
        <div className="tool-list-main">
          <span className="tool-list-title">{title}</span>
          <span className="tool-list-sub">{sub}</span>
        </div>
      </div>
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

function UpdateAppSettingsBody({
  initialUpdates,
  onDraftChange
}: {
  initialUpdates: Record<string, unknown>
  onDraftChange: (updates: Record<string, unknown>) => void
}): JSX.Element {
  const [draftUpdates, setDraftUpdates] = useState(initialUpdates)

  useEffect(() => {
    setDraftUpdates(initialUpdates)
  }, [initialUpdates])

  const handleChange = (updates: Record<string, unknown>): void => {
    setDraftUpdates(updates)
    onDraftChange(updates)
  }

  return (
    <AppSettingsToolPanel mode="edit" updates={draftUpdates} onUpdatesChange={handleChange} />
  )
}

function ConfigRow({ obj }: { obj: Record<string, unknown> }): JSX.Element {
  const t = useT()
  const user = obj.username ? `${String(obj.username)}@` : ''
  return (
    <div className="tool-list">
      <div className="tool-list-row tool-list-row--solo">
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

function paramLabel(t: (key: TranslationKey) => string, key: string): string {
  const map: Record<string, TranslationKey> = {
    config_id: 'tool.param.configId',
    tab_id: 'tool.param.tabId',
    tab_ids: 'tool.param.tabIds',
    host: 'tool.param.host',
    username: 'tool.param.username',
    port: 'tool.param.port',
    name: 'tool.param.name',
    command: 'tool.param.command',
    parent_folder_id: 'tool.param.parentFolderId',
    parent_folder_name: 'tool.param.parentFolderId',
    folder_id: 'tool.param.folderId',
    folder_name: 'tool.param.folderId',
    connection_name: 'tool.param.configId',
    all: 'tool.param.all',
    password: 'tool.param.password',
    privateKey: 'tool.param.privateKey',
    passphrase: 'tool.param.passphrase',
    updates: 'tool.param.updates'
  }
  return t(map[key] ?? (`tool.param.${key}` as TranslationKey))
}

function formatParamValue(key: string, value: unknown): string {
  if (SECRET_KEYS.has(key)) return '••••••'
  if (key === 'all') return value === true ? '✓' : '—'
  if (Array.isArray(value)) return value.map(String).join(', ')
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

function DetailGrid({
  rows
}: {
  rows: { key: string; label: string; value: string; mono?: boolean }[]
}): JSX.Element {
  return (
    <dl className="tool-detail-grid">
      {rows.map((row) => (
        <div className="tool-detail-row" key={row.key}>
          <dt>{row.label}</dt>
          <dd className={row.mono ? 'mono' : undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function expandArgs(args: Record<string, unknown>): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue
    if (key === 'updates' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subValue === undefined || subValue === null || subValue === '') continue
        entries.push({ [`updates.${subKey}`]: subValue })
      }
      continue
    }
    entries.push({ [key]: value })
  }
  return entries
}

function ParamRows({ args }: { args: Record<string, unknown> }): JSX.Element | null {
  const t = useT()
  const expanded = expandArgs(args)
  if (expanded.length === 0) return null

  const rows = expanded.flatMap((entry) => {
    const [rawKey, value] = Object.entries(entry)[0] ?? []
    if (!rawKey) return []
    const key = rawKey.replace(/^updates\./, '')
    const labelKey = rawKey.startsWith('updates.') ? key : rawKey
    return [
      {
        key: rawKey,
        label: paramLabel(t, labelKey),
        value: formatParamValue(key, value),
        mono: !SECRET_KEYS.has(key) && (key === 'host' || key === 'command' || key.includes('_id'))
      }
    ]
  })

  return <DetailGrid rows={rows} />
}

/** When output exceeds this, show collapsed viewport + expand control. */
const OUTPUT_COLLAPSE_CHARS = 800
const OUTPUT_COLLAPSE_LINES = 24

function LongTextOutput({ text }: { text: string }): JSX.Element {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const lineCount = text.split('\n').length
  const isLong = text.length > OUTPUT_COLLAPSE_CHARS || lineCount > OUTPUT_COLLAPSE_LINES

  return (
    <div
      className={`tool-output-wrap ${isLong ? (expanded ? 'is-expanded' : 'is-collapsed') : 'is-short'}`}
    >
      <div className="tool-output-scroll" tabIndex={isLong ? 0 : undefined}>
        <pre className="tool-output">{text}</pre>
      </div>
      {isLong && (
        <div className="tool-output-bar">
          <span className="tool-output-meta">
            {t('tool.output.meta', { lines: lineCount, chars: text.length })}
          </span>
          <button
            type="button"
            className="tool-output-toggle"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? t('tool.output.collapse') : t('tool.output.expand')}
          </button>
        </div>
      )}
    </div>
  )
}

function ToolResult({ name, result }: { name: string; result?: string }): JSX.Element | null {
  if (name === 'list_ssh_configs' || name === 'list_open_tabs') {
    return <ListResult name={name} result={result} />
  }
  if (name === 'list_folders') {
    return <FolderListResult result={result} />
  }
  if (!result) return null

  if (name === 'exec_command') {
    return <LongTextOutput text={result} />
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

  if ((name === 'create_folder' || name === 'move_connection_to_folder') && obj) {
    return <FolderResultRow name={name} obj={obj} />
  }

  if ((name === 'get_app_settings' || name === 'update_app_settings') && obj) {
    return <AppSettingsToolPanel mode="read" data={obj} />
  }

  if (result.length > OUTPUT_COLLAPSE_CHARS || result.split('\n').length > 1) {
    return <LongTextOutput text={result} />
  }

  return <div className="tool-result-line">{result}</div>
}

export default function ToolCallCard({ tabId, messageId, call }: Props): JSX.Element {
  const t = useT()
  const updateToolCall = useAIStore((s) => s.updateToolCall)
  const args = parseArgs(call.args)
  const command = call.name === 'exec_command' ? String(args.command ?? '') : null
  const dangerous =
    call.name === 'exec_command' ? isDangerous(command ?? '') : isDangerousTool(call.name)
  const pending = call.status === 'pending'
  const category = TOOL_CATEGORY[call.name] ?? 'read'
  const actionLabel = t(`tool.action.${call.name}` as TranslationKey)
  const descKey = `tool.desc.${call.name}` as TranslationKey
  const description = t(descKey)
  const [draftSettingsUpdates, setDraftSettingsUpdates] = useState<Record<string, unknown> | null>(
    null
  )
  const cardRef = useRef<HTMLDivElement>(null)

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

  const isListTool =
    call.name === 'list_ssh_configs' ||
    call.name === 'list_open_tabs' ||
    call.name === 'list_folders'
  const isSettingsReadTool = call.name === 'get_app_settings'
  const isSettingsUpdateTool = call.name === 'update_app_settings'
  const updates =
    isSettingsUpdateTool && args.updates && typeof args.updates === 'object'
      ? (args.updates as Record<string, unknown>)
      : null

  const hasBody =
    !isListTool &&
    !isSettingsReadTool &&
    (command !== null || updates !== null || Object.keys(args).length > 0)
  const hasResult = call.status === 'done' && Boolean(call.result)
  const showDetails = hasBody || (command !== null && Object.keys(args).length > 1)
  const isSettingsResult = call.name === 'get_app_settings' || call.name === 'update_app_settings'

  useEffect(() => {
    if (!pending) return
    const el = cardRef.current
    if (!el) return

    const revealIfClipped = (): void => {
      const list = el.closest('.chat-list')
      if (!list) return
      const cardRect = el.getBoundingClientRect()
      const listRect = list.getBoundingClientRect()
      if (cardRect.bottom > listRect.bottom - 10) {
        el.scrollIntoView({ behavior: 'smooth', block: 'end' })
      }
    }

    revealIfClipped()
    const observer = new ResizeObserver(revealIfClipped)
    observer.observe(el)
    return () => observer.disconnect()
  }, [pending])

  const handleApprove = (): void => {
    if (isSettingsUpdateTool) {
      const finalUpdates = draftSettingsUpdates ?? updates
      if (finalUpdates) {
        updateToolCall(tabId, messageId, call.id, {
          args: JSON.stringify({ updates: finalUpdates })
        })
      }
    }
    approveToolCall(tabId, messageId, call.id)
  }

  return (
    <div
      ref={cardRef}
      className={`command-card tool-call-card tool-cat-${category} ${dangerous ? 'danger' : ''} status-${call.status}`}
    >
      <div className="tool-call-head">
        <div className="tool-call-head-main">
          <ToolGlyph category={category} />
          <div className="tool-call-head-copy">
            <span className="tool-call-name">{actionLabel}</span>
            <span className="tool-call-desc">{description}</span>
          </div>
        </div>
        <StatusPill status={call.status} label={statusLabel} />
      </div>

      {showDetails && (
        <div className="tool-call-body">
          {hasBody && !isListTool && !isSettingsReadTool && (
            <>
              {!isSettingsUpdateTool && <SectionLabel>{t('tool.section.details')}</SectionLabel>}
              {command === null ? (
                updates ? (
                  <UpdateAppSettingsBody
                    initialUpdates={updates}
                    onDraftChange={setDraftSettingsUpdates}
                  />
                ) : (
                  <ParamRows args={args} />
                )
              ) : (
                <>
                  <ParamRows
                    args={Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'command'))}
                  />
                  <pre className="tool-command">{command}</pre>
                </>
              )}
            </>
          )}
        </div>
      )}

      {dangerous && pending && <div className="danger-banner">{t('tool.dangerHint')}</div>}

      {call.status === 'error' && call.error && (
        <div className="tool-call-error">{call.error}</div>
      )}

      {hasResult && (
        <div className="tool-call-result-block">
          {!isSettingsResult && <SectionLabel>{t('tool.section.result')}</SectionLabel>}
          <ToolResult name={call.name} result={call.result} />
        </div>
      )}

      {pending && (
        <div className="tool-approval-panel">
          <div className="tool-approval-copy">
            <span className="tool-approval-title">{t('tool.approvalTitle')}</span>
            <span className="tool-approval-hint">{t('tool.approvalHint')}</span>
          </div>
          <div className="tool-approval-actions">
            <button
              type="button"
              className="tool-btn-approve"
              onClick={handleApprove}
            >
              {t('tool.approve')}
            </button>
            <button
              type="button"
              className="tool-btn-reject"
              onClick={() => rejectToolCall(tabId, messageId, call.id)}
            >
              {t('tool.reject')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
