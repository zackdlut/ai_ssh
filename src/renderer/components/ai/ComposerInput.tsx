import { forwardRef, useLayoutEffect, useRef, useState } from 'react'
import {
  applyMentionHotkey,
  findMentionSpans,
  liveMentionRange,
  snapSelectionToMentions,
  type MentionableTab,
  type MentionSpan
} from '../../lib/pinnedTerminal'
import { findFileMentionSpans, isFilePathMentionQuery } from '../../lib/fileMentions'

interface Props {
  value: string
  tabs: readonly MentionableTab[]
  placeholder?: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onContextMenu: (e: React.MouseEvent<HTMLTextAreaElement>) => void
  onAtomicEdit: (next: string, caret: number) => void
}

type Seg = { key: string; kind: 'text' | 'chip' | 'path' | 'pending'; value: string }

function highlightSegments(text: string, tabs: readonly MentionableTab[], caret: number): Seg[] {
  const chips = findMentionSpans(text, tabs)
  const paths = findFileMentionSpans(text)
  const live = liveMentionRange(text, caret)
  const liveQuery = live ? text.slice(live.start + 1, live.end) : ''
  const liveIsFile = live ? isFilePathMentionQuery(liveQuery) : false
  const pending =
    live &&
    !liveIsFile &&
    !chips.some((c) => c.start < live.end && c.end > live.start) &&
    !paths.some((c) => c.start < live.end && c.end > live.start)
      ? live
      : null
  const marks = [
    ...chips.map((c) => ({ start: c.start, end: c.end, kind: 'chip' as const })),
    ...paths.map((c) => ({ start: c.start, end: c.end, kind: 'path' as const })),
    ...(pending ? [{ start: pending.start, end: pending.end, kind: 'pending' as const }] : [])
  ].sort((a, b) => a.start - b.start)

  const segs: Seg[] = []
  let i = 0
  let n = 0
  for (const m of marks) {
    if (m.start < i) continue
    if (m.start > i) {
      segs.push({ key: `t${n++}`, kind: 'text', value: text.slice(i, m.start) })
    }
    segs.push({ key: `m${n++}`, kind: m.kind, value: text.slice(m.start, m.end) })
    i = m.end
  }
  if (i < text.length) segs.push({ key: `t${n++}`, kind: 'text', value: text.slice(i) })
  if (segs.length === 0) segs.push({ key: 'empty', kind: 'text', value: text })
  return segs
}

function allChipSpans(text: string, tabs: readonly MentionableTab[]): MentionSpan[] {
  return [
    ...findMentionSpans(text, tabs),
    ...findFileMentionSpans(text).map((s) => ({ start: s.start, end: s.end, token: s.path }))
  ]
}

const ComposerInput = forwardRef<HTMLTextAreaElement, Props>(function ComposerInput(
  { value, tabs, placeholder, onChange, onKeyDown, onContextMenu, onAtomicEdit },
  ref
) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const [caret, setCaret] = useState(value.length)

  const syncScroll = (): void => {
    const from = areaRef.current
    const to = highlightRef.current
    if (!from || !to) return
    to.scrollTop = from.scrollTop
    to.scrollLeft = from.scrollLeft
  }

  useLayoutEffect(() => {
    syncScroll()
    const el = areaRef.current
    if (el) setCaret(el.selectionStart ?? value.length)
  }, [value])

  const bindRef = (el: HTMLTextAreaElement | null): void => {
    areaRef.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }

  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget
    const spans = allChipSpans(value, tabs)
    const snapped = snapSelectionToMentions(spans, el.selectionStart, el.selectionEnd)
    if (snapped && (snapped.start !== el.selectionStart || snapped.end !== el.selectionEnd)) {
      el.setSelectionRange(snapped.start, snapped.end)
      setCaret(snapped.end)
      return
    }
    setCaret(el.selectionEnd)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      onKeyDown(e)
      return
    }
    const el = e.currentTarget
    const skipChar = e.ctrlKey || e.metaKey || e.altKey
    const key = skipChar && e.key.length === 1 ? '' : e.key
    const result = key ? applyMentionHotkey(value, el.selectionStart, el.selectionEnd, key, tabs) : null
    if (result) {
      e.preventDefault()
      if (result.type === 'edit') {
        onAtomicEdit(result.text, result.caret)
        setCaret(result.caret)
      } else {
        el.setSelectionRange(result.start, result.end)
        setCaret(result.end)
      }
      return
    }
    onKeyDown(e)
  }

  const segs = highlightSegments(value, tabs, caret)

  return (
    <div className="composer-input">
      <div className="composer-highlight" ref={highlightRef} aria-hidden>
        {segs.map((seg) =>
          seg.kind === 'chip' ? (
            <span key={seg.key} className="composer-mention">
              {seg.value}
            </span>
          ) : seg.kind === 'path' ? (
            <span key={seg.key} className="composer-mention composer-mention--path">
              {seg.value}
            </span>
          ) : seg.kind === 'pending' ? (
            <span key={seg.key} className="composer-mention-pending">
              {seg.value}
            </span>
          ) : (
            <span key={seg.key}>{seg.value}</span>
          )
        )}
        {'\n'}
      </div>
      <textarea
        ref={bindRef}
        value={value}
        onChange={(e) => {
          setCaret(e.target.selectionStart ?? e.target.value.length)
          onChange(e)
        }}
        onKeyDown={handleKeyDown}
        onSelect={(e) => setCaret(e.currentTarget.selectionEnd)}
        onMouseUp={onSelect}
        onScroll={syncScroll}
        onContextMenu={onContextMenu}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  )
})

export default ComposerInput
