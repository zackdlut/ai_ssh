import { Client, type ClientChannel, type SFTPWrapper, type FileEntry } from 'ssh2'
import { readFileSync } from 'fs'
import { basename } from 'path'
import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type {
  ConnectOptions,
  ConnectResult,
  SftpEntry,
  SftpEntryType,
  SshDataEvent,
  SshStatusEvent
} from '../../shared/types'

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

  constructor(private getWindow: () => BrowserWindow | null) {}

  private emitData(event: SshDataEvent): void {
    this.getWindow()?.webContents.send('ssh:data', event)
  }

  private emitStatus(event: SshStatusEvent): void {
    this.getWindow()?.webContents.send('ssh:status', event)
  }

  connect(opts: ConnectOptions): Promise<ConnectResult> {
    return new Promise((resolve) => {
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

  async sftpRename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    })
  }

  async sftpDelete(sessionId: string, path: string, isDir: boolean): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null | undefined): void => (err ? reject(err) : resolve())
      if (isDir) sftp.rmdir(path, cb)
      else sftp.unlink(path, cb)
    })
  }

  async sftpDownload(sessionId: string, remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve()))
    })
  }

  async sftpUpload(sessionId: string, localPath: string, remoteDir: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    const remotePath = `${remoteDir.endsWith('/') ? remoteDir.slice(0, -1) : remoteDir}/${basename(localPath)}`
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()))
    })
  }

  disposeAll(): void {
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
