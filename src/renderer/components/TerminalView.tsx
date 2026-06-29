import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { TerminalTab } from '../store/tabsStore'
import { useTabsStore } from '../store/tabsStore'
import { COPILOT_CONTEXT_MAX_LINES, registerNlToggle, registerTerminal, unregisterTerminal } from '../lib/terminalRegistry'
import { askAboutSelection } from '../lib/aiService'
import { extractCommands, isDangerous } from '../lib/commands'
import { stripAnsi } from '../lib/streamParse'
import {
  isFollowAppTheme,
  resolveTerminalTheme,
  xtermThemeForDisplay
} from '../lib/terminalColorSchemes'
import { useThemeStore } from '../store/themeStore'
import { useTerminalAppearanceStore } from '../store/terminalAppearanceStore'
import { MIN_TERMINAL_LINE_HEIGHT, MAX_TERMINAL_LINE_HEIGHT, xtermFontWeight } from '../../shared/terminalSettings'
import { useLocaleStore } from '../store/localeStore'
import { t, useT } from '../lib/i18n'
import type { AppLocale } from '../../shared/types'
import type { CommandRun } from '../../shared/types'
import { SHORTCUT_ASK_COPILOT, SHORTCUT_COPY } from '../lib/shortcuts'
import ContextMenuItem from './ContextMenuItem'

interface Props {
  tab: TerminalTab
  active: boolean
}

interface MenuState {
  x: number
  y: number
  text: string
}

/**
 * Captures the output of a single command executed in NL mode by watching the
 * SSH data stream until output goes idle.
 */
interface Capture {
  buffer: string
  done: boolean
  finish: () => void
  timer: ReturnType<typeof setTimeout>
  idleTimer?: ReturnType<typeof setTimeout>
  bumpIdle: () => void
}

/** Local state machine for the in-terminal natural-language mode. */
interface NlState {
  mode: 'normal' | 'nl'
  buffer: string
  /** Cursor offset within `buffer` (0 = before first char). */
  cursor: number
  busy: boolean
  confirmResolver?: (ok: boolean) => void
  capture?: Capture
}

// ANSI helpers for the in-terminal NL prompts.
const ORANGE = '\x1b[38;5;208m'
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const YELLOW = '\x1b[33m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'

// In-terminal natural-language prompt shown instead of the remote shell prompt.
function nlPrompt(locale: AppLocale): string {
  return `${ORANGE}(${t(locale, 'terminal.nl.prompt')})$${RESET} `
}

// Sliding window: terminal lines included as NL-mode AI context.
const NL_CONTEXT_MAX_LINES = 100
// Max captured output (chars) fed to the summarizer.
const MAX_CAPTURE = 2000
// Skip the summarize LLM call when a single command returns short, plain output.
const DIRECT_ANSWER_MAX = 200
// Safety timeout (ms) for a single command's output capture.
const CAPTURE_TIMEOUT = 20000
// Treat command output as complete after this idle period (ms).
const CAPTURE_IDLE_MS = 500

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Format captured command output for display / summary: strip ANSI, drop the
 * echoed command line and any trailing shell prompt, then trim and clamp.
 */
