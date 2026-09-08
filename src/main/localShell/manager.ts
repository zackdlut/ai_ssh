import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { accessSync, constants, readFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import type { BrowserWindow } from 'electron'
import type {
  ConnectResult,
  LocalConnectOptions,
  LocalShellInfo,
  SamplerStartResult,
  SshDataEvent,
  SshExecOptions,
  SshExecResult,
  SshStatusEvent
} from '../../shared/types'
import {
  execShellArgs,
  interactiveShellArgs,
  shellDialect,
  splitCwdMarker,
  wrapExecCommand,
  type ShellDialect
} from '../../shared/shellDialect'
import { nextExecDeadline } from '../../shared/execTimeout'

type NodePtyModule = typeof import('node-pty')
let ptyModule: NodePtyModule | null = null

async function loadPty(): Promise<NodePtyModule> {
  if (!ptyModule) ptyModule = await import('node-pty')
  return ptyModule
}

/** Largest stdout/stderr buffer retained for one exec (tail-biased). */
const EXEC_BUFFER_MAX = 512 * 1024

/**
 * Quiet period after exit before an exec settles.
 *
 * Same reasoning as the SSH exec channel: a backgrounded process inherits the
 * pipes, so waiting for them to close waits for the service rather than for the
 * command. Exit is the proof; the grace period only drains what is already in
 * flight.
 */
const EXEC_EXIT_GRACE_MS = 500

interface PtyLike {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

interface Session {
  proc: PtyLike
  /** Executable this session launched, replayed by samplers and execs. */
  shell: string
  dialect: ShellDialect
  /**
   * Where the next exec starts.
   *
   * Each exec is its own process, so nothing else carries a `cd` forward. The
   * wrapped command reports the directory it ended in and this is updated from
   * it, which makes a sequence of agent calls behave like one shell session.
   */
  cwd: string
}

/** Windows shells in the order we would rather have them, best first. */
const WINDOWS_SHELLS: Array<{ exe: string; name: string }> = [
  { exe: 'pwsh.exe', name: 'PowerShell 7' },
  { exe: 'powershell.exe', name: 'Windows PowerShell' },
  { exe: 'cmd.exe', name: 'Command Prompt' }
]

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve a bare executable name against PATH, or `null` if it is not there. */
function findOnPath(exe: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    const full = join(dir, exe)
    if (isExecutable(full)) return full
  }
  return null
}

/**
 * Manages shells running on this machine, one per terminal tab.
 *
 * Structurally this is `WslManager` with the executable chosen at runtime, and
 * it reuses the same `ssh:data` / `ssh:status` renderer events so the terminal
 * UI works unchanged. What it adds is a real exec channel: unlike WSL, whose
 * agent commands are typed into the visible pty and read back out of the
 * scrollback, a local shell can be spawned again per command for isolated
 * stdout, stderr, and a genuine exit code.
 */
export class LocalShellManager {
  private sessions = new Map<string, Session>()
  /** Long-running chart sampler processes, keyed by sampler id. */
  private samplers = new Map<string, PtyLike>()
  /** In-flight agent commands, so they can be interrupted. */
  private execProcs = new Map<string, ChildProcess>()
  private abortedExecs = new Set<string>()
  private shellCache: LocalShellInfo[] | null = null

  constructor(private getWindow: () => BrowserWindow | null) {}

  private send(channel: string, payload: unknown): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send(channel, payload)
  }

  private emitData(event: SshDataEvent): void {
    this.send('ssh:data', event)
  }

  private emitStatus(event: SshStatusEvent): void {
    this.send('ssh:status', event)
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * Shells available here, best-first.
   *
   * Unlike `WslManager.listDistros`, this never returns empty: every platform
   * has at least one shell, and the launcher button is meant to be present
   * everywhere rather than hidden when the probe finds nothing.
   */
  listShells(): LocalShellInfo[] {
    if (this.shellCache) return this.shellCache
    const found: LocalShellInfo[] = []
    const seen = new Set<string>()
    const add = (path: string, name: string): void => {
      const key = path.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      found.push({ name, path })
    }

    if (process.platform === 'win32') {
      for (const { exe, name } of WINDOWS_SHELLS) {
        const path = findOnPath(exe)
        if (path) add(path, name)
      }
      // cmd.exe is guaranteed present even when PATH is unusual enough to hide
      // it, and a launcher with no entries at all would be worse than a stub.
      if (found.length === 0 && process.env.COMSPEC) {
        add(process.env.COMSPEC, 'Command Prompt')
      }
    } else {
      const preferred = process.env.SHELL
      if (preferred && isExecutable(preferred)) add(preferred, basename(preferred))
      for (const path of readEtcShells()) {
        if (isExecutable(path)) add(path, basename(path))
      }
      if (found.length === 0) add('/bin/sh', 'sh')
    }

    if (found[0]) found[0].isDefault = true
    this.shellCache = found
    return found
  }

  private defaultShell(): string {
    return this.listShells()[0]?.path ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
  }

  async connect(opts: LocalConnectOptions): Promise<ConnectResult> {
    const sessionId = randomUUID()
    this.emitStatus({ sessionId, status: 'connecting' })

    try {
      const pty = await loadPty()
      const shell = opts.shell || this.defaultShell()
      const dialect = shellDialect(shell)
      const cwd = opts.cwd || homedir()

      const proc = pty.spawn(shell, interactiveShellArgs(dialect), {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: process.env as Record<string, string>
      })

      this.sessions.set(sessionId, { proc, shell, dialect, cwd })

      proc.onData((data: string) => {
        this.emitData({ sessionId, data })
      })
      proc.onExit(() => {
        this.emitStatus({ sessionId, status: 'closed' })
        this.cleanup(sessionId)
      })

      this.emitStatus({ sessionId, status: 'connected' })
      return { sessionId }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.emitStatus({ sessionId, status: 'error', message })
      this.cleanup(sessionId)
      return { error: message }
    }
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.proc.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return
    try {
      this.sessions.get(sessionId)?.proc.resize(cols, rows)
    } catch {
      // pty may have exited between the resize request and this call
    }
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    try {
      session.proc.kill()
    } catch {
      // ignore
    }
    this.cleanup(sessionId)
  }

  // --- Agent command channel ---------------------------------------------

  /**
   * Run one command in a process of its own, mirroring `SshManager.execCommand`.
   *
   * The point is the same isolation SSH gets for free from a second channel:
   * the user's keystrokes cannot land inside the agent's command, and the
   * agent's output does not scroll through the user's terminal. Spawning gives
   * separated stdout and stderr and a real exit code, none of which the
   * scrollback-scraping path can offer.
   *
   * Timeouts match the SSH channel: output postpones the stall window
   * (`opts.timeoutMs`), and `opts.absoluteMaxMs` is the wall-clock ceiling.
   */
  execCommand(
    sessionId: string,
    execId: string,
    command: string,
    opts?: SshExecOptions
  ): Promise<SshExecResult> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return Promise.resolve({ stdout: '', stderr: '', code: null, error: 'Session not found.' })
    }

    const cwd = opts?.cwd || session.cwd
    const wrapped = wrapExecCommand(command, session.dialect)

    return new Promise<SshExecResult>((resolve) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      const stallMs = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 0
      const absoluteMaxMs = opts?.absoluteMaxMs && opts.absoluteMaxMs > 0 ? opts.absoluteMaxMs : 0

      const finish = (extra?: Partial<SshExecResult>): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (graceTimer) clearTimeout(graceTimer)
        this.execProcs.delete(execId)
        const { text, cwd: endedIn } = splitCwdMarker(stdout)
        // Carry the directory forward, so the next call starts where this one
        // finished rather than back at the session's launch directory.
        if (endedIn) session.cwd = endedIn
        resolve({
          stdout: text,
          stderr,
          code,
          cwd: endedIn,
          timedOut,
          aborted: this.abortedExecs.delete(execId) || undefined,
          ...extra
        })
      }

      let child: ChildProcess
      try {
        child = spawn(session.shell, execShellArgs(session.dialect, wrapped), {
          cwd,
          env: process.env,
          windowsHide: true
        })
      } catch (e) {
        return finish({ error: e instanceof Error ? e.message : String(e) })
      }

      // An abort that raced the spawn would otherwise be lost.
      if (this.abortedExecs.has(execId)) {
        try {
          child.kill()
        } catch {
          // ignore
        }
        return finish()
      }
      this.execProcs.set(execId, child)
      const startedAt = Date.now()

      const onTimeout = (): void => {
        timedOut = true
        try {
          child.kill()
        } catch {
          // ignore
        }
      }

      const armDeadline = (): void => {
        if (settled) return
        if (timer) clearTimeout(timer)
        if (!stallMs && !absoluteMaxMs) return
        const wait = nextExecDeadline(startedAt, stallMs, absoluteMaxMs)
        timer = setTimeout(onTimeout, Math.max(0, wait))
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.length > EXEC_BUFFER_MAX) stdout = stdout.slice(-EXEC_BUFFER_MAX)
        armDeadline()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        if (stderr.length > EXEC_BUFFER_MAX) stderr = stderr.slice(-EXEC_BUFFER_MAX)
        armDeadline()
      })
      child.on('error', (err: Error) => finish({ error: err.message }))
      child.on('exit', (exitCode: number | null) => {
        code = typeof exitCode === 'number' ? exitCode : null
        // Give output already in the pipes a moment to arrive; a backgrounded
        // child keeps them open, so 'close' may never come.
        if (graceTimer) clearTimeout(graceTimer)
        graceTimer = setTimeout(() => finish(), EXEC_EXIT_GRACE_MS)
      })
      child.on('close', () => finish())

      armDeadline()
    })
  }

  /** Interrupt a running exec, or flag one that has not spawned yet. */
  abortExec(execId: string): void {
    this.abortedExecs.add(execId)
    const child = this.execProcs.get(execId)
    if (!child) return
    try {
      child.kill()
    } catch {
      // already gone
    }
  }

  // --- Chart samplers ----------------------------------------------------

  /**
   * Run a metric collector in its own process, mirroring `WslManager`.
   *
   * A pty rather than a pipe for the same reason as everywhere else: a piped
   * stdout makes `vmstat 1` block-buffer, which stalls the live chart for
   * seconds at a time.
   */
  async startSampler(
    sessionId: string,
    samplerId: string,
    command: string
  ): Promise<SamplerStartResult> {
    const session = this.sessions.get(sessionId)
    if (!session) return { error: 'Session not found.' }
    if (this.samplers.has(samplerId)) this.stopSampler(samplerId)

    try {
      const pty = await loadPty()
      const proc = pty.spawn(session.shell, execShellArgs(session.dialect, command), {
        name: 'dumb',
        // Wide enough that column layouts never wrap.
        cols: 250,
        rows: 40,
        cwd: session.cwd,
        env: process.env as Record<string, string>
      })
      this.samplers.set(samplerId, proc)

      proc.onData((data: string) => this.send('sampler:data', { samplerId, data }))
      proc.onExit(() => {
        this.samplers.delete(samplerId)
        this.send('sampler:end', { samplerId })
      })
      return {}
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.send('sampler:end', { samplerId, error: message })
      return { error: message }
    }
  }

  stopSampler(samplerId: string): void {
    const proc = this.samplers.get(samplerId)
    if (!proc) return
    this.samplers.delete(samplerId)
    try {
      proc.kill()
    } catch {
      // already exited
    }
  }

  private cleanup(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  disposeAll(): void {
    for (const id of [...this.samplers.keys()]) {
      this.stopSampler(id)
    }
    for (const id of [...this.execProcs.keys()]) {
      this.abortExec(id)
    }
    for (const id of [...this.sessions.keys()]) {
      this.close(id)
    }
  }
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

/** Shells the system advertises. Absent or unreadable is normal, not an error. */
function readEtcShells(): string[] {
  try {
    return readFileSync('/etc/shells', 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  } catch {
    return []
  }
}
