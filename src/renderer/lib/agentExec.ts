/**
 * Command execution for the agent, on a dedicated SSH channel.
 *
 * Running agent commands through the user's interactive shell meant three
 * problems at once: a keystroke typed while a capture was in flight was
 * injected into the agent's command line, the agent's own output scrolled
 * through the terminal as unexplained noise, and completion had to be inferred
 * from a sentinel echo rather than read from the protocol. A separate channel
 * removes all three — at the cost of losing the shell's working directory,
 * which is restored explicitly from the tab's observed cwd.
 *
 * WSL tabs are local pseudo-terminals with no SSH client behind them, so they
 * keep the sentinel-capture path.
 */
import { clampOutput, runCapturedCommand } from './execCapture'
import { getTabObservation } from './terminalObservation'
import type { TerminalSession } from '../store/sessionsStore'

export interface AgentCommandResult {
  output: string
  exitCode: number | null
  cwd: string | null
  timedOut: boolean
  aborted: boolean
  disconnected: boolean
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

/** Absolute cap for one agent command. */
const EXEC_TIMEOUT_MS = 120_000
/** Longer cap for commands that legitimately take minutes. */
const SLOW_EXEC_TIMEOUT_MS = 600_000
const PROGRESS_INTERVAL_MS = 1000

const SLOW_COMMAND_RE = /\b(du|find|locate|updatedb|rsync|ncdu|tree|apt|apt-get|yum|dnf|npm|pnpm|yarn|pip|docker|make|cargo|mvn|gradle)\b/i

function timeoutFor(command: string): number {
  return SLOW_COMMAND_RE.test(command) ? SLOW_EXEC_TIMEOUT_MS : EXEC_TIMEOUT_MS
}

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
      onProgress: options?.onProgress
    })
    return {
      output: cap.output,
      exitCode: cap.exitCode,
      cwd: cap.cwd,
      timedOut: cap.timedOut,
      aborted: false,
      disconnected: cap.disconnected,
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
    const res = await window.api.ssh.exec(sessionId, execId, command, {
      cwd: getTabObservation(tab.id)?.cwd,
      timeoutMs: timeoutFor(command)
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
