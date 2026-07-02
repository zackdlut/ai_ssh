import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type {
  ConnectResult,
  SshDataEvent,
  SshStatusEvent,
  WslConnectOptions,
  WslDistro
} from '../../shared/types'

type NodePtyModule = typeof import('node-pty')
let ptyModule: NodePtyModule | null = null

async function loadPty(): Promise<NodePtyModule> {
  if (!ptyModule) ptyModule = await import('node-pty')
  return ptyModule
}

interface PtyLike {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

interface Session {
  proc: PtyLike
}

/**
 * Manages local WSL pseudo-terminal sessions via node-pty (ConPTY on Windows),
 * one per terminal tab. Reuses the same `ssh:data` / `ssh:status` renderer
 * events as SshManager so the terminal UI works unchanged.
 */
export class WslManager {
  private sessions = new Map<string, Session>()

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

  /** List installed WSL distributions. Returns [] on non-Windows platforms. */
  async listDistros(): Promise<WslDistro[]> {
    if (process.platform !== 'win32') return []
    const raw = await new Promise<string>((resolve, reject) => {
      // `-l -q` prints one distro name per line. Output is UTF-16LE.
      execFile(
        'wsl.exe',
        ['-l', '-q'],
        { encoding: 'buffer', windowsHide: true },
        (err, stdout) => {
          if (err) return reject(err)
          resolve(Buffer.from(stdout).toString('utf16le'))
        }
      )
    })
    return raw
      .split(/\r?\n/)
      .map((line) => line.replace(/\0/g, '').trim())
      .filter((name) => name.length > 0)
      .map((name) => ({ name }))
  }

  async connect(opts: WslConnectOptions): Promise<ConnectResult> {
    if (process.platform !== 'win32') {
      return { error: 'WSL is only available on Windows.' }
    }
    const sessionId = randomUUID()
    this.emitStatus({ sessionId, status: 'connecting' })

    try {
      const pty = await loadPty()
      const args: string[] = []
      if (opts.distro) args.push('-d', opts.distro)
      if (opts.user) args.push('-u', opts.user)

      const proc = pty.spawn('wsl.exe', args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.env.USERPROFILE || process.env.HOME || undefined,
        env: process.env as Record<string, string>
      })

      this.sessions.set(sessionId, { proc })

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

  private cleanup(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id)
    }
  }
}