function formatCaptured(raw: string, cmd: string, username?: string): string {
  const lines = stripAnsi(raw).split(/\r?\n/)
  const cmdTrim = cmd.trim()
  // Drop the shell-echoed command line(s) at the top.
  while (lines.length && (lines[0].trim() === '' || lines[0].trim() === cmdTrim)) {
    lines.shift()
  }
  // Drop trailing shell prompt(s) and blank lines at the bottom.
  const promptRe = username
    ? new RegExp(`${escapeRegExp(username)}@.*[#$%>]\\s*$`)
    : /\S+@\S+.*[#$%>]\s*$/
  while (lines.length) {
    const last = lines[lines.length - 1].trim()
    if (last === '' || promptRe.test(last)) lines.pop()
    else break
  }
  return lines.join('\n').trim().slice(0, MAX_CAPTURE)
}

/** Short single-command output can be shown directly without a second LLM call. */
function tryDirectAnswer(runs: CommandRun[]): string | null {
  if (runs.length !== 1) return null
  const out = runs[0].output.trim()
  if (!out || out.length > DIRECT_ANSWER_MAX) return null
  if (out.includes('\n') && out.split('\n').length > 5) return null
  return out
}

function writeAnswer(term: Terminal, text: string): void {
  term.write(`${CYAN}↳${RESET} ${text.trim().replace(/\n/g, '\r\n  ')}\r\n`)
}

/** When the model returns nothing, fall back to captured command output. */
function formatRunsFallback(runs: CommandRun[]): string | null {
  const parts = runs.map((r) => r.output.trim()).filter(Boolean)
  if (parts.length === 0) return null
  return parts.join('\n\n').slice(0, 800)
}

/** Stream summarize tokens into the terminal as they arrive from the model. */
function streamSummarize(
  term: Terminal,
  req: { request: string; runs: CommandRun[]; context?: { host: string; username: string } },
  locale: AppLocale
): Promise<void> {
  const requestId = crypto.randomUUID()
  let wrotePrefix = false

  return new Promise((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      unsubChunk()
      unsubDone()
      unsubError()
    }

    const timer = setTimeout(() => {
      cleanup()
      term.write(`${YELLOW}${t(locale, 'terminal.nl.summarizeTimeout')}${RESET}\r\n`)
      const fallback = formatRunsFallback(req.runs)
      if (fallback) writeAnswer(term, fallback)
      resolve()
    }, 90000)

    const finish = (text: string | null | undefined): void => {
      cleanup()
      const answer = text?.trim() || formatRunsFallback(req.runs)
      if (!wrotePrefix) {
        if (answer) writeAnswer(term, answer)
        else term.write(`${YELLOW}${t(locale, 'terminal.nl.noSummary')}${RESET}\r\n`)
      } else {
        term.write('\r\n')
      }
      resolve()
    }

    const unsubChunk = window.api.ai.onChunk(({ requestId: id, delta }) => {
      if (id !== requestId) return
      if (!wrotePrefix) {
        term.write(`${CYAN}↳${RESET} `)
        wrotePrefix = true
      }
      term.write(delta.replace(/\n/g, '\r\n  '))
    })
    const unsubDone = window.api.ai.onDone(({ requestId: id, content }) => {
      if (id !== requestId) return
      finish(content)
    })
    const unsubError = window.api.ai.onError(({ requestId: id, error }) => {
      if (id !== requestId) return
      cleanup()
      term.write(`${RED}${error}${RESET}\r\n`)
      const fallback = formatRunsFallback(req.runs)
      if (fallback) writeAnswer(term, fallback)
      resolve()
    })

    window.api.ai.summarize({
      requestId,
      request: req.request,
      runs: req.runs,
      context: req.context
        ? {
            recentOutput: serializeBuffer(term, NL_CONTEXT_MAX_LINES),
            host: req.context.host,
            username: req.context.username
          }
        : undefined
    })
  })
}

