import { useState } from 'react'
import { approveToolCall, rejectToolCall } from '../../lib/aiService'
import { isDangerousTool } from '../../../shared/aiTools'
import {
  modelProfileLabel,
  terminalFontWeightLabel,
  terminalSchemeLabel,
  themeMeta,
  useT,
  type TranslationKey
} from '../../lib/i18n'
import { useLocaleStore } from '../../store/localeStore'
import type { AppLocale, AppTheme, ModelProfile } from '../../../shared/types'
import type {
  TerminalColorSchemeId,
  TerminalFontWeight
} from '../../../shared/terminalSettings'
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
  list_ssh_configs: 'read',
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

function formatSettingValue(
  locale: AppLocale,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
  key: string,
  value: unknown
): string {
  if (SECRET_KEYS.has(key)) return '••••••'
  if (key === 'theme' && (value === 'aurora' || value === 'dawn')) {
    return themeMeta(locale, value as AppTheme).label
  }
  if (key === 'locale' && (value === 'zh' || value === 'en')) {
    return t(value === 'zh' ? 'language.zh' : 'language.en')
  }
  if (key === 'colorScheme' && typeof value === 'string') {
    return terminalSchemeLabel(locale, value as TerminalColorSchemeId)
  }
  if (key === 'fontWeight' && typeof value === 'string') {
    return terminalFontWeightLabel(locale, value as TerminalFontWeight)
  }
  if ((key === 'copilotModelProfile' || key === 'nlModelProfile') && typeof value === 'string') {
    return modelProfileLabel(locale, value as ModelProfile)
  }
  if (key === 'hasApiKey') return value === true ? t('tool.settings.hasApiKey') : '—'
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

function settingsLabel(t: (key: TranslationKey) => string, key: string): string {
  const map: Record<string, TranslationKey> = {
    theme: 'tool.settings.theme',
    locale: 'tool.settings.locale',
    terminal_appearance: 'tool.settings.terminal',
    ai: 'tool.settings.ai',
    baseURL: 'tool.settings.baseURL',
    apiKey: 'tool.settings.apiKey',
    hasApiKey: 'tool.settings.hasApiKey',
    copilotModelProfile: 'tool.settings.copilotModelProfile',
    nlModelProfile: 'tool.settings.nlModelProfile',
    models: 'tool.settings.models',
    contextLengths: 'tool.settings.contextLengths',
    colorScheme: 'tool.settings.colorScheme',
    fontFamily: 'tool.settings.fontFamily',
    fontSize: 'tool.settings.fontSize',
    lineHeight: 'tool.settings.lineHeight',
    fontWeight: 'tool.settings.fontWeight'
  }
  return t(map[key] ?? (`tool.settings.${key}` as TranslationKey))
}

function flattenSettingsRows(
  obj: Record<string, unknown>,
  prefix = ''
): { key: string; labelKey: string; value: unknown; section: 'ui' | 'terminal' | 'ai' | 'other' }[] {
  const rows: {
    key: string
    labelKey: string
    value: unknown
    section: 'ui' | 'terminal' | 'ai' | 'other'
  }[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === '') continue
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (key === 'terminal_appearance') {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        rows.push(...flattenSettingsRows(value as Record<string, unknown>, fullKey))
      }
      continue
    }
    if (key === 'ai') {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        rows.push(...flattenSettingsRows(value as Record<string, unknown>, fullKey))
      }
      continue
    }
    if (
      (key === 'models' || key === 'contextLengths') &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      rows.push(...flattenSettingsRows(value as Record<string, unknown>, fullKey))
      continue
    }

    let section: 'ui' | 'terminal' | 'ai' | 'other' = 'other'
    if (key === 'theme' || key === 'locale') section = 'ui'
    else if (
      key === 'colorScheme' ||
      key === 'fontFamily' ||
      key === 'fontSize' ||
      key === 'lineHeight' ||
      key === 'fontWeight' ||
      fullKey.includes('terminal_appearance')
    ) {
      section = 'terminal'
    } else if (
      fullKey.startsWith('ai.') ||
      key === 'baseURL' ||
      key === 'apiKey' ||
      key === 'hasApiKey' ||
      key === 'copilotModelProfile' ||
      key === 'nlModelProfile'
    ) {
      section = 'ai'
    }

    rows.push({ key: fullKey, labelKey: key, value, section })
  }
  return rows
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

