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
  SftpTransferProgress,
  SshDataEvent,
  SshStatusEvent
} from '../../shared/types'
import { countLocalTransferFiles } from '../local/fs'

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

  constructor(private getWindow: () => BrowserWindow | null) {}

  private emitData(event: SshDataEvent): void {
    this.getWindow()?.webContents.send('ssh:data', event)
  }

  private emitStatus(event: SshStatusEvent): void {
    this.getWindow()?.webContents.send('ssh:status', event)
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
