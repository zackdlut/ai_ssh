import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
// 0.15.0 matches @xterm/xterm@5.5; 0.16 is for xterm 6 and white-screens on find.
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import type { TerminalSession } from '../store/sessionsStore'
import { useSessionsStore } from '../store/sessionsStore'
import {
  COPILOT_CONTEXT_MAX_LINES,
  registerTerminal,
  unregisterTerminal,
  type TerminalSearchOptions
} from '../lib/terminalRegistry'
import { paneRectStyle, type PaneRect } from '../lib/paneLayout'
import { usePaneLayoutStore } from '../store/paneLayoutStore'
import { isTerminalReadOnly, selectGroupActive, usePaneSyncStore } from '../store/paneSyncStore'
import { broadcastInput, broadcastScroll } from '../lib/paneSync'
import { handlePaneKey } from '../lib/paneShortcuts'
import { hasGpuWebgl2 } from '../lib/webglSupport'
import { askAboutSelection } from '../lib/aiService'
import { extractCommands, isDangerous } from '../lib/commands'
import { stripAnsi } from '../lib/streamParse'
import { buildMarkerCommand, parseMarker, runCapturedCommand, getCaptureTiming, hasCaptureMarker, formatCaptureElapsed, isSessionCaptureActive, registerCaptureEcho, stripCaptureArtifacts } from '../lib/execCapture'
import { getTabObservation, setTabObservation } from '../lib/terminalObservation'
import { describeTabOs } from '../../shared/prompts'
import {
  isFollowAppTheme,
  resolveTerminalTheme,
  xtermThemeForDisplay
} from '../lib/terminalColorSchemes'
import { useThemeStore } from '../store/themeStore'
import { usePaneMetricsStore } from '../store/paneMetricsStore'
import { useTerminalAppearanceStore } from '../store/terminalAppearanceStore'
import { useKeybindingsStore } from '../store/keybindingsStore'
import { MIN_TERMINAL_LINE_HEIGHT, MAX_TERMINAL_LINE_HEIGHT, xtermFontWeight } from '../../shared/terminalSettings'
import { matchesKeyEvent } from '../lib/keybindingMatch'
import { useLocaleStore } from '../store/localeStore'
import { t, useT } from '../lib/i18n'
import { debugLog } from '../lib/debugLog'
import type { AppLocale, TerminalContext } from '../../shared/types'
import type { CommandRun } from '../../shared/types'
import { SHORTCUT_COPY, formatShortcut } from '../lib/shortcuts'
import ContextMenuItem from './ContextMenuItem'
import TerminalLineGutter from './TerminalLineGutter'
import TerminalEmptyState from './TerminalEmptyState'

interface Props {
  tab: TerminalSession
  /** Pane currently showing this tab, or undefined when detached. */
  paneId?: string
  /** Shown in a pane: rendered, hit-testable, and kept fitted to its rect. */
  visible: boolean
  /**
   * The owning tab has more than one pane, so this host leaves room for a pane
   * header. Read from the host's own tab rather than the one on screen, so a
   * background terminal keeps its geometry and needs no refit when shown again.
   */
  split: boolean
  /** Owns the keyboard; at most one terminal is focused at a time. */
  focused: boolean
  /** Percentage rect of the owning pane; full area when detached. */
  rect?: PaneRect
  onNewConnection: () => void
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
  /** Sentinel marker used to parse the exit code and delimit output. */
  marker?: string
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
// How long a scroll this pane was steered to still counts as our own echo.
const SYNC_SCROLL_ECHO_MS = 500

/** Tab fields the NL-mode context needs; a subset of TerminalSession. */
type NlContextTab = Pick<TerminalSession, 'id' | 'host' | 'username' | 'kind' | 'wslDistro'>

/** Same fields, as carried across the NL summarize hop (tab id renamed). */
type NlSummarizeContext = Omit<NlContextTab, 'id'> & { tabId: string }

/** Build NL-mode AI context, including the observed shell cwd when known. */
function buildNlContext(term: Terminal, tab: NlContextTab): TerminalContext {
  return {
    recentOutput: serializeBuffer(term, NL_CONTEXT_MAX_LINES),
    host: tab.host,
    username: tab.username,
    osHint: describeTabOs(tab.kind, tab.wslDistro),
    cwd: getTabObservation(tab.id)?.cwd
  }
}

/** Refresh cwd via a silent pwd (updates observation). */
async function refreshTabCwd(tabId: string, sessionId: string): Promise<string | undefined> {
  const cap = await runCapturedCommand(sessionId, 'pwd')
  if (cap.cwd) {
    setTabObservation(tabId, { cwd: cap.cwd, at: Date.now() })
    return cap.cwd
  }
  return getTabObservation(tabId)?.cwd
}

/** Return observed cwd, running pwd once when still unknown. */
async function ensureTabCwd(tabId: string, sessionId: string): Promise<string | undefined> {
  const existing = getTabObservation(tabId)?.cwd
  if (existing) return existing
  return refreshTabCwd(tabId, sessionId)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Format captured command output for display / summary: strip ANSI, drop the
 * echoed command line and any trailing shell prompt, then trim and clamp.
 */
function formatCaptured(raw: string, cmd: string, username?: string, marker?: string): string {
  let lines = stripAnsi(raw).split(/\r?\n/)
  const cmdTrim = cmd.trim()
  // Drop sentinel-marker lines (the echoed helper and the printed marker).
  if (marker) lines = lines.filter((l) => !l.includes(marker))
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
  req: { request: string; runs: CommandRun[]; context?: NlSummarizeContext },
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
        ? buildNlContext(term, { ...req.context, id: req.context.tabId })
        : undefined
    })
  })
}