function SettingsRows({ data }: { data: Record<string, unknown> }): JSX.Element {
  const t = useT()
  const locale = useLocaleStore((s) => s.locale)
  const flat = flattenSettingsRows(data)
  if (flat.length === 0) return <div className="tool-list-empty">{t('tool.list.empty')}</div>

  const profileKeys = new Set(['default', 'fast', 'medium', 'high', 'custom'])
  const sections: { id: 'ui' | 'terminal' | 'ai' | 'other'; label: TranslationKey }[] = [
    { id: 'ui', label: 'tool.section.ui' },
    { id: 'terminal', label: 'tool.section.terminal' },
    { id: 'ai', label: 'tool.section.ai' }
  ]

  return (
    <div className="tool-settings-groups">
      {sections.map((section) => {
        const rows = flat.filter((r) => r.section === section.id)
        if (rows.length === 0) return null
        return (
          <div className="tool-settings-group" key={section.id}>
            <SectionLabel>{t(section.label)}</SectionLabel>
            <DetailGrid
              rows={rows.map((row) => {
                const isModelTier =
                  profileKeys.has(row.labelKey) &&
                  (row.key.includes('.models.') || row.key.includes('.contextLengths.'))
                const label = isModelTier
                  ? modelProfileLabel(locale, row.labelKey as ModelProfile)
                  : settingsLabel(t, row.labelKey)
                return {
                  key: row.key,
                  label,
                  value: formatSettingValue(locale, t, row.labelKey, row.value),
                  mono: row.labelKey === 'baseURL' || row.labelKey === 'fontFamily'
                }
              })}
            />
          </div>
        )
      })}
    </div>
  )
}

function SettingsParamRows({ updates }: { updates: Record<string, unknown> }): JSX.Element {
  return <SettingsRows data={updates} />
}

function SettingsResult({ result }: { result?: string }): JSX.Element | null {
  const obj = parseObj(result)
  if (!obj) return null
  return <SettingsRows data={obj} />
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

  if ((name === 'get_app_settings' || name === 'update_app_settings') && obj) {
    return <SettingsResult result={result} />
  }

  if (result.length > OUTPUT_COLLAPSE_CHARS || result.split('\n').length > 1) {
    return <LongTextOutput text={result} />
  }

  return <div className="tool-result-line">{result}</div>
}

export default function ToolCallCard({ tabId, messageId, call }: Props): JSX.Element {
  const t = useT()
  const args = parseArgs(call.args)
  const dangerous = isDangerousTool(call.name)
  const pending = call.status === 'pending'
  const category = TOOL_CATEGORY[call.name] ?? 'read'
  const actionLabel = t(`tool.action.${call.name}` as TranslationKey)
  const descKey = `tool.desc.${call.name}` as TranslationKey
  const description = t(descKey)

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
  const isSettingsReadTool = call.name === 'get_app_settings'
  const updates =
    call.name === 'update_app_settings' && args.updates && typeof args.updates === 'object'
      ? (args.updates as Record<string, unknown>)
      : null

  const hasBody =
    !isListTool &&
    !isSettingsReadTool &&
    (command !== null || updates !== null || Object.keys(args).length > 0)
  const hasResult = call.status === 'done' && Boolean(call.result)
  const showDetails = hasBody || (command !== null && Object.keys(args).length > 1)

  return (
    <div
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
              <SectionLabel>{t('tool.section.details')}</SectionLabel>
              {command === null ? (
                updates ? (
                  <SettingsParamRows updates={updates} />
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
          <SectionLabel>{t('tool.section.result')}</SectionLabel>
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
              onClick={() => approveToolCall(tabId, messageId, call.id)}
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
