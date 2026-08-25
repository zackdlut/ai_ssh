import { useEffect, useRef } from 'react'
import { usePaneSearchStore } from '../../store/paneSearchStore'
import { getTerminalHandle } from '../../lib/terminalRegistry'
import { useT } from '../../lib/i18n'

/**
 * Find bar for one pane. Rendered inside the pane frame so it inherits the
 * pane's rect instead of having to be positioned against the terminal area.
 */
export default function PaneSearchBar({
  terminalId,
  hasHeader
}: {
  terminalId: string
  hasHeader: boolean
}): JSX.Element {
  const t = useT()
  const query = usePaneSearchStore((s) => s.query)
  const flags = usePaneSearchStore((s) => s.flags)
  const resultIndex = usePaneSearchStore((s) => s.resultIndex)
  const resultCount = usePaneSearchStore((s) => s.resultCount)
  const setQuery = usePaneSearchStore((s) => s.setQuery)
  const setFlags = usePaneSearchStore((s) => s.setFlags)
  const setResults = usePaneSearchStore((s) => s.setResults)
  const close = usePaneSearchStore((s) => s.close)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [terminalId])

  useEffect(() => {
    const handle = getTerminalHandle(terminalId)
    if (!handle) return
    return handle.search.onResults((r) =>
      setResults(r?.resultIndex ?? -1, r?.resultCount ?? 0)
    )
  }, [terminalId, setResults])

  // Re-run on every keystroke and flag change so the highlight tracks the query.
  useEffect(() => {
    const handle = getTerminalHandle(terminalId)
    if (!handle) return
    if (!query) {
      handle.search.clear()
      setResults(-1, 0)
      return
    }
    try {
      handle.search.findNext(query, flags)
    } catch {
      setResults(-1, 0)
    }
  }, [terminalId, query, flags, setResults])

  // Leaving the bar must not leave stale highlights on the terminal.
  useEffect(() => {
    return () => getTerminalHandle(terminalId)?.search.clear()
  }, [terminalId])

  const step = (back: boolean): void => {
    const handle = getTerminalHandle(terminalId)
    if (!handle || !query) return
    try {
      if (back) handle.search.findPrevious(query, flags)
      else handle.search.findNext(query, flags)
    } catch {
      setResults(-1, 0)
    }
  }

  const status = query
    ? resultCount === 0
      ? t('search.noResults')
      : t('search.position', { index: resultIndex + 1, total: resultCount })
    : ''

  return (
    <div
      className={`pane-search ${hasHeader ? 'has-header' : ''}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        className="pane-search-input"
        value={query}
        placeholder={t('search.placeholder')}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
      />
      <span className={`pane-search-status ${resultCount === 0 && query ? 'is-empty' : ''}`}>
        {status}
      </span>
      <button
        type="button"
        className={`pane-search-flag ${flags.caseSensitive ? 'active' : ''}`}
        title={t('search.caseSensitive')}
        aria-pressed={flags.caseSensitive}
        onClick={() => setFlags({ caseSensitive: !flags.caseSensitive })}
      >
        Aa
      </button>
      <button
        type="button"
        className={`pane-search-flag ${flags.wholeWord ? 'active' : ''}`}
        title={t('search.wholeWord')}
        aria-pressed={flags.wholeWord}
        onClick={() => setFlags({ wholeWord: !flags.wholeWord })}
      >
        ab
      </button>
      <button
        type="button"
        className={`pane-search-flag ${flags.regex ? 'active' : ''}`}
        title={t('search.regex')}
        aria-pressed={flags.regex}
        onClick={() => setFlags({ regex: !flags.regex })}
      >
        .*
      </button>
      <button
        type="button"
        className="pane-search-btn"
        title={t('search.previous')}
        disabled={!query}
        onClick={() => step(true)}
      >
        ↑
      </button>
      <button
        type="button"
        className="pane-search-btn"
        title={t('search.next')}
        disabled={!query}
        onClick={() => step(false)}
      >
        ↓
      </button>
      <button
        type="button"
        className="pane-search-btn pane-search-close"
        title={t('common.close')}
        onClick={close}
      >
        ×
      </button>
    </div>
  )
}
