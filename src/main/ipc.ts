import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { basename } from 'path'
import { SshManager } from './ssh/manager'
import { AIProvider } from './ai/provider'
import * as config from './config/store'
import type {
  AIChatRequest,
  AIChunkEvent,
  AIDoneEvent,
  AIErrorEvent,
  AISettings,
  AITranslateRequest,
  AITranslateResult,
  AISummarizeRequest,
  BookmarkFolder,
  ConnectionConfig,
  ConnectOptions,
  SftpListResult,
  SftpOpResult,
  SftpRealpathResult,
  SftpTransferResult
} from '../shared/types'

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function registerIpc(getWindow: () => BrowserWindow | null): SshManager {
  const ssh = new SshManager(getWindow)
  const ai = new AIProvider(() => config.getAISettings())

  // --- SSH ---
  ipcMain.handle('ssh:connect', (_e, opts: ConnectOptions) => ssh.connect(opts))
  ipcMain.on('ssh:write', (_e, sessionId: string, data: string) => ssh.write(sessionId, data))
  ipcMain.on('ssh:resize', (_e, sessionId: string, cols: number, rows: number) =>
    ssh.resize(sessionId, cols, rows)
  )
  ipcMain.on('ssh:close', (_e, sessionId: string) => ssh.close(sessionId))

  // --- AI (streaming) ---
  ipcMain.on('ai:chat', (e, req: AIChatRequest) => {
    void ai.chat(req, {
      onChunk: (delta) =>
        e.sender.send('ai:chunk', { requestId: req.requestId, delta } satisfies AIChunkEvent),
      onDone: (content) =>
        e.sender.send('ai:done', { requestId: req.requestId, content } satisfies AIDoneEvent),
      onError: (error) =>
        e.sender.send('ai:error', { requestId: req.requestId, error } satisfies AIErrorEvent)
    })
  })
  ipcMain.on('ai:cancel', (_e, requestId: string) => ai.cancel(requestId))

  // One-shot NL -> command translation for the in-terminal NL mode.
  ipcMain.handle(
    'ai:translate',
    async (_e, req: AITranslateRequest): Promise<AITranslateResult> => {
      try {
        return { content: await ai.translate(req) }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )

  // Stream command execution summary for the in-terminal NL mode.
  ipcMain.on('ai:summarize', (e, req: AISummarizeRequest) => {
    void ai.summarize(req, {
      onChunk: (delta) =>
        e.sender.send('ai:chunk', { requestId: req.requestId, delta } satisfies AIChunkEvent),
      onDone: (content) =>
        e.sender.send('ai:done', { requestId: req.requestId, content } satisfies AIDoneEvent),
      onError: (error) =>
        e.sender.send('ai:error', { requestId: req.requestId, error } satisfies AIErrorEvent)
    })
  })

  // --- SFTP ---
  ipcMain.handle('sftp:list', async (_e, sessionId: string, path: string): Promise<SftpListResult> => {
    try {
      return await ssh.sftpList(sessionId, path)
    } catch (err) {
      return { error: errMessage(err) }
    }
  })
  ipcMain.handle(
    'sftp:realpath',
    async (_e, sessionId: string, path: string): Promise<SftpRealpathResult> => {
      try {
        return { path: await ssh.sftpRealpath(sessionId, path) }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )
  ipcMain.handle('sftp:mkdir', async (_e, sessionId: string, path: string): Promise<SftpOpResult> => {
    try {
      await ssh.sftpMkdir(sessionId, path)
      return { ok: true }
    } catch (err) {
      return { error: errMessage(err) }
    }
  })
  ipcMain.handle(
    'sftp:rename',
    async (_e, sessionId: string, from: string, to: string): Promise<SftpOpResult> => {
      try {
        await ssh.sftpRename(sessionId, from, to)
        return { ok: true }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )
  ipcMain.handle(
    'sftp:delete',
    async (_e, sessionId: string, path: string, isDir: boolean): Promise<SftpOpResult> => {
      try {
        await ssh.sftpDelete(sessionId, path, isDir)
        return { ok: true }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )
  ipcMain.handle(
    'sftp:download',
    async (_e, sessionId: string, remotePath: string): Promise<SftpTransferResult> => {
      const win = getWindow()
      const result = win
        ? await dialog.showSaveDialog(win, { defaultPath: basename(remotePath) })
        : await dialog.showSaveDialog({ defaultPath: basename(remotePath) })
      if (result.canceled || !result.filePath) return { cancelled: true }
      try {
        await ssh.sftpDownload(sessionId, remotePath, result.filePath)
        return { count: 1 }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )
  ipcMain.handle(
    'sftp:upload',
    async (_e, sessionId: string, remoteDir: string): Promise<SftpTransferResult> => {
      const win = getWindow()
      const opts = { properties: ['openFile', 'multiSelections'] as const }
      const result = win
        ? await dialog.showOpenDialog(win, { properties: [...opts.properties] })
        : await dialog.showOpenDialog({ properties: [...opts.properties] })
      if (result.canceled || result.filePaths.length === 0) return { cancelled: true }
      try {
        for (const local of result.filePaths) {
          await ssh.sftpUpload(sessionId, local, remoteDir)
        }
        return { count: result.filePaths.length }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )

  // --- Config ---
  ipcMain.handle('config:getAI', () => config.getAISettings())
  ipcMain.handle('config:setAI', (_e, settings: AISettings) => config.setAISettings(settings))
  ipcMain.handle('config:getConnections', () => config.getConnections())
  ipcMain.handle('config:saveConnection', (_e, conn: ConnectionConfig) =>
    config.saveConnection(conn)
  )
  ipcMain.handle('config:deleteConnection', (_e, id: string) => config.deleteConnection(id))
  ipcMain.handle('config:setConnections', (_e, list: ConnectionConfig[]) =>
    config.setConnections(list)
  )
  ipcMain.handle('config:getFolders', () => config.getFolders())
  ipcMain.handle('config:saveFolder', (_e, folder: BookmarkFolder) => config.saveFolder(folder))
  ipcMain.handle('config:setFolders', (_e, list: BookmarkFolder[]) => config.setFolders(list))
  ipcMain.handle('config:deleteFolder', (_e, id: string) => config.deleteFolder(id))

  return ssh
}
