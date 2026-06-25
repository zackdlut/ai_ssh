import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { TerminalTab } from '../store/tabsStore'
import { registerTerminal, unregisterTerminal } from '../lib/terminalRegistry'

interface Props {
  tab: TerminalTab
  active: boolean
}

export default function TerminalView({ tab, active }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'Cascadia Code', 'Fira Code', Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#000000',
        foreground: '#cdd6f4',
        cursor: '#89b4fa'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current!)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const onDataDisposable = term.onData((data) => {
      window.api.ssh.write(tab.sessionId, data)
    })

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      window.api.ssh.resize(tab.sessionId, cols, rows)
    })

    const dataUnsub = window.api.ssh.onData((e) => {
      if (e.sessionId === tab.sessionId) term.write(e.data)
    })

    registerTerminal(tab.id, (maxLines = 40) => serializeBuffer(term, maxLines))

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // container may be hidden
      }
    })
    resizeObserver.observe(containerRef.current!)

    // Push the initial size to the remote shell.
    window.api.ssh.resize(tab.sessionId, term.cols, term.rows)
    term.focus()

    return () => {
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      dataUnsub()
      resizeObserver.disconnect()
      unregisterTerminal(tab.id)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.sessionId])

  // Refit and focus whenever this tab becomes the active one.
  useEffect(() => {
    if (active && fitRef.current && termRef.current) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
          termRef.current?.focus()
        } catch {
          // ignore
        }
      })
    }
  }, [active])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        padding: '4px 6px',
        display: active ? 'block' : 'none'
      }}
    />
  )
}

function serializeBuffer(term: Terminal, maxLines: number): string {
  const buffer = term.buffer.active
  const end = buffer.baseY + term.rows
  const start = Math.max(0, end - maxLines)
  const lines: string[] = []
  for (let i = start; i < end; i++) {
    const line = buffer.getLine(i)
    if (line) lines.push(line.translateToString(true))
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}
