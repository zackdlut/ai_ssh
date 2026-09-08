/**
 * Command execution for the agent, on a channel of its own.
 *
 * Running agent commands through the user's interactive shell meant three
 * problems at once: a keystroke typed while a capture was in flight was
 * injected into the agent's command line, the agent's own output scrolled
 * through the terminal as unexplained noise, and completion had to be inferred
 * from a sentinel echo rather than read from the protocol. A separate channel
 * removes all three — at the cost of losing the shell's working directory,
 * which is restored explicitly from the tab's observed cwd.
 *
 * SSH gets that channel from the protocol and a local shell gets it by spawning
 * the command as its own process; both answer on `ssh:exec`. WSL is the one
 * transport with neither — its pty lives inside the distro and there is nothing
 * to spawn a second one with — so it keeps the sentinel-capture path. Both exec
 * paths use the same stall + absolute ceiling as Execute: output postpones the
 * stall window up to the configured cap.
 */
import { clampOutput, getCaptureTiming, runCapturedCommand } from './execCapture'
import { getTabObservation } from './terminalObservation'
import { shellDialect } from '../../shared/shellDialect'
import type { TerminalSession } from '../store/sessionsStore'

export interface AgentCommandResult {
  output: string
  exitCode: number | null
  cwd: string | null
  timedOut: boolean
  aborted: boolean
  disconnected: boolean
  /** True when the terminal was busy with another capture, so nothing ran. */
  busy?: boolean
  waitMs: number
  /** Transport-level failure detail, when the command never ran. */
  error?: string
}

export interface AgentCommandOptions {
  onProgress?: (elapsedMs: number) => void
  /** Registered so the loop can interrupt this command from the Stop button. */
  onStart?: (abort: () => void) => void
  /**
   * Run in the user's interactive shell instead of a private channel, so the
   * command and its output appear in their terminal (`run_in_terminal`).
   */
  visible?: boolean
}

const PROGRESS_INTERVAL_MS = 1000

/** Merge stdout and stderr the way a terminal would, keeping stderr labelled. */
function combineStreams(stdout: string, stderr: string): string {
  const out = stdout.trimEnd()
  const err = stderr.trim()
  if (!err) return out
  if (!out) return err
  return `${out}\n${err}`
}

/**
 * Run a command for the agent and return a uniform result regardless of which
 * transport was used.
 */
export async function runAgentCommand(
  tab: TerminalSession,
  command: string,
  options?: AgentCommandOptions
): Promise<AgentCommandResult> {
  const sessionId = tab.sessionId
  if (!sessionId) {
    return {
      output: '',
      exitCode: null,
      cwd: null,
      timedOut: false,
      aborted: false,
      disconnected: true,
      waitMs: 0
    }
  }

  if (tab.kind === 'wsl' || options?.visible) {
    const cap = await runCapturedCommand(sessionId, command, {
      onProgress: options?.onProgress,
      visible: !!options?.visible,
      onAbort: options?.onStart,
      // A WSL pty is always POSIX; a local one is whatever the user launched,
      // and the sentinel has to be written in that language to come back.
      dialect: tab.kind === 'local' ? shellDialect(tab.localShell) : 'posix'
    })
    return {
      output: cap.output,
      exitCode: cap.exitCode,
      cwd: cap.cwd,
      timedOut: cap.timedOut,
      aborted: cap.aborted,
      disconnected: cap.disconnected,
      busy: cap.busy,
      waitMs: cap.waitMs
    }
  }

  const execId = crypto.randomUUID()
  const startedAt = Date.now()
  let progressTimer: ReturnType<typeof setInterval> | undefined
  if (options?.onProgress) {
    const emit = (): void => options.onProgress!(Date.now() - startedAt)
    emit()
    progressTimer = setInterval(emit, PROGRESS_INTERVAL_MS)
  }
  options?.onStart?.(() => window.api.ssh.abortExec(execId))

  try {
    const timing = getCaptureTiming(command)
    const res = await window.api.ssh.exec(sessionId, execId, command, {
      cwd: getTabObservation(tab.id)?.cwd,
      timeoutMs: timing.hardTimeoutMs,
      absoluteMaxMs: timing.absoluteMaxMs
    })
    return {
      output: clampOutput(combineStreams(res.stdout, res.stderr)),
      exitCode: res.code,
      cwd: res.cwd ?? null,
      timedOut: res.timedOut ?? false,
      aborted: res.aborted ?? false,
      // A transport-level failure means the channel never carried the command,
      // which is the same recovery path as a dropped session.
      disconnected: !!res.error,
      waitMs: Date.now() - startedAt,
      error: res.error
    }
  } finally {
    if (progressTimer) clearInterval(progressTimer)
  }
}
