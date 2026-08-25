import { useEffect, useRef } from 'react'
import type { TerminalSession } from '../../store/sessionsStore'
import { formatTerminalLabel, mentionTokenFor } from '../../lib/pinnedTerminal'
import { useT } from '../../lib/i18n'

interface Props {
  tabs: TerminalSession[]
  activeSessionId: string | null
  pinnedTabId?: string
  highlightIndex: number
  emptyLabel: string
  onHighlight: (index: number) => void
  onSelect: (tabId: string) => void
  footer?: JSX.Element | null
}

export default function TerminalTabPicker({
  tabs,
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
            const token = mentionTokenFor(tab)
            const label = formatTerminalLabel(tab)
            const isActive = tab.id === activeSessionId
            const isPinned = tab.id === pinnedTabId
            const selected = index === highlightIndex
            const tags = [
              label !== token ? label : null,
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
