import { useEffect, useRef, useState } from 'react'
import { useT } from '../../lib/i18n'

interface Props {
  /** Accumulated reasoning/thinking text. */
  reasoning: string
  /** True while the model is still thinking (answer not yet started). */
  thinking: boolean
  /** Total thinking duration (ms), available once thinking has finished. */
  durationMs?: number
}

/**
 * Cursor-style collapsible "thinking" block. While the model is reasoning the
 * block auto-expands and streams the thoughts under a shimmering "Thinking…"
 * header; once the answer starts it collapses to "Thought for N s". The user
 * can toggle it open/closed at any time, and a manual toggle wins over the
 * automatic open/close.
 */
export default function ThinkingBlock({ reasoning, thinking, durationMs }: Props): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(true)
  const userToggled = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Auto open while thinking, auto collapse once done — unless the user has
  // taken control of the toggle.
  useEffect(() => {
    if (!userToggled.current) setOpen(thinking)
  }, [thinking])

  // Keep the latest thoughts in view as they stream in.
  useEffect(() => {
    if (open && thinking && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [reasoning, open, thinking])

  const seconds = durationMs !== undefined ? Math.max(1, Math.round(durationMs / 1000)) : 0
  const label = thinking
    ? t('chat.thinking')
    : t('chat.thoughtFor', { sec: seconds })

  return (
    <div className={`thinking ${thinking ? 'is-thinking' : ''} ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="thinking-head"
        onClick={() => {
          userToggled.current = true
          setOpen((v) => !v)
        }}
      >
        <span className="thinking-chevron" aria-hidden>
          ▸
        </span>
        <span className={`thinking-label ${thinking ? 'shimmer' : ''}`}>{label}</span>
      </button>
      {open && (
        <div className="thinking-body" ref={bodyRef}>
          {reasoning}
        </div>
      )}
    </div>
  )
}
