import { useEffect, useRef } from 'react'
import { useT } from '../../lib/i18n'
import { type SlashCommandMeta } from '../../lib/slashCommands'

interface Props {
  commands: readonly SlashCommandMeta[]
  highlightIndex: number
  onHighlight: (index: number) => void
  onSelect: (name: SlashCommandMeta['name']) => void
}

export default function SlashMenu({
  commands,
  highlightIndex,
  onHighlight,
  onSelect
}: Props): JSX.Element {
  const t = useT()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-slash-index="${highlightIndex}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  return (
    <div className="mention-menu" role="listbox" aria-label="slash">
      <div className="mention-list" ref={listRef}>
        {commands.length === 0 ? (
          <button type="button" className="mention-item" disabled>
            <span className="mention-name">{t('copilot.slash.unknown', { token: '' })}</span>
          </button>
        ) : (
          commands.map((cmd, index) => (
            <button
              key={cmd.name}
              type="button"
              role="option"
              data-slash-index={index}
              aria-selected={index === highlightIndex}
              className={`mention-item${index === highlightIndex ? ' is-active' : ''}`}
              onMouseEnter={() => onHighlight(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSelect(cmd.name)}
            >
              <span className="mention-name">/{cmd.name}</span>
              <span className="mention-desc">{t(cmd.hintKey)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
