import type { Client, ClientChannel, SFTPWrapper, FileEntry } from 'ssh2'

type Ssh2Module = typeof import('ssh2')
let ssh2Module: Ssh2Module | null = null

async function loadSsh2(): Promise<Ssh2Module> {
  if (!ssh2Module) ssh2Module = await import('ssh2')
  return ssh2Module
}
import { readFileSync } from 'fs'
import { basename, join } from 'path'
import { mkdir, readdir, stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type {
  ConnectOptions,
  ConnectResult,
  SftpEntry,
  SftpEntryType,
  SftpReadText,
  SftpStat,
  SftpTransferProgress,
  SamplerStartResult,
  SshDataEvent,
  SshExecResult,
  SshExecOptions,
  SshStatusEvent
} from '../../shared/types'
import { nextExecDeadline } from '../../shared/execTimeout'
import { countLocalTransferFiles } from '../local/fs'

/** Default cap for a single `sftpReadText` window. */
const SFTP_READ_MAX_BYTES = 512 * 1024

/** Largest stdout/stderr buffer retained for one exec (tail-biased). */
const EXEC_BUFFER_MAX = 512 * 1024

/** Sentinel used to carry the post-command working directory out of stdout. */
const EXEC_CWD_MARKER = '__AISSH_CWD__:'

/** How long an abort flag waits for a channel that may still be opening. */
const ABORT_FLAG_TTL_MS = 30_000

/** Quote a value for safe interpolation into a POSIX shell command. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Pull the trailing cwd sentinel out of captured stdout. */
function splitCwdMarker(stdout: string): { text: string; cwd?: string } {
  const idx = stdout.lastIndexOf(EXEC_CWD_MARKER)
  if (idx === -1) return { text: stdout }
  const after = stdout.slice(idx + EXEC_CWD_MARKER.length)
  const cwd = after.split('\n')[0]?.trim()
  return {
    text: stdout.slice(0, idx).replace(/\n$/, ''),
    cwd: cwd || undefined
  }
}

interface TransferProgressTracker {
  startFile: (fileName: string, bytesTotal: number) => void
  updateFile: (fileName: string, bytesDone: number, bytesTotal: number) => void
}

function createTransferProgressTracker(
  fileTotal: number,
  onProgress?: (progress: SftpTransferProgress) => void
): TransferProgressTracker | undefined {
  if (!onProgress) return undefined
  let fileIndex = 0
  const emit = (fileName: string, bytesDone: number, bytesTotal: number): void => {
    onProgress({ fileName, fileIndex, fileTotal, bytesDone, bytesTotal })
  }
  return {
    startFile(fileName: string, bytesTotal: number) {
      fileIndex++
      emit(fileName, 0, bytesTotal)
    },
    updateFile(fileName: string, bytesDone: number, bytesTotal: number) {
      emit(fileName, bytesDone, bytesTotal)
    }
  }
}

interface Session {
  client: Client
  stream?: ClientChannel
  sftp?: SFTPWrapper
}

/**
 * Manages interactive SSH shell sessions, one per terminal tab.
 * Output is streamed back to the renderer via webContents events.
 */
export class SshManager {
  private sessions = new Map<string, Session>()
  /** In-flight exec channels, keyed by the renderer's exec id, for abort. */
  private execChannels = new Map<string, ClientChannel>()
  /** Long-running chart sampler channels, keyed by sampler id. */
  private samplers = new Map<string, ClientChannel>()
  /** Exec ids aborted before (or while) their channel opened. */
  private abortedExecs = new Set<string>()

  constructor(private getWindow: () => BrowserWindow | null) {}

  /**
   * Send to the renderer, guarding against a window/webContents that has
   * already been destroyed (e.g. SSH 'close' fires while the app is quitting).
   */
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

  connect(opts: ConnectOptions): Promise<ConnectResult> {
    return loadSsh2().then(({ Client }) => {
      return new Promise<ConnectResult>((resolve) => {
      const sessionId = randomUUID()
      const client = new Client()
      this.sessions.set(sessionId, { client })

      let settled = false
      const fail = (message: string): void => {
        this.emitStatus({ sessionId, status: 'error', message })
        if (!settled) {
          settled = true
          resolve({ error: message })
        }
        this.cleanup(sessionId)
      }

      this.emitStatus({ sessionId, status: 'connecting' })

      client.on('ready', () => {
        client.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) return fail(err.message)
          const session = this.sessions.get(sessionId)
          if (!session) return
          session.stream = stream

          stream.on('data', (chunk: Buffer) => {
            this.emitData({ sessionId, data: chunk.toString('utf8') })
          })
          stream.stderr.on('data', (chunk: Buffer) => {
            this.emitData({ sessionId, data: chunk.toString('utf8') })
          })
          stream.on('close', () => {
            this.emitStatus({ sessionId, status: 'closed' })
            this.cleanup(sessionId)
          })

          this.emitStatus({ sessionId, status: 'connected' })
          if (!settled) {
            settled = true
            resolve({ sessionId })
          }
        })
      })

      client.on('error', (err) => fail(err.message))
      client.on('close', () => {
        this.emitStatus({ sessionId, status: 'closed' })
        this.cleanup(sessionId)
      })

      try {
        client.connect({
          host: opts.host,
          port: opts.port || 22,
          username: opts.username,
          password: opts.password || undefined,
          privateKey: resolvePrivateKey(opts.privateKey),
          passphrase: opts.passphrase || undefined,
          readyTimeout: 20000,
          keepaliveInterval: 15000
        })
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e))
      }
    })
    })
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.stream?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.stream?.setWindow(rows, cols, 0, 0)
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    try {
      session.stream?.end()
      session.client.end()
    } catch {
      // ignore
    }
    this.cleanup(sessionId)
  }

  // --- Non-interactive exec ---------------------------------------------

  /**
   * Run a command on its own SSH channel and return the captured result.
   *
   * The agent used to run commands by typing them into the user's interactive
   * shell and watching the terminal stream. That shared one shell between two
   * writers: a keystroke typed while the agent was mid-capture landed inside
   * the agent's command, and the agent's own output scrolled through the user's
   * terminal as noise. A dedicated channel gives each call isolated stdout,
   * stderr, and a real exit status from the protocol itself.
   *
   * The channel starts in the login directory, so `opts.cwd` re-enters the
   * directory the agent believes it is in — otherwise a `cd` in one call would
   * silently not apply to the next.
   *
   * Timeouts match Execute capture: stdout/stderr postpone the stall window
   * (`opts.timeoutMs`); `opts.absoluteMaxMs` is the wall-clock ceiling.
   */
  execCommand(
    sessionId: string,
    execId: string,
    command: string,
    opts?: SshExecOptions
  ): Promise<SshExecResult> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve({ stdout: '', stderr: '', code: null, error: 'Session not found.' })

    const prefix = opts?.cwd ? `cd ${shellSingleQuote(opts.cwd)} 2>/dev/null; ` : ''
    const wrapped = `${prefix}${command}\n__aissh_ec=$?; printf '\\n${EXEC_CWD_MARKER}%s\\n' "$(pwd 2>/dev/null)"; exit $__aissh_ec`

    return new Promise<SshExecResult>((resolve) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const stallMs = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 0
      const absoluteMaxMs = opts?.absoluteMaxMs && opts.absoluteMaxMs > 0 ? opts.absoluteMaxMs : 0

      const finish = (extra?: Partial<SshExecResult>): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.execChannels.delete(execId)
        const { text, cwd } = splitCwdMarker(stdout)
        resolve({
          stdout: text,
          stderr,
          code,
          cwd,
          timedOut,
          aborted: this.abortedExecs.delete(execId) || undefined,
          ...extra
        })
      }

      session.client.exec(wrapped, { pty: false }, (err, stream) => {
        if (err) return finish({ error: err.message })
        // An abort that raced the channel opening would otherwise be lost.
        if (this.abortedExecs.has(execId)) {
          try {
            stream.close()
          } catch {
            // ignore
          }
          return finish()
        }
        this.execChannels.set(execId, stream)
        const startedAt = Date.now()

        const onTimeout = (): void => {
          timedOut = true
          try {
            stream.close()
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

        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
          if (stdout.length > EXEC_BUFFER_MAX) stdout = stdout.slice(-EXEC_BUFFER_MAX)
          armDeadline()
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
          if (stderr.length > EXEC_BUFFER_MAX) stderr = stderr.slice(-EXEC_BUFFER_MAX)
          armDeadline()
        })
        stream.on('exit', (exitCode: number | null) => {
          code = typeof exitCode === 'number' ? exitCode : null
        })
        stream.on('close', () => finish())
        stream.on('error', (streamErr: Error) => finish({ error: streamErr.message }))
        armDeadline()
      })
    })
  }

  /**
   * Interrupt a running exec. `signal()` is best-effort — OpenSSH declines
   * signal requests by default — so the channel is closed as well, which drops
   * the remote process's controlling channel and terminates it in practice.
   */
  abortExec(execId: string): void {
    this.abortedExecs.add(execId)
    const stream = this.execChannels.get(execId)
    if (!stream) {
      // Either the channel is still opening (the flag will be consumed there)
      // or the exec already finished, in which case nothing consumes it.
      setTimeout(() => this.abortedExecs.delete(execId), ABORT_FLAG_TTL_MS)
      return
    }
    try {
      stream.signal('INT')
    } catch {
      // ignore
    }
    try {
      stream.close()
    } catch {
      // ignore
    }
  }

  // --- Chart samplers ----------------------------------------------------

  /**
   * Start a long-running metric collector on its own channel and stream its
   * output back as `sampler:data`.
   *
   * Charts used to be fed by typing the collection command into the user's
   * interactive shell and listening to the terminal stream. That polluted the
   * visible terminal, fought with the user's keystrokes, and required sending
   * Ctrl-C to stop — which could kill whatever the user had in the foreground.
   * A private channel keeps the collector invisible and independently killable.
   *
   * A pty is requested deliberately: with a pipe on stdout, glibc switches to
   * full buffering and `vmstat 1` would arrive in 4 KB bursts many seconds
   * apart, which defeats the point of a live chart. A tty is line-buffered.
   */
  startSampler(sessionId: string, samplerId: string, command: string): Promise<SamplerStartResult> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve({ error: 'Session not found.' })
    if (this.samplers.has(samplerId)) this.stopSampler(samplerId)

    return new Promise<SamplerStartResult>((resolve) => {
      session.client.exec(
        command,
        // A wide, dumb terminal: no line wrapping to break up column layouts,
        // and no cursor addressing to strip back out.
        { pty: { rows: 40, cols: 250, term: 'dumb', height: 0, width: 0 } },
        (err, stream) => {
          if (err) return resolve({ error: err.message })
          this.samplers.set(samplerId, stream)

          const emit = (chunk: Buffer): void =>
            this.send('sampler:data', { samplerId, data: chunk.toString('utf8') })
          stream.on('data', emit)
          stream.stderr.on('data', emit)
          stream.on('close', () => {
            this.samplers.delete(samplerId)
            this.send('sampler:end', { samplerId })
          })
          stream.on('error', (streamErr: Error) => {
            this.samplers.delete(samplerId)
            this.send('sampler:end', { samplerId, error: streamErr.message })
          })
          resolve({})
        }
      )
    })
  }

  /** Stop a sampler. Same best-effort signal-then-close dance as `abortExec`. */
  stopSampler(samplerId: string): void {
    const stream = this.samplers.get(samplerId)
    if (!stream) return
    this.samplers.delete(samplerId)
    try {
      stream.signal('INT')
    } catch {
      // ignore
    }
    try {
      stream.close()
    } catch {
      // ignore
    }
  }

  private cleanup(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    try {
      session?.sftp?.end()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  // --- SFTP -------------------------------------------------------------

  /** Lazily open (and cache) an SFTP channel on the session's SSH client. */
  private getSftp(sessionId: string): Promise<SFTPWrapper> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.reject(new Error('Session not found.'))
    if (session.sftp) return Promise.resolve(session.sftp)
    return new Promise((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) return reject(err)
        session.sftp = sftp
        // If the channel dies, drop the cache so the next call reopens it.
        sftp.on('close', () => {
          if (session.sftp === sftp) session.sftp = undefined
        })
        resolve(sftp)
      })
    })
  }

  async sftpRealpath(sessionId: string, path: string): Promise<string> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.realpath(path, (err, absPath) => (err ? reject(err) : resolve(absPath)))
    })
  }

  async sftpList(sessionId: string, path: string): Promise<{ cwd: string; entries: SftpEntry[] }> {
    const sftp = await this.getSftp(sessionId)
    const cwd = await this.sftpRealpath(sessionId, path)
    const list: FileEntry[] = await new Promise((resolve, reject) => {
      sftp.readdir(cwd, (err, entries) => (err ? reject(err) : resolve(entries)))
    })
    const sep = cwd.endsWith('/') ? '' : '/'
    const entries: SftpEntry[] = list.map((e) => {
      const attrs = e.attrs
      const type = fileTypeFromMode(attrs.mode ?? 0)
      return {
        name: e.filename,
        path: `${cwd}${sep}${e.filename}`,
        type,
        size: attrs.size ?? 0,
        mtime: (attrs.mtime ?? 0) * 1000,
        mode: attrs.mode ?? 0
      }
    })
    entries.sort((a, b) => {
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { cwd, entries }
  }

  async sftpMkdir(sessionId: string, path: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.mkdir(path, (err) => (err ? reject(err) : resolve()))
    })
  }

  async sftpStat(sessionId: string, path: string): Promise<SftpStat> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.stat(path, (err, stats) => {
        if (err) return reject(err)
        const mode = stats.mode ?? 0
        resolve({
          size: stats.size ?? 0,
          mode,
          mtime: (stats.mtime ?? 0) * 1000,
          type: fileTypeFromMode(mode)
        })
      })
    })
  }

  /**
   * Read a bounded byte window of a remote file as UTF-8 text.
   *
   * The agent's file tools need contents in memory, not on local disk, so this
   * streams a `[startByte, startByte + maxBytes)` range rather than reusing
   * `fastGet`. The window is capped so a stray `read_file` on a multi-gigabyte
   * log can never blow up the renderer or the model's context.
   */
  async sftpReadText(
    sessionId: string,
    path: string,
    opts?: { startByte?: number; maxBytes?: number }
  ): Promise<SftpReadText> {
    const info = await this.sftpStat(sessionId, path)
    if (info.type === 'dir') {
      throw new Error(`"${path}" is a directory, not a file.`)
    }
    const start = Math.max(0, Math.trunc(opts?.startByte ?? 0))
    const maxBytes = Math.max(1, Math.trunc(opts?.maxBytes ?? SFTP_READ_MAX_BYTES))
    if (start >= info.size) {
      return { text: '', size: info.size, startByte: start, bytesRead: 0, truncated: false }
    }

    const sftp = await this.getSftp(sessionId)
    const end = Math.min(info.size - 1, start + maxBytes - 1)
    const chunks: Buffer[] = await new Promise((resolve, reject) => {
      const acc: Buffer[] = []
      const stream = sftp.createReadStream(path, { start, end })
      stream.on('data', (chunk: Buffer | string) => {
        acc.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
      })
      stream.on('error', reject)
      stream.on('close', () => resolve(acc))
    })

    const buffer = Buffer.concat(chunks)
    return {
      text: buffer.toString('utf8'),
      size: info.size,
      startByte: start,
      bytesRead: buffer.length,
      truncated: start + buffer.length < info.size
    }
  }

  /**
   * Overwrite a remote file with UTF-8 text, preserving its existing permission
   * bits. Without the explicit chmod, editing something like `/etc/nginx/*.conf`
   * or a shell script would silently reset it to the SFTP default mode.
   */
  async sftpWriteText(sessionId: string, path: string, content: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    const previousMode = await this.sftpStat(sessionId, path)
      .then((s) => s.mode & 0o7777)
      .catch(() => null)

    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, content, { encoding: 'utf8' }, (err) =>
        err ? reject(err) : resolve()
      )
    })

    if (previousMode !== null) {
      await new Promise<void>((resolve) => {
        sftp.chmod(path, previousMode, () => resolve())
      })
    }
  }

  async sftpRename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    })
  }

  async sftpDelete(sessionId: string, path: string, isDir: boolean): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    if (!isDir) {
      return new Promise((resolve, reject) => {
        sftp.unlink(path, (err) => (err ? reject(err) : resolve()))
      })
    }
    const { entries } = await this.sftpList(sessionId, path)
    for (const entry of entries) {
      await this.sftpDelete(sessionId, entry.path, entry.type === 'dir')
    }
    return new Promise((resolve, reject) => {
      sftp.rmdir(path, (err) => (err ? reject(err) : resolve()))
    })
  }

  async sftpUploadEntry(
    sessionId: string,
    localPath: string,
    remoteDir: string,
    tracker?: TransferProgressTracker
  ): Promise<number> {
    const info = await stat(localPath)
    if (info.isDirectory()) {
      const remoteBase = `${remoteDir.replace(/\/$/, '')}/${basename(localPath)}`
      await this.ensureRemoteDir(sessionId, remoteBase)
      const names = await readdir(localPath)
      let count = 0
      for (const name of names) {
        count += await this.sftpUploadEntry(sessionId, join(localPath, name), remoteBase, tracker)
      }
      return count
    }
    if (info.isFile()) {
      const fileName = basename(localPath)
      await this.ensureRemoteDir(sessionId, remoteDir)
      tracker?.startFile(fileName, info.size)
      await this.sftpUpload(sessionId, localPath, remoteDir, (bytesDone, bytesTotal) => {
        tracker?.updateFile(fileName, bytesDone, bytesTotal)
      })
      return 1
    }
    return 0
  }

  async sftpDownloadEntry(
    sessionId: string,
    remotePath: string,
    localDir: string,
    tracker?: TransferProgressTracker
  ): Promise<number> {
    const kind = await this.sftpEntryKind(sessionId, remotePath)
    const localDest = join(localDir, basename(remotePath))
    if (kind === 'dir') {
      await mkdir(localDest, { recursive: true })
      const { entries } = await this.sftpList(sessionId, remotePath)
      let count = 0
      for (const entry of entries) {
        count += await this.sftpDownloadEntry(sessionId, entry.path, localDest, tracker)
      }
      return count
    }
    if (kind === 'file') {
      const fileName = basename(remotePath)
      const remoteSize = await this.sftpFileSize(sessionId, remotePath)
      await mkdir(localDir, { recursive: true })
      tracker?.startFile(fileName, remoteSize)
      await this.sftpDownload(sessionId, remotePath, localDest, (bytesDone, bytesTotal) => {
        tracker?.updateFile(fileName, bytesDone, bytesTotal)
      })
      return 1
    }
    return 0
  }

  async sftpUploadPaths(
    sessionId: string,
    localPaths: string[],
    remoteDir: string,
    onProgress?: (progress: SftpTransferProgress) => void
  ): Promise<{ count: number; errors: string[] }> {
    const fileTotal = await countLocalTransferFiles(localPaths)
    const tracker = createTransferProgressTracker(fileTotal, onProgress)
    const errors: string[] = []
    let count = 0
    for (const local of localPaths) {
      try {
        count += await this.sftpUploadEntry(sessionId, local, remoteDir, tracker)
      } catch (err) {
        errors.push(`${basename(local)}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { count, errors }
  }

  async sftpDownloadPaths(
    sessionId: string,
    remotePaths: string[],
    localDir: string,
    onProgress?: (progress: SftpTransferProgress) => void
  ): Promise<{ count: number; errors: string[] }> {
    const fileTotal = await this.countRemoteTransferFiles(sessionId, remotePaths)
    const tracker = createTransferProgressTracker(fileTotal, onProgress)
    const errors: string[] = []
    let count = 0
    for (const remote of remotePaths) {
      try {
        count += await this.sftpDownloadEntry(sessionId, remote, localDir, tracker)
      } catch (err) {
        errors.push(`${basename(remote)}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { count, errors }
  }

  async countRemoteTransferFiles(sessionId: string, paths: string[]): Promise<number> {
    let total = 0
    for (const path of paths) {
      total += await this.countRemotePathFiles(sessionId, path)
    }
    return total
  }

  private async countRemotePathFiles(sessionId: string, path: string): Promise<number> {
    const kind = await this.sftpEntryKind(sessionId, path)
    if (kind === 'file') return 1
    if (kind !== 'dir') return 0
    const { entries } = await this.sftpList(sessionId, path)
    let count = 0
    for (const entry of entries) {
      count += await this.countRemotePathFiles(sessionId, entry.path)
    }
    return count
  }

  private async sftpFileSize(sessionId: string, path: string): Promise<number> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats.size ?? 0)))
    })
  }

  private async sftpEntryKind(
    sessionId: string,
    path: string
  ): Promise<'dir' | 'file' | 'other'> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.stat(path, (err, stats) => {
        if (err) return reject(err)
        const type = fileTypeFromMode(stats.mode ?? 0)
        if (type === 'dir') resolve('dir')
        else if (type === 'file') resolve('file')
        else resolve('other')
      })
    })
  }

  private async ensureRemoteDir(sessionId: string, dirPath: string): Promise<void> {
    const normalized = dirPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
    if (!normalized || normalized === '/') return

    const isAbsolute = normalized.startsWith('/')
    const parts = normalized.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : isAbsolute ? `/${part}` : part
      await this.sftpMkdirOne(sessionId, current)
    }
  }

  private async sftpMkdirOne(sessionId: string, path: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.stat(path, (statErr) => {
        if (!statErr) return resolve()
        sftp.mkdir(path, (mkdirErr) => {
          if (!mkdirErr) return resolve()
          sftp.stat(path, (err2) => (err2 ? reject(mkdirErr) : resolve()))
        })
      })
    })
  }

  async sftpDownload(
    sessionId: string,
    remotePath: string,
    localPath: string,
    onStep?: (bytesDone: number, bytesTotal: number) => void
  ): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null | undefined): void => (err ? reject(err) : resolve())
      if (onStep) {
        sftp.fastGet(
          remotePath,
          localPath,
          { step: (transferred, _chunk, total) => onStep(transferred, total) },
          cb
        )
      } else {
        sftp.fastGet(remotePath, localPath, cb)
      }
    })
  }

  async sftpUpload(
    sessionId: string,
    localPath: string,
    remoteDir: string,
    onStep?: (bytesDone: number, bytesTotal: number) => void
  ): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    const remotePath = `${remoteDir.endsWith('/') ? remoteDir.slice(0, -1) : remoteDir}/${basename(localPath)}`
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null | undefined): void => (err ? reject(err) : resolve())
      if (onStep) {
        sftp.fastPut(
          localPath,
          remotePath,
          { step: (transferred, _chunk, total) => onStep(transferred, total) },
          cb
        )
      } else {
        sftp.fastPut(localPath, remotePath, cb)
      }
    })
  }

  disposeAll(): void {
    for (const id of [...this.samplers.keys()]) {
      this.stopSampler(id)
    }
    for (const id of [...this.sessions.keys()]) {
      this.close(id)
    }
  }
}

// POSIX file-type bits (the high bits of the mode field).
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000

function fileTypeFromMode(mode: number): SftpEntryType {
  const t = mode & S_IFMT
  if (t === S_IFDIR) return 'dir'
  if (t === S_IFLNK) return 'link'
  if (t === S_IFREG) return 'file'
  return 'other'
}

/**
 * Accepts either a private key file path or the raw key contents and returns
 * the key contents, or undefined if not provided.
 */
function resolvePrivateKey(value?: string): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (trimmed.includes('BEGIN') && trimmed.includes('PRIVATE KEY')) {
    return trimmed
  }
  try {
    return readFileSync(trimmed, 'utf8')
  } catch {
    // Fall back to treating the value as raw key material.
    return value
  }
}