export default function TerminalView({ tab, active }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const pasteIntoTerminalRef = useRef<((clip: string) => void) | null>(null)
  const activeRef = useRef(active)
  const nlRef = useRef<NlState>({ mode: 'normal', buffer: '', cursor: 0, busy: false })
  const [menu, setMenu] = useState<MenuState | null>(null)
  const appTheme = useThemeStore((s) => s.theme)
  const colorScheme = useTerminalAppearanceStore((s) => s.colorScheme)
  const fontFamily = useTerminalAppearanceStore((s) => s.fontFamily)
  const fontSize = useTerminalAppearanceStore((s) => s.fontSize)
  const lineHeight = useTerminalAppearanceStore((s) => s.lineHeight)
  const fontWeight = useTerminalAppearanceStore((s) => s.fontWeight)
  const safeLineHeight = Math.min(
    MAX_TERMINAL_LINE_HEIGHT,
    Math.max(MIN_TERMINAL_LINE_HEIGHT, lineHeight)
  )
  const tr = useT()
  const followAppTheme = isFollowAppTheme(colorScheme)
  const resolvedTheme = resolveTerminalTheme(colorScheme, appTheme)
  const containerBg = resolvedTheme.background ?? '#000'

  activeRef.current = active

  const fitTerminal = (): boolean => {
    const container = containerRef.current
    const fit = fitRef.current
    const term = termRef.current
    if (!container || !fit || !term) return false
    if (container.clientWidth <= 0 || container.clientHeight <= 0) return false
    try {
      fit.fit()
      if (term.cols > 0 && term.rows > 0) {
        window.api.ssh.resize(tab.sessionId, term.cols, term.rows)
        return true
      }
    } catch {
      // container may be hidden or mid-dispose
    }
    return false
  }

  const scheduleFit = (): void => {
    if (!activeRef.current) return
    const attempt = (): void => {
      if (!activeRef.current) return
      fitTerminal()
    }
    attempt()
    requestAnimationFrame(() => {
      attempt()
      requestAnimationFrame(attempt)
    })
    for (const delay of [50, 150, 300]) {
      window.setTimeout(attempt, delay)
    }
  }

  useEffect(() => {
    const appearance = useTerminalAppearanceStore.getState()
    const appThemeAtMount = useThemeStore.getState().theme
    const theme = xtermThemeForDisplay(appearance.colorScheme, appThemeAtMount)
    const term = new Terminal({
      allowTransparency: true,
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      lineHeight: Math.min(
        MAX_TERMINAL_LINE_HEIGHT,
        Math.max(MIN_TERMINAL_LINE_HEIGHT, appearance.lineHeight)
      ),
      fontWeight: xtermFontWeight(appearance.fontWeight),
      fontWeightBold: 'bold',
      letterSpacing: 0.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      theme
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())

    let cancelled = false
    const attachTerminal = (): void => {
      if (cancelled) return
      const el = containerRef.current
      if (!el) return
      if (el.clientWidth <= 0 || el.clientHeight <= 0) {
        requestAnimationFrame(attachTerminal)
        return
      }
      el.replaceChildren()
      term.open(el)
      termRef.current = term
      fitRef.current = fit
      fitTerminal()
      scheduleFit()
      if (term.cols > 0 && term.rows > 0) {
        window.api.ssh.resize(tab.sessionId, term.cols, term.rows)
      }
      term.focus()
    }
    attachTerminal()

    const loc = (): AppLocale => useLocaleStore.getState().locale

    // --- In-terminal natural-language mode ---
    const writeNlPrompt = (): void => {
      term.write(`\r\n${nlPrompt(loc())}`)
    }

    const finishNl = (): void => {
      nlRef.current.busy = false
      // Return to an idle NL prompt instead of letting the shell prompt show.
      if (nlRef.current.mode === 'nl') writeNlPrompt()
    }

    const toggleNl = (): void => {
      const nl = nlRef.current
      if (nl.busy) return // don't toggle while an AI request / confirm is in flight
      if (nl.mode === 'normal') {
        nl.mode = 'nl'
        nl.buffer = ''
        nl.cursor = 0
        useTabsStore.getState().setNlMode(tab.id, true)
        term.write(`\r\n${ORANGE}${t(loc(), 'terminal.nl.entered')}${RESET}`)
        writeNlPrompt()
      } else {
        nl.mode = 'normal'
        nl.buffer = ''
        nl.cursor = 0
        nl.confirmResolver = undefined
        useTabsStore.getState().setNlMode(tab.id, false)
        term.write(`\r\n${DIM}${t(loc(), 'terminal.nl.exited')}${RESET}`)
        // Redraw the real shell prompt for normal mode.
        window.api.ssh.write(tab.sessionId, '\n')
      }
    }

    const waitConfirm = (): Promise<boolean> =>
      new Promise((resolve) => {
        nlRef.current.confirmResolver = resolve
      })

    const handleConfirmKey = (data: string): void => {
      const resolve = nlRef.current.confirmResolver
      if (!resolve) return
      const ch = data[0]
      const yes = ch === 'y' || ch === 'Y'
      term.write(yes ? 'y' : 'n')
      nlRef.current.confirmResolver = undefined
      resolve(yes)
    }

    // Run a command, capturing its output until the SSH stream goes idle. The
    // raw stream (incl. command echo and shell prompt) is suppressed while
    // capturing; the cleaned output is rendered here once the command finishes.
    const runCommandAndCapture = (cmd: string): Promise<CommandRun> =>
      new Promise((resolve) => {
        const nl = nlRef.current
        const done = (): void => {
          if (cap.done) return
          cap.done = true
          clearTimeout(cap.timer)
          if (cap.idleTimer) clearTimeout(cap.idleTimer)
          if (nlRef.current.capture === cap) nlRef.current.capture = undefined
          const output = formatCaptured(cap.buffer, cmd, tab.username)
          if (output) term.write(output.replace(/\n/g, '\r\n') + '\r\n')
          resolve({ command: cmd, output, code: null })
        }
        const cap: Capture = {
          buffer: '',
          done: false,
          finish: done,
          timer: setTimeout(done, CAPTURE_TIMEOUT),
          bumpIdle() {
            if (cap.idleTimer) clearTimeout(cap.idleTimer)
            cap.idleTimer = setTimeout(done, CAPTURE_IDLE_MS)
          }
        }
        nl.capture = cap
        window.api.ssh.write(tab.sessionId, cmd + '\n')
      })

    const runNL = async (text: string): Promise<void> => {
      const nl = nlRef.current
      nl.busy = true
      term.write(`\r\n${DIM}${t(loc(), 'terminal.nl.parsing')}${RESET}\r\n`)

      const context = {
        recentOutput: serializeBuffer(term, NL_CONTEXT_MAX_LINES),
        host: tab.host,
        username: tab.username
      }

      let result: { content?: string; error?: string }
      try {
        result = await window.api.ai.translate({ prompt: text, context })
      } catch (e) {
        term.write(
          `${RED}${t(loc(), 'terminal.nl.parseFailed', {
            error: e instanceof Error ? e.message : String(e)
          })}${RESET}\r\n`
        )
        finishNl()
        return
      }

      if (result.error) {
        term.write(
          `${RED}${t(loc(), 'terminal.nl.parseFailed', { error: result.error })}${RESET}\r\n`
        )
        finishNl()
        return
      }

      const commands = extractCommands(result.content ?? '')
      if (commands.length === 0) {
        // No runnable command. Surface the model's reply (if any) so the user
        // gets feedback instead of a dead end.
        const reply = (result.content ?? '').trim()
        if (reply) {
          term.write(`${CYAN}↳${RESET} ${reply.replace(/\n/g, '\r\n  ')}\r\n`)
        } else {
          term.write(`${YELLOW}${t(loc(), 'terminal.nl.noCommand')}${RESET}\r\n`)
        }
        finishNl()
        return
      }

      const runs: CommandRun[] = []
      for (const cmd of commands) {
        if (nl.mode !== 'nl') break // user exited mid-way
        if (isDangerous(cmd)) {
          term.write(
            `${YELLOW}${t(loc(), 'terminal.nl.dangerous', { cmd })}${RESET}\r\n${YELLOW}${t(loc(), 'terminal.nl.confirmRun')}${RESET}`
          )
          const ok = await waitConfirm()
          if (!ok) {
            term.write(`\r\n${DIM}${t(loc(), 'terminal.nl.skipped')}${RESET}\r\n`)
            continue
          }
          term.write('\r\n')
        } else {
          term.write(`${GREEN}▶${RESET} ${cmd}\r\n`)
        }
        runs.push(await runCommandAndCapture(cmd))
      }

      // Answer the user's original request based on the execution results.
      if (runs.length > 0 && nl.mode === 'nl') {
        const direct = tryDirectAnswer(runs)
        if (direct) {
          writeAnswer(term, direct)
        } else {
          term.write(`${DIM}${t(loc(), 'terminal.nl.summarizing')}${RESET}\r\n`)
          try {
            await streamSummarize(
              term,
              {
                request: text,
                runs,
                context: { host: tab.host, username: tab.username }
              },
              loc()
            )
          } catch (e) {
            term.write(`${RED}${e instanceof Error ? e.message : String(e)}${RESET}\r\n`)
          }
        }
      }
      finishNl()
    }

    const insertNlChar = (ch: string): void => {
      const nl = nlRef.current
      const rest = nl.buffer.slice(nl.cursor)
      nl.buffer = nl.buffer.slice(0, nl.cursor) + ch + rest
      nl.cursor++
      term.write(ch + rest)
      if (rest.length > 0) term.write(' \b'.repeat(rest.length + 1))
    }

    const clearNlLine = (): void => {
      const nl = nlRef.current
      while (nl.cursor < nl.buffer.length) {
        term.write(nl.buffer[nl.cursor])
        nl.cursor++
      }
      while (nl.cursor > 0) {
        term.write('\b \b')
        nl.cursor--
      }
      nl.buffer = ''
    }

    const nlCopy = (): void => {
      const nl = nlRef.current
      if (!nl.buffer) return
      void navigator.clipboard.writeText(nl.buffer)
    }

    const nlCut = (): void => {
      const nl = nlRef.current
      if (!nl.buffer) return
      void navigator.clipboard.writeText(nl.buffer)
      clearNlLine()
    }

    const nlInsertPasteText = (clip: string): void => {
      const text = clip.replace(/[\r\n]+/g, ' ')
      for (const ch of text) insertNlChar(ch)
    }

    const handleNlInput = (data: string): void => {
      const nl = nlRef.current

      const redrawTail = (from: number): void => {
        const tail = nl.buffer.slice(from)
        term.write(tail + ' \b'.repeat(tail.length + 1))
      }

      const moveCursorLeft = (): void => {
        if (nl.cursor <= 0) return
        nl.cursor--
        term.write('\b')
      }

      const moveCursorRight = (): void => {
        if (nl.cursor >= nl.buffer.length) return
        term.write(nl.buffer[nl.cursor])
        nl.cursor++
      }

      const moveCursorHome = (): void => {
        if (nl.cursor <= 0) return
        term.write('\b'.repeat(nl.cursor))
        nl.cursor = 0
      }

      const moveCursorEnd = (): void => {
        while (nl.cursor < nl.buffer.length) moveCursorRight()
      }

      const deleteBeforeCursor = (): void => {
        if (nl.cursor <= 0) return
        term.write('\b')
        nl.buffer = nl.buffer.slice(0, nl.cursor - 1) + nl.buffer.slice(nl.cursor)
        nl.cursor--
        redrawTail(nl.cursor)
      }

      const insertChar = (ch: string): void => {
        insertNlChar(ch)
      }

      const consumeEscape = (start: number): number => {
        if (data[start + 1] === '[') {
          const rest = data.slice(start + 2)
          const m = rest.match(/^(\d*)(;(\d+)*)?([A-Za-z~])/)
          if (m) {
            const code = m[4]
            const param = m[1] || '1'
            if (code === 'D' || (code === '~' && param === '1')) moveCursorLeft()
            else if (code === 'C' || (code === '~' && param === '4')) moveCursorRight()
            else if (code === 'H' || (code === '~' && param === '1')) moveCursorHome()
            else if (code === 'F' || (code === '~' && param === '4')) moveCursorEnd()
            return start + 2 + m[0].length
          }
        }
        if (data[start + 1] === 'O') {
          const code = data[start + 2]
          if (code === 'D') moveCursorLeft()
          else if (code === 'C') moveCursorRight()
          else if (code === 'H') moveCursorHome()
          else if (code === 'F') moveCursorEnd()
          return start + 3
        }
        return start + 1
      }

      let i = 0
      while (i < data.length) {
        const ch = data[i]
        if (ch === '\r' || ch === '\n') {
          const text = nl.buffer.trim()
          nl.buffer = ''
          nl.cursor = 0
          if (!text) return
          if (text.toLowerCase() === 'exit') {
            toggleNl()
            return
          }
          void runNL(text)
          return
        }
        if (ch === '\x7f' || ch === '\b') {
          deleteBeforeCursor()
          i++
          continue
        }
        if (ch === '\x1b') {
          i = consumeEscape(i)
          continue
        }
        if (ch.charCodeAt(0) < 0x20) {
          i++
          continue
        }
        insertChar(ch)
        i++
      }
    }

    // F12 toggles NL mode. Returning false stops xterm from emitting the
    // function-key escape sequence (which would otherwise hit the shell).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      if (e.key === 'F12') {
        toggleNl()
        return false
      }

      if (e.isComposing || e.keyCode === 229) return true

      const mod = e.ctrlKey || e.metaKey
      if (!mod || e.altKey) return true

      const nl = nlRef.current
      const key = e.key.toLowerCase()

      if (key === 'c') {
        // NL busy: keep Ctrl+C as interrupt for the remote command.
        if (nl.mode === 'nl' && nl.busy) return true
        const selection = term.getSelection()
        if (selection) {
          void navigator.clipboard.writeText(selection)
          return false
        }
        if (nl.mode === 'nl' && !nl.confirmResolver && nl.buffer) {
          nlCopy()
          return false
        }
        return true
      }

      if (key === 'x') {
        const selection = term.getSelection()
        if (selection) {
          void navigator.clipboard.writeText(selection)
          return false
        }
        if (nl.mode === 'nl' && !nl.busy && !nl.confirmResolver) {
          nlCut()
          return false
        }
        return false
      }

      if (key === 'v') {
        if (nl.mode === 'nl' && nl.busy) return true
        if (nl.mode === 'nl' && nl.confirmResolver) return true
        // Insertion is handled by the paste listener; block xterm's Ctrl+V key path only.
        return false
      }

      if (key === 'f') {
        const selection = term.getSelection().trim()
        if (selection) {
          e.preventDefault()
          askAboutSelection(selection)
          return false
        }
        return true
      }

      return true
    })

    const pasteIntoTerminal = (clip: string): void => {
      const nl = nlRef.current
      if (nl.mode === 'nl') {
        nlInsertPasteText(clip)
      } else {
        window.api.ssh.write(tab.sessionId, clip)
      }
    }
    pasteIntoTerminalRef.current = pasteIntoTerminal

    // Single paste entry: Ctrl+V / Shift+Insert / menu paste all fire a paste event.
    // Capture phase runs before xterm so we can prevent its duplicate handling.
    const onTerminalPaste = (e: ClipboardEvent): void => {
      const nl = nlRef.current
      if (nl.mode === 'nl' && (nl.busy || nl.confirmResolver)) return
      e.preventDefault()
      e.stopPropagation()
      const clip = e.clipboardData?.getData('text/plain')
      if (clip) {
        pasteIntoTerminal(clip)
        return
      }
      void navigator.clipboard.readText().then((text) => {
        if (text) pasteIntoTerminal(text)
      })
    }
    term.textarea?.addEventListener('paste', onTerminalPaste, true)

    const onDataDisposable = term.onData((data) => {
      const nl = nlRef.current
      if (nl.mode === 'normal') {
        window.api.ssh.write(tab.sessionId, data)
        return
      }
      if (nl.confirmResolver) {
        handleConfirmKey(data)
        return
      }
      if (nl.busy) {
        // Let Ctrl+C interrupt a running/stuck command so capture can finish
        // after output goes idle and input isn't locked forever.
        if (data.includes('\x03')) window.api.ssh.write(tab.sessionId, '\x03')
        return
      }
      handleNlInput(data)
    })

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      window.api.ssh.resize(tab.sessionId, cols, rows)
    })

    const dataUnsub = window.api.ssh.onData((e) => {
      if (e.sessionId !== tab.sessionId) return

      const nl = nlRef.current
      const cap = nl.capture
      // While capturing an NL command, buffer the raw stream but don't echo it
      // (command echo and shell prompt are suppressed; cleaned output is
      // rendered when the command finishes).
      if (cap && !cap.done) {
        cap.buffer += e.data
        if (cap.buffer.length > 200000) cap.buffer = cap.buffer.slice(-100000)
        cap.bumpIdle()
        return
      }
      // In NL mode (but not running a command), suppress stray shell output
      // such as the prompt redraw so the terminal stays a clean AI prompt.
      if (nl.mode === 'nl') return

      term.write(e.data)
    })

    registerTerminal(tab.id, (maxLines = COPILOT_CONTEXT_MAX_LINES) =>
      maxLines < 0 ? serializeFullBuffer(term) : serializeBuffer(term, maxLines)
    )
    registerNlToggle(tab.id, toggleNl)

    const resizeObserver = new ResizeObserver(() => {
      if (!activeRef.current) return
      fitTerminal()
    })
    resizeObserver.observe(containerRef.current!)

    return () => {
      cancelled = true
      term.textarea?.removeEventListener('paste', onTerminalPaste, true)
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      dataUnsub()
      resizeObserver.disconnect()
      unregisterTerminal(tab.id)
      if (nlRef.current.capture) {
        clearTimeout(nlRef.current.capture.timer)
        if (nlRef.current.capture.idleTimer) clearTimeout(nlRef.current.capture.idleTimer)
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
      pasteIntoTerminalRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.sessionId])

  // Refit and focus whenever this tab becomes the active one.
  useEffect(() => {
    if (active && fitRef.current && termRef.current) {
      scheduleFit()
      termRef.current.focus()
    }
  }, [active])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = xtermThemeForDisplay(colorScheme, appTheme)
    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
    term.options.lineHeight = safeLineHeight
    term.options.fontWeight = xtermFontWeight(fontWeight)
    if (activeRef.current) scheduleFit()
  }, [appTheme, colorScheme, fontFamily, fontSize, safeLineHeight, fontWeight])

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

  // Right-click: when text is selected, show the Ask/Copy menu; otherwise paste
  // the clipboard straight into the terminal (PuTTY-style). Routing through
  // term.paste keeps normal/NL input handling consistent with typed input.
  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const term = termRef.current
    if (!term) return
    const selection = term.getSelection().trim()
    if (selection) {
      setMenu({ x: e.clientX, y: e.clientY, text: selection })
      return
    }
    setMenu(null)
    void navigator.clipboard.readText().then((text) => {
      if (text) pasteIntoTerminalRef.current?.(text)
    })
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
        className={`terminal-view-host${active ? ' is-active' : ''}${
          followAppTheme ? ' terminal-view-host--follow-theme' : ''
        }`}
        style={followAppTheme ? undefined : { background: containerBg }}
        onContextMenu={onContextMenu}
      >
        <div ref={containerRef} className="terminal-view-surface" />
      </div>
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <ContextMenuItem shortcut={SHORTCUT_ASK_COPILOT} icon="copilot" onClick={ask}>
            {tr('terminal.askCopilot')}
          </ContextMenuItem>
          <ContextMenuItem shortcut={SHORTCUT_COPY} icon="copy" onClick={copy}>
            {tr('common.copy')}
          </ContextMenuItem>
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

function serializeFullBuffer(term: Terminal): string {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (line) lines.push(line.translateToString(true))
  }
  return lines.join('\n').trimEnd()
}
