/**
 * Reliable command capture for the SSH agent loop.
 *
 * The previous approach ran a command, slept a FIXED 1.5s, then diffed the
 * terminal buffer — which truncated slow commands, missed delayed output, and
 * could never recover an exit code. This module instead wraps the command with
 * a unique sentinel marker that prints the shell exit code and cwd AFTER the
 * command finishes, then watches the raw SSH stream until that marker appears
 * (or a hard timeout / the session drops). This yields a precise output
 * boundary plus a real exit code — the signal the Verify phase needs.
 */
import { stripAnsi } from './streamParse'
import {
  commandAbsoluteTimeoutMs,
  DEFAULT_COMMAND_TIMEOUT_MINUTES
} from '../../shared/aiSettings'
import { nextExecDeadline } from '../../shared/execTimeout'

export interface CommandCapture {
  /** Cleaned command output (ANSI stripped, echo/prompt/marker lines removed). */
  output: string
  /** Parsed shell exit code, or null when it could not be determined. */
  exitCode: number | null
  /** Working directory after the command ran, or null when unknown. */
  cwd: string | null
  /** True when capture ended on idle/hard timeout without seeing the marker. */
  timedOut: boolean
  /** True when the SSH session closed/errored mid-capture. */
  disconnected: boolean
  /** True when Stop or a terminal Ctrl+C sent SIGINT before the command finished. */
  aborted: boolean
  /** True when the session was already capturing, so this command never ran. */
  busy?: boolean
  /** Wall-clock ms spent waiting for the command to finish. */
  waitMs: number
}

/**
 * Stall window: give up only when nothing has arrived for this long.
 * Previously this was a 60s wall-clock cap from start, which cut Execute-mode
 * builds/installs that were still printing. Output now postpones this window.
 */
const EXEC_STALL_TIMEOUT_MS = 120_000
/** Longer stall for commands that may emit nothing for minutes (sleep, apt, …). */
const EXEC_SLOW_STALL_TIMEOUT_MS = 600_000
/** How long to wait for the sentinel after Stop / stall timeout sends Ctrl+C. */
export const CAPTURE_INTERRUPT_SETTLE_MS = 2000
/** Max captured output (chars) fed back to the model. */
const EXEC_OUTPUT_MAX = 4000
/** How often to emit capture progress callbacks. */
const PROGRESS_INTERVAL_MS = 1000

/** Commands that may run long with little or no output before the marker appears. */
const SLOW_COMMAND_RE =
  /\b(du|find|locate|mlocate|updatedb|rsync|ncdu|tree|sleep|apt(?:-get)?|yum|dnf|pacman|zypper|npm|npx|pnpm|yarn|pip3?|conda|docker|podman|kubectl|make|cmake|ninja|cargo|mvn|gradle|git|curl|wget|scp|python3?|node|tar|unzip|gzip|xz|dd)\b/i

/**
 * Echoed helper head. ConPTY/readline wrap at COLUMNS, so `__m=AISSH_…` often
 * lands on the next physical line — `__ec=` alone is enough to cut.
 */
const HELPER_SRC_RE = /__ec=/
/** Printed sentinel: `AISSH_… ec=0 cwd=/tmp AISSH_…` */
const MARKER_OUT_RE = /AISSH_[A-Za-z0-9]+ ec=-?\d+ cwd=/
/**
 * Tail of an echoed helper that wrapped onto its own physical line, so the
 * fragment carries neither the marker nor the `__ec=` head.
 */
const HELPER_TAIL_RE =
  /\$__m|\$__ec|\$\(pwd 2>\/dev\/null\)|printf '\\n%s ec=|%s ec=%s cwd=%s|__m"|__ec"|2>\/dev\/null\)/
/** Wrap remnant of `__ec=$?` after `;` (`cmd; _`, `cmd; __e`, `cmd; __ec=`). */
const HELPER_HEAD_RE = /;[ \t]*_{1,2}(?:e(?:c(?:=(?:\$\??)?)?)?)?$/
/** Anything worth line-scanning for; a chunk without these is passed straight through. */
const ARTIFACT_HINT_RE = /AISSH_|__ec=|\$__m|\$__ec|%s ec=%s cwd=%s/

