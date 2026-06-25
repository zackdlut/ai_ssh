import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { TerminalTab } from '../store/tabsStore'
import { registerTerminal, unregisterTerminal } from '../lib/terminalRegistry'
import { askAboutSelection } from '../lib/aiService'

interface Props {
  tab: TerminalTab
  active: boolean
}

interface MenuState {
  x: number
  y: number
  text: string
}

export default function TerminalView({ tab, active }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    const term = new Terminal({
      fontFamily:
        "'Cascadia Code', 'Fira Code', Menlo, 'DejaVu Sans Mono', 'Noto Sans SC', 'Noto Sans CJK SC', 'WenQuanYi Zen Hei', 'WenQuanYi Micro Hei', monospace",
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

  // Dismiss the context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('wheel', close)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const onContextMenu = (e: React.MouseEvent): void => {
    const selection = termRef.current?.getSelection().trim() ?? ''
    if (!selection) {
      setMenu(null)
      return
    }
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, text: selection })
  }

  const ask = (): void => {
    if (menu) askAboutSelection(menu.text)
    setMenu(null)
  }

  const copy = (): void => {
    if (menu) void navigator.clipboard.writeText(menu.text)
    setMenu(null)
  }

  return (
    <>
      <div
        ref={containerRef}
        onContextMenu={onContextMenu}
        style={{
          position: 'absolute',
          inset: 0,
          padding: '4px 6px',
          display: active ? 'block' : 'none'
        }}
      />
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <button onClick={ask}>Ask Copilot</button>
          <button onClick={copy}>Copy</button>
        </div>
      )}
    </>
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