export default function TerminalView({
  tab,
  paneId,
  visible,
  split,
  focused,
  rect,
  onNewConnection
}: Props): JSX.Element {
  if (tab.status === 'idle') {
    return (
      <div
        className={`terminal-view-host${visible ? ' is-visible' : ''}${split ? ' is-split' : ''}`}
        style={rect ? paneRectStyle(rect) : undefined}
        onMouseDown={paneId ? () => usePaneLayoutStore.getState().focusPane(paneId) : undefined}
      >
        <TerminalEmptyState terminalId={tab.id} onNewConnection={onNewConnection} />
      </div>
    )
  }

  return (
    <ConnectedTerminalView
      tab={tab}
      paneId={paneId}
      visible={visible}
      split={split}
      focused={focused}
      rect={rect}
    />
  )
}

function ConnectedTerminalView({
  tab,
  paneId,
  visible,
  split,
  focused,
  rect
}: Omit<Props, 'onNewConnection'>): JSX.Element {
  const sessionId = tab.sessionId!
  const containerRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const pasteIntoTerminalRef = useRef<((clip: string) => void) | null>(null)
  const visibleRef = useRef(visible)
  const focusedRef = useRef(focused)
  const paneIdRef = useRef(paneId)
  /** Viewport line a sync mirror is steering to, so we don't echo it back. */
  const syncScrollTargetRef = useRef<{ line: number; at: number } | null>(null)
  /**
   * Last geometry pushed to the remote pty. A divider drag resizes the host on
   * every mouse move, but `fit()` only crosses a character-cell boundary now and
   * then, so comparing against this is what keeps the SSH channel from taking an
   * IPC round trip per frame for every pane in the split.
   */
  const sentSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const nlRef = useRef<NlState>({ mode: 'normal', buffer: '', cursor: 0, busy: false })
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [showLineNumbers, setShowLineNumbers] = useState(false)
  const [termInstance, setTermInstance] = useState<Terminal | null>(null)
  const appTheme = useThemeStore((s) => s.theme)
  const colorScheme = useTerminalAppearanceStore((s) => s.colorScheme)
  const fontFamily = useTerminalAppearanceStore((s) => s.fontFamily)
  const fontSize = useTerminalAppearanceStore((s) => s.fontSize)
  const lineHeight = useTerminalAppearanceStore((s) => s.lineHeight)
  const fontWeight = useTerminalAppearanceStore((s) => s.fontWeight)
  const keybindings = useKeybindingsStore()
  const keybindingsRef = useRef(keybindings)
  const askCopilotBinding = keybindings.askCopilot
  const canRealign = usePaneSyncStore(
    (s) => selectGroupActive(s) && s.lockedTerminalIds.includes(tab.id)
  )
  const safeLineHeight = Math.min(
    MAX_TERMINAL_LINE_HEIGHT,
    Math.max(MIN_TERMINAL_LINE_HEIGHT, lineHeight)
  )
  const tr = useT()
  const followAppTheme = isFollowAppTheme(colorScheme)
  const resolvedTheme = resolveTerminalTheme(colorScheme, appTheme)
  const containerBg = resolvedTheme.background ?? '#000'

  visibleRef.current = visible
  focusedRef.current = focused
  paneIdRef.current = paneId
  keybindingsRef.current = keybindings

  const fitTerminal = (): boolean => {
    const container = containerRef.current
    const fit = fitRef.current
    const term = termRef.current
    if (!container || !fit || !term) return false
    if (container.clientWidth <= 0 || container.clientHeight <= 0) return false
    try {
      fit.fit()
      if (term.cols > 0 && term.rows > 0) {
        const sent = sentSizeRef.current
        if (!sent || sent.cols !== term.cols || sent.rows !== term.rows) {
          sentSizeRef.current = { cols: term.cols, rows: term.rows }
          window.api.ssh.resize(sessionId, term.cols, term.rows)
        }
        return true
      }
    } catch {
      // container may be hidden or mid-dispose
    }
    return false
  }

  const scheduleFit = (): void => {
    if (!visibleRef.current) return
    const attempt = (): void => {
      if (!visibleRef.current) return
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
    // A reconnect swaps the session under us, and the new pty knows nothing of
    // the size the old one was told.
    sentSizeRef.current = null
    const appearance = useTerminalAppearanceStore.getState()
    const appThemeAtMount = useThemeStore.getState().theme
    const theme = xtermThemeForDisplay(appearance.colorScheme, appThemeAtMount)
    const term = new Terminal({
      // Search highlights call registerDecoration, which xterm 5.5 still
      // treats as proposed API. Without this, every find throws and the bar
      // reports "no matches".
      allowProposedApi: true,
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
    const search = new SearchAddon()
    term.loadAddon(search)
    // Default handler uses window.open() then sets location — Electron denies
    // the blank window, so the link never opens. Hand the URL to the OS instead.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void window.api.app.openExternal(uri)
      })
    )

    let cancelled = false
    let detachViewportScroll: (() => void) | null = null

    /**
     * Feed scroll sync from the viewport element rather than `term.onScroll`.
     * xterm routes wheel and scrollbar input through the viewport with the
     * scroll event suppressed, so `onScroll` only ever sees output-driven and
     * programmatic scrolls — the user's own scrolling never reaches it.
     */
    const watchViewportScroll = (): void => {
      const viewport = containerRef.current?.querySelector('.xterm-viewport')
      if (!viewport) return
      let frame: number | null = null
      const onViewportScroll = (): void => {
        if (frame !== null) return
        frame = requestAnimationFrame(() => {
          frame = null
          // Skip the echo of a mirrored scroll so the group doesn't oscillate.
          // The viewport only catches up with a programmatic scroll a frame
          // later, so the guard has to survive until then.
          const steering = syncScrollTargetRef.current
          if (steering) {
            const fresh = performance.now() - steering.at < SYNC_SCROLL_ECHO_MS
            if (fresh && steering.line === term.buffer.active.viewportY) return
            syncScrollTargetRef.current = null
          }
          broadcastScroll(tab.id)
        })
      }
      viewport.addEventListener('scroll', onViewportScroll, { passive: true })
      detachViewportScroll = () => {
        if (frame !== null) cancelAnimationFrame(frame)
        viewport.removeEventListener('scroll', onViewportScroll)
      }
    }

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
      watchViewportScroll()
      termRef.current = term
      setTermInstance(term)
      fitRef.current = fit
      fitTerminal()
      scheduleFit()
      if (term.cols > 0 && term.rows > 0) {
        window.api.ssh.resize(sessionId, term.cols, term.rows)
        // `onResize` only fires on a change, so seed the first size here.
        usePaneMetricsStore.getState().setSize(tab.id, { cols: term.cols, rows: term.rows })
      }
      if (focusedRef.current) term.focus()
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
        useSessionsStore.getState().setNlMode(tab.id, true)
        const toggleKey = formatShortcut(keybindingsRef.current.toggleNlMode)
        term.write(
          `\r\n${ORANGE}${t(loc(), 'terminal.nl.entered', { toggleKey })}${RESET}`
        )
        void refreshTabCwd(tab.id, sessionId)
        writeNlPrompt()
      } else {
        nl.mode = 'normal'
        nl.buffer = ''
        nl.cursor = 0
        nl.confirmResolver = undefined
        useSessionsStore.getState().setNlMode(tab.id, false)
        term.write(`\r\n${DIM}${t(loc(), 'terminal.nl.exited')}${RESET}`)
        // Redraw the real shell prompt for normal mode.
        window.api.ssh.write(sessionId, '\n')
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
        const timing = getCaptureTiming(cmd)
        const { wrapped, marker } = buildMarkerCommand(cmd)
        const startedAt = Date.now()
        let progressTimer: ReturnType<typeof setInterval> | undefined
        let showingWait = false

        const clearWaitLine = (): void => {
          if (progressTimer) {
            clearInterval(progressTimer)
            progressTimer = undefined
          }
          if (showingWait) {
            term.write('\r\n')
            showingWait = false
          }
        }

        const showWait = (): void => {
          const elapsed = formatCaptureElapsed(Date.now() - startedAt)
          term.write(`\r${DIM}  ${t(loc(), 'terminal.nl.waiting', { elapsed })}${RESET}`)
          showingWait = true
        }

        const done = (): void => {
          if (cap.done) return
          cap.done = true
          clearTimeout(cap.timer)
          if (cap.idleTimer) clearTimeout(cap.idleTimer)
          clearWaitLine()
          if (nlRef.current.capture === cap) nlRef.current.capture = undefined
          const output = formatCaptured(cap.buffer, cmd, tab.username, marker)
          const { exitCode, cwd } = parseMarker(cap.buffer, marker)
          if (cwd) {
            setTabObservation(tab.id, {
              cwd,
              lastCommand: cmd,
              lastExitCode: exitCode,
              at: Date.now()
            })
          }
          if (output) term.write(output.replace(/\n/g, '\r\n') + '\r\n')
          resolve({ command: cmd, output, code: exitCode })
        }
        const cap: Capture = {
          buffer: '',
          done: false,
          finish: done,
          marker,
          timer: setTimeout(done, timing.hardTimeoutMs),
          bumpIdle() {
            if (timing.idleMs === null) return
            if (cap.idleTimer) clearTimeout(cap.idleTimer)
            cap.idleTimer = setTimeout(done, timing.idleMs)
          }
        }
        nl.capture = cap
        if (timing.slow) {
          showWait()
          progressTimer = setInterval(showWait, 1000)
        }
        window.api.ssh.write(sessionId, wrapped)
      })

    const runNL = async (text: string): Promise<void> => {
      const nl = nlRef.current
      nl.busy = true
      debugLog({
        category: 'user.action',
        tabId: tab.id,
        sessionId_ssh: sessionId,
        message: 'nl.input',
        data: { textLength: text.length }
      })
      term.write(`\r\n${DIM}${t(loc(), 'terminal.nl.parsing')}${RESET}\r\n`)

      await ensureTabCwd(tab.id, sessionId)
      const context = buildNlContext(term, tab)

      let result: { content?: string; error?: string }
      try {
        debugLog({
          category: 'action.triggered',
          tabId: tab.id,
          message: 'nl.translate',
          data: { prompt: text }
        })
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
        debugLog({
          category: 'action.triggered',
          tabId: tab.id,
          sessionId_ssh: sessionId,
          message: 'nl.execCommand',
          data: { command: cmd }
        })
        runs.push(await runCommandAndCapture(cmd))
      }

      // Answer the user's original request based on the execution results.
      if (runs.length > 0 && nl.mode === 'nl') {
        const direct = tryDirectAnswer(runs)
        if (direct) {
          writeAnswer(term, direct)
        } else {
          term.write(`${DIM}${t(loc(), 'terminal.nl.summarizing')}${RESET}\r\n`)
          debugLog({
            category: 'action.triggered',
            tabId: tab.id,
            message: 'nl.summarize',
            data: { runCount: runs.length }
          })
          try {
            await streamSummarize(
              term,
              {
                request: text,
                runs,
                context: {
                  tabId: tab.id,
                  host: tab.host,
                  username: tab.username,
                  kind: tab.kind,
                  wslDistro: tab.wslDistro
                }
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

    // Custom bindings for NL mode / line numbers / split panes / Ask Copilot.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      const bindings = keybindingsRef.current

      if (matchesKeyEvent(bindings.toggleNlMode, e)) {
        toggleNl()
        return false
      }

      if (matchesKeyEvent(bindings.toggleLineNumbers, e)) {
        e.preventDefault()
        setShowLineNumbers((v) => !v)
        return false
      }

      if (handlePaneKey(bindings, e, paneIdRef.current ?? null, tab.id)) return false

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

      if (matchesKeyEvent(bindings.askCopilot, e)) {
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
      // Every paste path (paste event, right-click, context menu) funnels here,
      // so this is the only place read-only has to swallow pasted text.
      if (isTerminalReadOnly(tab.id)) return
      if (isSessionCaptureActive(sessionId)) return
      const nl = nlRef.current
      if (nl.mode === 'nl') {
        nlInsertPasteText(clip)
      } else {
        window.api.ssh.write(sessionId, clip)
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
      // A read-only pane swallows everything, including sync broadcasts.
      if (isTerminalReadOnly(tab.id)) return
      // Agent / Execute capture owns the PTY: lock typing so a keystroke cannot
      // splice into the wrapped command. Ctrl+C still interrupts.
      if (isSessionCaptureActive(sessionId)) {
        if (data.includes('\x03')) window.api.ssh.write(sessionId, '\x03')
        return
      }
      if (nl.mode === 'normal') {
        window.api.ssh.write(sessionId, data)
        broadcastInput(tab.id, data)
        return
      }
      if (nl.confirmResolver) {
        handleConfirmKey(data)
        return
      }
      if (nl.busy) {
        // Let Ctrl+C interrupt a running/stuck command so capture can finish
        // after output goes idle and input isn't locked forever.
        if (data.includes('\x03')) window.api.ssh.write(sessionId, '\x03')
        return
      }
      handleNlInput(data)
    })

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      window.api.ssh.resize(sessionId, cols, rows)
      usePaneMetricsStore.getState().setSize(tab.id, { cols, rows })
    })

    const dataUnsub = window.api.ssh.onData((e) => {
      if (e.sessionId !== sessionId) return

      // A capture owns the stream while it runs: a silent one (agent pwd / WSL
      // exec) is swallowed whole, and a visible one (Execute mode) is written by
      // the capture itself through the echo filter registered below.
      if (isSessionCaptureActive(sessionId)) return

      const nl = nlRef.current
      const cap = nl.capture
      // While capturing an NL command, buffer the raw stream but don't echo it
      // (command echo and shell prompt are suppressed; cleaned output is
      // rendered when the command finishes).
      if (cap && !cap.done) {
        cap.buffer += e.data
        if (cap.buffer.length > 200000) cap.buffer = cap.buffer.slice(-100000)
        if (cap.marker && hasCaptureMarker(cap.buffer, cap.marker)) {
          cap.finish()
          return
        }
        cap.bumpIdle()
        return
      }
      // In NL mode (but not running a command), suppress stray shell output
      // such as the prompt redraw so the terminal stays a clean AI prompt.
      if (nl.mode === 'nl') return

      const visible = stripCaptureArtifacts(e.data)
      if (visible) term.write(visible)
    })

    // Execute mode writes here so the user watches the command run. NL mode owns
    // the screen with its own prompt, so it stays out of the way.
    const echoUnsub = registerCaptureEcho(sessionId, (text, first) => {
      if (nlRef.current.mode === 'nl') return
      // A user reading their scrollback would otherwise miss the whole run:
      // the agent does not type, so nothing pulls the viewport back down.
      if (first) term.scrollToBottom()
      term.write(text)
    })

    registerTerminal(tab.id, {
      readOutput: (maxLines = COPILOT_CONTEXT_MAX_LINES) =>
        maxLines < 0 ? serializeFullBuffer(term) : serializeBuffer(term, maxLines),
      readViewport: () => {
        const buffer = term.buffer.active
        return serializeRows(term, buffer.viewportY, term.rows)
      },
      readTail: (maxLines) => {
        const buffer = term.buffer.active
        const end = buffer.baseY + term.rows
        const count = maxLines > 0 ? Math.min(maxLines, end) : end
        return serializeRows(term, end - count, count)
      },
      toggleNl,
      isNlMode: () => nlRef.current.mode === 'nl',
      getSize: () => ({ cols: term.cols, rows: term.rows }),
      getViewportTop: () => term.buffer.active.viewportY,
      scrollToAbsolute: (line) => {
        const buffer = term.buffer.active
        const target = Math.min(buffer.baseY, Math.max(0, Math.round(line)))
        if (buffer.viewportY === target) return
        syncScrollTargetRef.current = { line: target, at: performance.now() }
        term.scrollToLine(target)
      },
      search: {
        findNext: (query, options) => {
          try {
            return search.findNext(query, searchOptions(options))
          } catch {
            // Invalid regex, or a selection whose end column is past `cols`.
            return false
          }
        },
        findPrevious: (query, options) => {
          try {
            return search.findPrevious(query, searchOptions(options))
          } catch {
            return false
          }
        },
        clear: () => {
          try {
            search.clearDecorations()
          } catch {
            // Terminal may already be tearing down.
          }
        },
        onResults: (listener) => {
          const disposable = search.onDidChangeResults((e) => {
            listener({
              resultIndex: e?.resultIndex ?? -1,
              resultCount: e?.resultCount ?? 0
            })
          })
          return () => disposable.dispose()
        }
      }
    })

    const resizeObserver = new ResizeObserver(() => {
      if (!visibleRef.current) return
      fitTerminal()
    })
    resizeObserver.observe(containerRef.current!)

    return () => {
      cancelled = true
      term.textarea?.removeEventListener('paste', onTerminalPaste, true)
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      detachViewportScroll?.()
      dataUnsub()
      echoUnsub()
      resizeObserver.disconnect()
      unregisterTerminal(tab.id)
      usePaneMetricsStore.getState().clear(tab.id)
      if (nlRef.current.capture) {
        clearTimeout(nlRef.current.capture.timer)
        if (nlRef.current.capture.idleTimer) clearTimeout(nlRef.current.capture.idleTimer)
      }
      term.dispose()
      termRef.current = null
      setTermInstance(null)
      fitRef.current = null
      pasteIntoTerminalRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, sessionId])

  /*
   * WebGL renderer, held only while this terminal is on screen.
   *
   * The DOM renderer cannot keep up with several panes streaming output at once,
   * so a visible terminal upgrades to WebGL when a real GPU is available. But
   * each WebGL renderer owns a real GPU context, browsers cap those (commonly
   * 16), and past the cap they silently drop the oldest — blanking a terminal
   * that is still connected. Background tabs stay mounted, so holding a context
   * per terminal would grow the total with every tab the user opens. A hidden
   * terminal paints nothing, so it gives its context back and takes a fresh one
   * when shown again; that is the same path xterm uses to recover from a context
   * loss, so it is well-trodden.
   */
  useEffect(() => {
    const term = termInstance
    if (!term || !visible || !hasGpuWebgl2()) return
    let addon: WebglAddon
    try {
      addon = new WebglAddon()
    } catch {
      // Blocklisted driver or lost context at load time: DOM renderer stays.
      return
    }
    // Search decorations can also drop the context; refresh so the DOM renderer
    // paints instead of leaving a blank (white) canvas.
    const repaint = (): void => {
      try {
        term.refresh(0, term.rows - 1)
      } catch {
        // Terminal already disposed.
      }
    }
    addon.onContextLoss(() => {
      addon.dispose()
      repaint()
    })
    try {
      term.loadAddon(addon)
    } catch {
      addon.dispose()
      return
    }
    return () => {
      addon.dispose()
      repaint()
    }
  }, [termInstance, visible])

  /*
   * Only the hidden -> visible transition needs the retry ladder, because the
   * host may not have laid out yet. Rect changes (divider drags, zoom) are
   * picked up by the ResizeObserver instead; that fires once per frame while a
   * divider is dragged, so `fitTerminal` is what dedupes the SSH resize down to
   * the frames where the cell grid actually changed.
   */
  useEffect(() => {
    if (visible && fitRef.current && termRef.current) scheduleFit()
  }, [visible])

  /*
   * Blurring matters as much as focusing: xterm's hidden textarea keeps DOM
   * focus on its own, so a terminal that loses the focused pane would keep
   * swallowing keystrokes — including when the newly focused pane is empty.
   */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (focused) term.focus()
    else term.blur()
  }, [focused])

  useEffect(() => {
    if (visibleRef.current) scheduleFit()
  }, [showLineNumbers])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = xtermThemeForDisplay(colorScheme, appTheme)
    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
    term.options.lineHeight = safeLineHeight
    term.options.fontWeight = xtermFontWeight(fontWeight)
    if (visibleRef.current) scheduleFit()
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
  // A pane in a live scroll-sync group always gets the menu, since re-anchoring
  // the group is only reachable from there; paste moves into the menu instead.
  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const term = termRef.current
    if (!term) return
    const selection = term.getSelection().trim()
    if (selection || canRealign) {
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

  const paste = (): void => {
    setMenu(null)
    void navigator.clipboard.readText().then((text) => {
      if (text) pasteIntoTerminalRef.current?.(text)
    })
  }

  const realign = (): void => {
    usePaneSyncStore.getState().realignScroll()
    setMenu(null)
  }

  return (
    <>
      <div
        className={`terminal-view-host${visible ? ' is-visible' : ''}${
          split ? ' is-split' : ''
        }${followAppTheme ? ' terminal-view-host--follow-theme' : ''}`}
        style={{
          ...(rect ? paneRectStyle(rect) : null),
          ...(followAppTheme ? null : { background: containerBg })
        }}
        onMouseDown={paneId ? () => usePaneLayoutStore.getState().focusPane(paneId) : undefined}
        onContextMenu={onContextMenu}
      >
        <div
          ref={layoutRef}
          className={`terminal-view-layout${showLineNumbers ? ' terminal-view-layout--line-numbers' : ''}`}
        >
          <TerminalLineGutter
            term={termInstance}
            visible={showLineNumbers}
            fontFamily={fontFamily}
            fontSize={fontSize}
            lineHeight={safeLineHeight}
            layoutRef={layoutRef}
          />
          <div ref={containerRef} className="terminal-view-surface" />
        </div>
      </div>
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.text ? (
            <>
              <ContextMenuItem shortcut={askCopilotBinding} icon="copilot" onClick={ask}>
                {tr('terminal.askCopilot')}
              </ContextMenuItem>
              <ContextMenuItem shortcut={SHORTCUT_COPY} icon="copy" onClick={copy}>
                {tr('common.copy')}
              </ContextMenuItem>
            </>
          ) : (
            <ContextMenuItem icon="paste" onClick={paste}>
              {tr('common.paste')}
            </ContextMenuItem>
          )}
          {canRealign && (
            <ContextMenuItem icon="lock" onClick={realign}>
              {tr('sync.realign')}
            </ContextMenuItem>
          )}
        </div>
      )}
    </>
  )
}

/**
 * Search options with highlight decorations always on.
 *
 * The decorations are not just cosmetic: `onDidChangeResults` only fires when
 * they are enabled, so without them the search bar could never show a match
 * count. xterm requires literal `#RRGGBB` here — CSS variables are not resolved
 * — so these are fixed mid-tone ambers that stay legible on both light and dark
 * colour schemes.
 */
function searchOptions(options?: TerminalSearchOptions): ISearchOptions {
  return {
    ...options,
    decorations: {
      matchBackground: '#c98f2b',
      matchBorder: '#c98f2b',
      matchOverviewRuler: '#c98f2b',
      activeMatchBackground: '#e2601b',
      activeMatchBorder: '#e2601b',
      activeMatchColorOverviewRuler: '#e2601b'
    }
  }
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

/** Verbatim rows `[from, from + count)`, clamped to the buffer. */
function serializeRows(term: Terminal, from: number, count: number): string {
  const buffer = term.buffer.active
  const start = Math.max(0, from)
  const end = Math.min(buffer.baseY + term.rows, start + count)
  const lines: string[] = []
  for (let i = start; i < end; i++) {
    const line = buffer.getLine(i)
    lines.push(line ? line.translateToString(true) : '')
  }
  return lines.join('\n').trimEnd()
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
