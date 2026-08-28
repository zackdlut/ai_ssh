import { useEffect, useRef } from 'react'
import type { TerminalSession } from '../../store/sessionsStore'
import { mentionTokenFor } from '../../lib/pinnedTerminal'
import { useT } from '../../lib/i18n'

interface Props {
  tabs: TerminalSession[]
  /** Unique `@` tokens by terminal id, derived from the whole mentionable list. */
  tokens: ReadonlyMap<string, string>
  activeSessionId: string | null
  pinnedTabId?: string
  highlightIndex: number
  emptyLabel: string
  onHighlight: (index: number) => void
  onSelect: (tabId: string) => void
  footer?: JSX.Element | null
}

const DEFAULT_SSH_PORT = 22

/**
 * Who the session is connected as, spelled out.
 *
 * Two rows on one host are only telling apart by what differs between them, so
 * this stays literal — no custom title standing in for the account — and keeps
 * the port whenever it is not the one everybody assumes.
 */
function connectionIdentity(tab: TerminalSession): string {
  if (tab.kind === 'wsl') return tab.wslDistro || tab.title || 'WSL'
  if (!tab.host) return tab.title || ''
  const user = tab.username ? `${tab.username}@` : ''
  const port = tab.port && tab.port !== DEFAULT_SSH_PORT ? `:${tab.port}` : ''
  return `${user}${tab.host}${port}`
}

/** The name the user or the saved connection gave this session, if it has one. */
function connectionName(tab: TerminalSession): string {
  return (tab.customTitle?.trim() || tab.title?.trim()) ?? ''
}

export default function TerminalTabPicker({
  tabs,
  tokens,
  activeSessionId,
  pinnedTabId,
  highlightIndex,
  emptyLabel,
  onHighlight,
  onSelect,
  footer
}: Props): JSX.Element {
  const t = useT()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-picker-index="${highlightIndex}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  return (
    <div className="mention-menu" role="listbox" aria-label={t('copilot.pickTerminal')}>
      <div className="mention-list" ref={listRef}>
        {tabs.length === 0 ? (
          <button type="button" className="mention-item" disabled>
            <span className="mention-name">{emptyLabel}</span>
          </button>
        ) : (
          tabs.map((tab, index) => {
            const token = tokens.get(tab.id) ?? mentionTokenFor(tab)
            const identity = connectionIdentity(tab)
            const name = connectionName(tab)
            const isActive = tab.id === activeSessionId
            const isPinned = tab.id === pinnedTabId
            const selected = index === highlightIndex
            const tags = [
              identity && identity !== token ? identity : null,
              name && name !== identity && name !== token ? name : null,
              isActive ? t('copilot.mentionActive') : null,
              isPinned ? t('copilot.mentionPinned') : null,
              tab.status
            ].filter(Boolean)
            return (
              <button
                key={tab.id}
                type="button"
                role="option"
                data-picker-index={index}
                aria-selected={selected}
                className={`mention-item${selected ? ' is-active' : ''}`}
                onMouseEnter={() => onHighlight(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(tab.id)}
              >
                <span className="mention-name">@{token}</span>
                <span className="mention-desc">{tags.join(' · ')}</span>
              </button>
            )
          })
        )}
      </div>
      {footer}
    </div>
  )
}