/** Live absolute ceiling; Settings / app start push the configured value here. */
let cachedAbsoluteMaxMs = commandAbsoluteTimeoutMs(DEFAULT_COMMAND_TIMEOUT_MINUTES)

/** Apply a persisted minutes setting so the next capture uses the new ceiling. */
export function refreshCommandTimeoutMinutes(minutes: number): void {
  cachedAbsoluteMaxMs = commandAbsoluteTimeoutMs(minutes)
}

export interface CaptureTiming {
  /** Idle ms before giving up without marker; null = wait only for marker/hard cap. */
  idleMs: number | null
  /** Stall window (ms): timeout if no output arrives for this long. */
  hardTimeoutMs: number
  /** Wall-clock ceiling (ms) from start, regardless of activity. */
  absoluteMaxMs: number
  slow: boolean
}

export interface CaptureOptions {
  /** Called about once per second while capture is in flight. */
  onProgress?: (elapsedMs: number) => void
  /**
   * Echo the command and its output into the user's terminal (Execute mode /
   * `run_in_terminal`). Silent captures (agent `pwd`, WSL exec) stay hidden.
   */
  visible?: boolean
  /** Receives a canceller once the command is written, for Stop. */
  onAbort?: (abort: () => void) => void
}

/** True when the command is likely to run long before producing output. */
export function isSlowCaptureCommand(command: string): boolean {
  const cmd = command.trim()
  if (!cmd) return false
  const core = cmd.replace(/^(?:sudo\s+|[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, '')
  return SLOW_COMMAND_RE.test(core)
}

/**
 * Resolve idle/stall/absolute timeouts for a command.
 *
 * Never idle-timeout while waiting for the marker. A short idle (previously
 * 800ms) fired during slow git prompts and silent commands (`sleep`, `pwd` in
 * a huge repo), after which the helper leaked into the visible terminal.
 * Completion is the marker itself. The stall window is the no-output fallback;
 * arriving data postpones it, up to `absoluteMaxMs`.
 */
export function getCaptureTiming(command: string, opts?: { absoluteMaxMs?: number }): CaptureTiming {
  const slow = isSlowCaptureCommand(command)
  const absoluteMaxMs =
    typeof opts?.absoluteMaxMs === 'number' && opts.absoluteMaxMs > 0
      ? opts.absoluteMaxMs
      : cachedAbsoluteMaxMs
  return {
    slow,
    idleMs: null,
    hardTimeoutMs: slow ? EXEC_SLOW_STALL_TIMEOUT_MS : EXEC_STALL_TIMEOUT_MS,
    absoluteMaxMs
  }
}

/**
 * Ms until the next stall/absolute deadline, from `startedAt`.
 * 0 means the absolute ceiling is already due.
 */
export function nextCaptureDeadline(startedAt: number, timing: CaptureTiming, now = Date.now()): number {
  return nextExecDeadline(startedAt, timing.hardTimeoutMs, timing.absoluteMaxMs, now)
}

/** Stall window for one command (2 or 10 minutes). The absolute cap is separate. */
export function execTimeoutMs(command: string): number {
  return getCaptureTiming(command).hardTimeoutMs
}

/** Human-readable elapsed time for progress UI. */
export function formatCaptureElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

/** Prefix for sentinel marker tokens embedded in wrapped commands. */
export const CAPTURE_MARKER_PREFIX = 'AISSH_'

function markerToken(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14)
  return `${CAPTURE_MARKER_PREFIX}${rand}`
}

/**
 * Sessions with an in-flight execCapture run (agent / silent pwd / visible
 * Execute), holding the capture's marker so a queued teardown cannot drop a
 * newer capture that started on the same session.
 */
const activeCaptures = new Map<string, string>()
/** Per-session abort so a terminal Ctrl+C can interrupt the in-flight capture. */
const captureAborts = new Map<string, () => void>()

/** True while runCapturedCommand is capturing on this SSH session. */
export function isSessionCaptureActive(sessionId: string): boolean {
  return activeCaptures.has(sessionId)
}

/**
 * Interrupt an in-flight capture from the terminal (Ctrl+C). Sends SIGINT and
 * marks the capture aborted so the agent loop can stop and summarize.
 */
export function interruptSessionCapture(sessionId: string): boolean {
  const abort = captureAborts.get(sessionId)
  if (!abort) return false
  abort()
  return true
}

function captureHelper(marker: string): string {
  return `__ec=$?; __m=${marker}; printf '\\n%s ec=%s cwd=%s %s\\n' "$__m" "$__ec" "$(pwd 2>/dev/null)" "$__m"`
}

/**
 * Build the wrapped command that runs `command` and then prints the sentinel.
 * `__ec=$?` MUST come first so it captures the command's exit code before the
 * later assignment/subshell overwrite it. The marker is emitted via a variable
 * so the shell-echoed source line never matches the runtime marker regex.
 *
 * The helper is chained with `;` (not a newline) so the shell does not print
 * PS1 in between. A slow git prompt between two commands used to look like
 * "idle" and the helper then appeared at the user's prompt.
 *
 * Commands that contain `#` or extra newlines go in a `{ …; }` group so a
 * trailing comment cannot swallow the helper.
 */
function buildWrappedCommand(command: string, marker: string): string {
  const cmd = command.replace(/\s+$/, '')
  const helper = captureHelper(marker)
  if (cmd.includes('\n') || /(^|\s)#/.test(cmd)) {
    return `{ ${cmd}\n}; ${helper}\n`
  }
  return `${cmd}; ${helper}\n`
}

/**
 * Drop sentinel helper / marker lines from a raw PTY chunk so they never
 * reach the visible terminal, even if capture ended before the chunk arrived.
 * A helper glued to a prompt keeps the prompt prefix.
 */
export function stripCaptureArtifacts(data: string): string {
  if (!ARTIFACT_HINT_RE.test(data) && !HELPER_HEAD_RE.test(data)) return data
  const pieces = data.split(/(\r?\n)/)
  const out: string[] = []
  for (const piece of pieces) {
    if (piece === '\n' || piece === '\r\n') {
      out.push(piece)
      continue
    }
    const plain = stripAnsi(piece)
    if (MARKER_OUT_RE.test(plain)) continue
    const helperAt = plain.search(HELPER_SRC_RE)
    if (helperAt >= 0) {
      const kept = plain.slice(0, helperAt).replace(/[ \t;]+$/, '')
      if (kept) out.push(kept)
      continue
    }
    const head = HELPER_HEAD_RE.exec(plain)
    if (head) {
      const kept = plain.slice(0, head.index).replace(/[ \t;]+$/, '')
      if (kept) out.push(kept)
      continue
    }
    // A wrapped continuation holds no user text, so it goes whole.
    if (plain.includes(CAPTURE_MARKER_PREFIX) || HELPER_TAIL_RE.test(plain)) continue
    out.push(piece)
  }
  return out.join('')
}

/** Longest held-back tail before we give up and assume it is real output. */
const MAX_HELD_TAIL = 8192
/** Literals whose partial arrival must never reach the screen. */
const ARTIFACT_TOKENS = [CAPTURE_MARKER_PREFIX, '__ec=$?', '$__m']

/**
 * Where an unterminated tail starts holding — or could still grow into — a
 * sentinel token, or -1 when all of it is safe to show. A tail ending in a
 * prefix of a token counts, because the next chunk may complete it.
 */
function artifactStart(tail: string): number {
  let best = -1
  const keep = (at: number): void => {
    if (best < 0 || at < best) best = at
  }
  for (const token of ARTIFACT_TOKENS) {
    const at = tail.indexOf(token)
    if (at >= 0) {
      keep(at)
      continue
    }
    for (let n = Math.min(tail.length, token.length - 1); n > 0; n--) {
      if (tail.endsWith(token.slice(0, n))) {
        keep(tail.length - n)
        break
      }
    }
  }
  return best
}

export interface CaptureEchoFilter {
  /** Write a raw PTY chunk, minus any sentinel artifact, to the terminal. */
  feed: (chunk: string) => void
  /** Emit whatever was held back, once no more chunks can complete a line. */
  flush: () => void
}

/** `first` marks the opening write of a command, i.e. the echoed command line. */
export type CaptureEchoWrite = (text: string, first: boolean) => void

/**
 * Sentinel-free live echo for a visible capture.
 *
 * Stripping each chunk on its own is not enough: the PTY splits wherever it
 * likes, so a chunk can end mid-helper (`__ec=$?; __m=AIS`) and the fragment
 * reaches the screen before the part that identifies it. This holds back the
 * trailing unterminated line whenever it could still turn into an artifact, and
 * releases it as soon as the line ends — or on `flush()`, for output whose last
 * line never gets a newline.
 */
export function createCaptureEchoFilter(write: CaptureEchoWrite): CaptureEchoFilter {
  let pending = ''
  let wrote = false
  const emit = (text: string): void => {
    const visible = stripCaptureArtifacts(text)
    if (!visible) return
    write(visible, !wrote)
    wrote = true
  }
  return {
    feed: (chunk) => {
      const buf = pending + chunk
      // \r counts as a boundary so progress bars keep updating live.
      const cut = Math.max(buf.lastIndexOf('\n'), buf.lastIndexOf('\r')) + 1
      const tail = buf.slice(cut)
      const start = artifactStart(tail)
      let holdAt = cut + (start >= 0 ? start : tail.length)
      // The helper is chained onto the command as `cmd; __ec=…`, so the
      // separator belongs to the artifact rather than to what the user typed.
      const sep = /[ \t;]+$/.exec(buf.slice(cut, holdAt))
      if (sep) holdAt = cut + sep.index
      if (buf.length - holdAt > MAX_HELD_TAIL) holdAt = buf.length
      pending = buf.slice(holdAt)
      emit(buf.slice(0, holdAt))
    },
    flush: () => {
      const rest = pending
      pending = ''
      emit(rest)
    }
  }
}

/** Terminals able to display a visible capture, by SSH session id. */
const echoWriters = new Map<string, CaptureEchoWrite>()

/**
 * Let a TerminalView display visible captures for its session. The capture owns
 * the echo (rather than the view filtering the raw stream) so the held-back tail
 * has someone to flush it when the command ends.
 */
export function registerCaptureEcho(sessionId: string, write: CaptureEchoWrite): () => void {
  echoWriters.set(sessionId, write)
  return () => {
    if (echoWriters.get(sessionId) === write) echoWriters.delete(sessionId)
  }
}

function markerRegex(marker: string): RegExp {
  return new RegExp(`${marker} ec=(-?\\d+) cwd=([\\s\\S]*?) ${marker}`)
}

/** True when raw SSH output contains the completion marker for this capture. */
export function hasCaptureMarker(raw: string, marker: string): boolean {
  return markerRegex(marker).test(stripAnsi(raw))
}

export interface MarkerCommand {
  /** The wrapped command to write to the shell. */
  wrapped: string
  /** Unique marker token to parse the result with. */
  marker: string
}

/** Build a sentinel-wrapped command plus the marker token to parse its result. */
export function buildMarkerCommand(command: string): MarkerCommand {
  const marker = markerToken()
  return { wrapped: buildWrappedCommand(command, marker), marker }
}

/** Parse the exit code + cwd emitted by a sentinel marker from raw output. */
export function parseMarker(
  raw: string,
  marker: string
): { exitCode: number | null; cwd: string | null } {
  const m = markerRegex(marker).exec(stripAnsi(raw))
  if (!m) return { exitCode: null, cwd: null }
  const ec = Number.parseInt(m[1], 10)
  return { exitCode: Number.isFinite(ec) ? ec : null, cwd: m[2].trim() || null }
}

/**
 * Clamp long output by keeping its head AND its tail.
 *
 * Cutting from the start alone is exactly backwards for command output: a build
 * log, a `systemctl status`, a failing test run all put the verdict at the end,
 * so a head-only cut reliably discards the one part that answers the question.
 * The elision is labelled with a concrete next step, because a model that can
 * see it lost lines will otherwise re-run the same command verbatim.
 */
export function clampOutput(text: string, max = EXEC_OUTPUT_MAX): string {
  if (text.length <= max) return text
  const headLen = Math.floor(max * 0.55)
  const tailLen = max - headLen
  const head = text.slice(0, headLen)
  const tail = text.slice(-tailLen)
  const droppedLines = text.slice(headLen, text.length - tailLen).split('\n').length
  return `${head}\n…[truncated ${droppedLines} lines — re-run with grep/head/tail to narrow the output]…\n${tail}`
}

/** True when a leftover physical line is only a wrap fragment of the helper. */
function isOrphanHelperLine(line: string, marker: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (marker && t.includes(marker)) return true
  if (t.includes(CAPTURE_MARKER_PREFIX)) return true
  if (HELPER_TAIL_RE.test(t) || HELPER_SRC_RE.test(t) || HELPER_HEAD_RE.test(t)) return true
  // Wrap leftovers from `"$__m"` / the printf quotes: a line that is only helper punctuation.
  if (/^["'`\\;]+$/.test(t)) return true
  if (t.length >= 4) {
    const helper = captureHelper(marker || `${CAPTURE_MARKER_PREFIX}x`)
    if (helper.includes(t)) return true
  }
  return false
}

/**
 * True when `line` is the shell echoing `command` (optional prompt / trailing `;`).
 * Requires a prompt delimiter before the command so `totals` is not treated as `ls`.
 */
function isLeadingCommandEcho(line: string, cmdTrim: string): boolean {
  const t = line.trim().replace(/[ \t;]+$/, '')
  if (!t) return true
  if (t === cmdTrim || t === `{ ${cmdTrim}` || t === `{${cmdTrim}`) return true
  const escaped = cmdTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`[#$%>]\\s+${escaped}$`).test(t)
}

/** ConPTY wrap leftover of `cmd; helper` that still sits above real output. */
function isLeadingWrapFragment(line: string, cmdTrim: string, marker: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (isLeadingCommandEcho(line, cmdTrim) || isOrphanHelperLine(line, marker)) return true
  const wrapSource = `${cmdTrim}; ${captureHelper(marker)}`
  if (!wrapSource.includes(t)) return false
  if (/__ec|__m|\$\?|printf|AISSH_|%s|2>\/dev\/null/.test(t)) return true
  return t.length >= 2 && t.length <= 6 && /[_$%"'\\]/.test(t)
}

/**
 * Clean captured output: strip ANSI, drop every marker line (the echoed helper
 * and the printed sentinel), drop the echoed command line(s) at the top and any
 * trailing shell prompt, then clamp.
 */
export function cleanCapturedOutput(raw: string, command: string, marker: string): string {
  let lines = stripCaptureArtifacts(stripAnsi(raw)).split(/\r?\n/)
  const cmdTrim = command.trim()
  lines = lines.filter((l) => (marker ? !l.includes(marker) : true) && !isOrphanHelperLine(l, marker))
  while (lines.length && isLeadingWrapFragment(lines[0], cmdTrim, marker)) {
    lines.shift()
  }
  const promptRe = /\S+@\S+.*[#$%>]\s*$/
  while (lines.length) {
    const last = lines[lines.length - 1].trim()
    if (last === '' || promptRe.test(last)) lines.pop()
    else break
  }
  return clampOutput(lines.join('\n').trim())
}

/**
 * Run a command on an SSH session and capture its output + exit code + cwd.
 * Resolves as soon as the sentinel marker is seen. Output postpones the stall
 * window; a silent slow command (du/find/…) gets the extended stall. Never
 * rejects — failures are reported via the `timedOut` / `disconnected` flags.
 */
export function runCapturedCommand(
  sessionId: string,
  command: string,
  options?: CaptureOptions
): Promise<CommandCapture> {
  return new Promise((resolve) => {
    // One capture per shell: a second wrapped command would interleave with the
    // first on the same PTY, and both markers would parse the wrong output.
    if (activeCaptures.has(sessionId)) {
      resolve({
        output: '',
        exitCode: null,
        cwd: null,
        timedOut: false,
        disconnected: false,
        aborted: false,
        busy: true,
        waitMs: 0
      })
      return
    }

    const timing = getCaptureTiming(command)
    const marker = markerToken()
    const re = markerRegex(marker)
    const startedAt = Date.now()
    const echo = options?.visible
      ? createCaptureEchoFilter((text, first) => echoWriters.get(sessionId)?.(text, first))
      : null
    let buffer = ''
    let done = false
    let aborted = false
    let timeoutInterrupt = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    let progressTimer: ReturnType<typeof setInterval> | undefined
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    let unsubData = (): void => {}
    let unsubStatus = (): void => {}

    const elapsed = (): number => Date.now() - startedAt

    const complete = (timedOut: boolean, disconnected: boolean): void => {
      if (done) return
      done = true
      // Drop the flag after every onData listener has seen this chunk. A
      // TerminalView registered after us would otherwise write the marker.
      queueMicrotask(() => {
        if (activeCaptures.get(sessionId) === marker) activeCaptures.delete(sessionId)
      })
      captureAborts.delete(sessionId)
      if (idleTimer) clearTimeout(idleTimer)
      if (hardTimer) clearTimeout(hardTimer)
      if (progressTimer) clearInterval(progressTimer)
      if (abortTimer) clearTimeout(abortTimer)
      unsubData()
      unsubStatus()
      // A last line with no trailing newline is still the user's output.
      echo?.flush()
      const stripped = stripAnsi(buffer)
      const m = re.exec(stripped)
      const exitCode = m ? Number.parseInt(m[1], 10) : null
      const cwd = m && m[2].trim() ? m[2].trim() : null
      resolve({
        output: cleanCapturedOutput(buffer, command, marker),
        exitCode: Number.isFinite(exitCode as number) ? exitCode : null,
        cwd,
        timedOut: !aborted && (timedOut || timeoutInterrupt),
        disconnected,
        aborted,
        waitMs: elapsed()
      })
    }

    const bumpIdle = (): void => {
      if (timing.idleMs === null) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => complete(true, false), timing.idleMs)
    }

    const beginTimeoutInterrupt = (): void => {
      if (done || aborted || timeoutInterrupt) return
      timeoutInterrupt = true
      window.api.ssh.write(sessionId, '\x03')
      if (abortTimer) return
      abortTimer = setTimeout(() => complete(true, false), CAPTURE_INTERRUPT_SETTLE_MS)
    }

    const scheduleDeadline = (): void => {
      if (done || aborted || timeoutInterrupt) return
      if (hardTimer) clearTimeout(hardTimer)
      const wait = nextCaptureDeadline(startedAt, timing)
      hardTimer = setTimeout(beginTimeoutInterrupt, Math.max(0, wait))
    }

    if (options?.onProgress) {
      const emit = (): void => options.onProgress!(elapsed())
      emit()
      progressTimer = setInterval(emit, PROGRESS_INTERVAL_MS)
    }

    unsubData = window.api.ssh.onData((e) => {
      if (e.sessionId !== sessionId) return
      echo?.feed(e.data)
      buffer += e.data
      if (buffer.length > 400000) buffer = buffer.slice(-200000)
      if (re.test(stripAnsi(buffer))) {
        complete(false, false)
        return
      }
      bumpIdle()
      scheduleDeadline()
    })

    unsubStatus = window.api.ssh.onStatus((e) => {
      if (e.sessionId !== sessionId) return
      if (e.status === 'closed' || e.status === 'error') complete(false, true)
    })

    activeCaptures.set(sessionId, marker)
    bumpIdle()
    scheduleDeadline()
    const abort = (): void => {
      if (done || aborted) return
      aborted = true
      window.api.ssh.write(sessionId, '\x03')
      if (abortTimer) return
      abortTimer = setTimeout(() => complete(false, false), CAPTURE_INTERRUPT_SETTLE_MS)
    }
    captureAborts.set(sessionId, abort)
    window.api.ssh.write(sessionId, buildWrappedCommand(command, marker))
    options?.onAbort?.(abort)
  })
}
