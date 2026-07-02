/**
 * Reliable command capture for the SSH agent loop.
 *
 * The previous approach ran a command, slept a FIXED 1.5s, then diffed the
 * terminal buffer — which truncated slow commands, missed delayed output, and
 * could never recover an exit code. This module instead wraps the command with
 * a unique sentinel marker that prints the shell exit code and cwd AFTER the
 * command finishes, then watches the raw SSH stream until that marker appears
 * (or the stream goes idle / a hard timeout / the session drops). This yields a
 * precise output boundary plus a real exit code — the signal the Verify phase
 * needs.
 */
import { stripAnsi } from './streamParse'

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
}

/** Treat output as complete after this idle period when the marker is absent. */
const EXEC_IDLE_MS = 800
/** Absolute safety cap for a single command's capture. */
const EXEC_HARD_TIMEOUT_MS = 60000
/** Max captured output (chars) fed back to the model. */
const EXEC_OUTPUT_MAX = 4000

function markerToken(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14)
  return `AISSH_${rand}`
}

/**
 * Build the wrapped command that runs `command` and then prints the sentinel.
 * `__ec=$?` MUST come first so it captures the command's exit code before the
 * later assignment/subshell overwrite it. The marker is emitted via a variable
 * so the shell-echoed source line never matches the runtime marker regex.
 */
function buildWrappedCommand(command: string, marker: string): string {
  const cmd = command.replace(/\s+$/, '')
  return `${cmd}\n__ec=$?; __m=${marker}; printf '\\n%s ec=%s cwd=%s %s\\n' "$__m" "$__ec" "$(pwd 2>/dev/null)" "$__m"\n`
}

function markerRegex(marker: string): RegExp {
  return new RegExp(`${marker} ec=(-?\\d+) cwd=([\\s\\S]*?) ${marker}`)
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
 * Clean captured output: strip ANSI, drop every marker line (the echoed helper
 * and the printed sentinel), drop the echoed command line(s) at the top and any
 * trailing shell prompt, then clamp.
 */
export function cleanCapturedOutput(raw: string, command: string, marker: string): string {
  let lines = stripAnsi(raw).split(/\r?\n/)
  const cmdTrim = command.trim()
  lines = lines.filter((l) => !l.includes(marker))
  while (lines.length && (lines[0].trim() === '' || lines[0].trim() === cmdTrim)) {
    lines.shift()
  }
  const promptRe = /\S+@\S+.*[#$%>]\s*$/
  while (lines.length) {
    const last = lines[lines.length - 1].trim()
    if (last === '' || promptRe.test(last)) lines.pop()
    else break
  }
  return lines.join('\n').trim().slice(0, EXEC_OUTPUT_MAX)
}

/**
 * Run a command on an SSH session and capture its output + exit code + cwd.
 * Resolves as soon as the sentinel marker is seen; falls back to idle/hard
 * timeout when the marker never arrives (e.g. a shell without printf, or a
 * long-running foreground process). Never rejects — failures are reported via
 * the `timedOut` / `disconnected` flags so the loop can decide how to recover.
 */
export function runCapturedCommand(sessionId: string, command: string): Promise<CommandCapture> {
  return new Promise((resolve) => {
    const marker = markerToken()
    const re = markerRegex(marker)
    let buffer = ''
    let done = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    let unsubData = (): void => {}
    let unsubStatus = (): void => {}

    const complete = (timedOut: boolean, disconnected: boolean): void => {
      if (done) return
      done = true
      if (idleTimer) clearTimeout(idleTimer)
      if (hardTimer) clearTimeout(hardTimer)
      unsubData()
      unsubStatus()
      const stripped = stripAnsi(buffer)
      const m = re.exec(stripped)
      const exitCode = m ? Number.parseInt(m[1], 10) : null
      const cwd = m && m[2].trim() ? m[2].trim() : null
      resolve({
        output: cleanCapturedOutput(buffer, command, marker),
        exitCode: Number.isFinite(exitCode as number) ? exitCode : null,
        cwd,
        timedOut,
        disconnected
      })
    }

    const bumpIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => complete(true, false), EXEC_IDLE_MS)
    }

    unsubData = window.api.ssh.onData((e) => {
      if (e.sessionId !== sessionId) return
      buffer += e.data
      if (buffer.length > 400000) buffer = buffer.slice(-200000)
      if (re.test(stripAnsi(buffer))) {
        complete(false, false)
        return
      }
      bumpIdle()
    })

    unsubStatus = window.api.ssh.onStatus((e) => {
      if (e.sessionId !== sessionId) return
      if (e.status === 'closed' || e.status === 'error') complete(false, true)
    })

    hardTimer = setTimeout(() => complete(true, false), EXEC_HARD_TIMEOUT_MS)
    bumpIdle()
    window.api.ssh.write(sessionId, buildWrappedCommand(command, marker))
  })
}
