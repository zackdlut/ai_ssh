import { useEffect, useState } from 'react'
import type { Terminal } from '@xterm/xterm'

interface GutterLine {
  num: number
  isCurrent: boolean
  isMajor: boolean
}

interface GutterMetrics {
  width: number
  top: number
  cellHeight: number
  lines: GutterLine[]
}

interface Props {
  term: Terminal | null
  visible: boolean
  fontFamily: string
  fontSize: number
  lineHeight: number
  layoutRef: React.RefObject<HTMLDivElement>
}

const EMPTY: GutterMetrics = { width: 0, top: 0, cellHeight: 0, lines: [] }

export default function TerminalLineGutter({
  term,
  visible,
  fontFamily,
  fontSize,
  lineHeight,
  layoutRef
}: Props): JSX.Element | null {
  const [metrics, setMetrics] = useState<GutterMetrics>(EMPTY)

  useEffect(() => {
    if (!term || !visible) {
      setMetrics(EMPTY)
      return
    }

    const update = (): void => {
      const buffer = term.buffer.active
      const count = term.rows
      const viewportTop = buffer.viewportY
      const cursorLine = buffer.baseY + buffer.cursorY

      const lines: GutterLine[] = Array.from({ length: count }, (_, i) => {
        const num = viewportTop + i + 1
        return {
          num,
          isCurrent: viewportTop + i === cursorLine,
          isMajor: num % 5 === 0
        }
      })

      const maxNum = lines[lines.length - 1]?.num ?? 1
      const digits = String(maxNum).length
      const screen = term.element?.querySelector('.xterm-screen')
      const cellWidth = screen && term.cols > 0 ? screen.clientWidth / term.cols : fontSize * 0.62
      const width = Math.ceil(digits * cellWidth) + 14

      const rowEl = term.element?.querySelector('.xterm-rows > div')
      const cellHeight = rowEl?.getBoundingClientRect().height ?? fontSize * lineHeight

      const layout = layoutRef.current
      const rowsEl = term.element?.querySelector('.xterm-rows')
      let top = 0
      if (layout && rowsEl) {
        top = rowsEl.getBoundingClientRect().top - layout.getBoundingClientRect().top
      }

      setMetrics({ width, top, cellHeight, lines })
    }

    update()
    const onScroll = term.onScroll(update)
    const onWrite = term.onWriteParsed(update)
    const onResize = term.onResize(update)
    const onCursorMove = term.onCursorMove(update)
    const ro = layoutRef.current ? new ResizeObserver(update) : null
    if (layoutRef.current) ro?.observe(layoutRef.current)

    return () => {
      onScroll.dispose()
      onWrite.dispose()
      onResize.dispose()
      onCursorMove.dispose()
      ro?.disconnect()
    }
  }, [term, visible, fontFamily, fontSize, lineHeight, layoutRef])

  if (!visible) return null

  return (
    <div
      className="terminal-line-gutter"
      style={{
        width: metrics.width,
        paddingTop: metrics.top,
        fontFamily,
        fontSize
      }}
      aria-hidden
    >
      <div className="terminal-line-gutter-rail" />
      <div className="terminal-line-gutter-body">
        {metrics.lines.map((line, i) => (
          <div
            key={i}
            className={[
              'terminal-line-gutter-row',
              line.isCurrent ? 'is-current' : '',
              line.isMajor && !line.isCurrent ? 'is-major' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ height: metrics.cellHeight }}
          >
            <span className="terminal-line-gutter-num">{line.num}</span>
            {line.isCurrent ? <span className="terminal-line-gutter-marker" /> : null}
          </div>
        ))}
      </div>
    </div>
  )
}
