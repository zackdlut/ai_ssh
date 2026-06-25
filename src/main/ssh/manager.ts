import { Client, type ClientChannel } from 'ssh2'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type { ConnectOptions, ConnectResult, SshDataEvent, SshStatusEvent } from '../../shared/types'

interface Session {
  client: Client
  stream?: ClientChannel
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
    this.sessions.delete(sessionId)
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id)
    }
  }
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
