import { app, ipcMain, dialog, type BrowserWindow } from 'electron'
import { writeFile } from 'fs/promises'
import { basename } from 'path'
import { SshManager } from './ssh/manager'
import { deleteLocal, listLocal, localHome, renameLocal } from './local/fs'
import { AIProvider } from './ai/provider'
import * as config from './config/store'
import * as skills from './skills/store'
import type {
  AIChatRequest,
  AIChartSpecRequest,
  AIChartSpecResult,
  AIChunkEvent,
  AIReasoningEvent,
  AIDoneEvent,
  AIErrorEvent,
  AICompressHistoryRequest,
  AICompressHistoryResult,
  AISettings,
  AppLocale,
  AppTheme,
  AppInfo,
  AITranslateRequest,
  AITranslateResult,
  AISummarizeRequest,
  SkillInstallResult,
  SkillReadResult,
  BookmarkFolder,
  ConnectionConfig,
  ConnectOptions,
  CopilotChatState,
  TerminalAppearanceSettings,
  SftpListResult,
  SftpOpResult,
  SftpRealpathResult,
  SftpTransferResult,
  SftpBatchTransferResult,
  SftpTransferProgress,
  SftpTransferProgressEvent,
  SftpTransferDoneEvent,
  LocalListResult,
  LocalHomeResult,
  PickDirectoryResult,
  SaveFileResult
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
      onReasoning: (delta) =>
        e.sender.send('ai:reasoning', {
          requestId: req.requestId,
          delta
        } satisfies AIReasoningEvent),
      onDone: (content, toolCalls) =>
        e.sender.send('ai:done', {
          requestId: req.requestId,
          content,
          toolCalls
        } satisfies AIDoneEvent),
      onError: (error) =>
        e.sender.send('ai:error', { requestId: req.requestId, error } satisfies AIErrorEvent)
    })
  })
  ipcMain.on('ai:cancel', (_e, requestId: string) => ai.cancel(requestId))

  ipcMain.handle(
    'ai:compressHistory',
    async (_e, req: AICompressHistoryRequest): Promise<AICompressHistoryResult> => {
      try {
        return { summary: await ai.compressHistory(req) }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )

  // Phase-2 chart spec generation (structured JSON output, non-streaming).
  ipcMain.handle(
    'ai:chartSpec',
    async (_e, req: AIChartSpecRequest): Promise<AIChartSpecResult> => {
      try {
        return { spec: await ai.chartSpec(req) }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )

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

  // --- Local filesystem ---
  ipcMain.handle('local:home', (): LocalHomeResult => {
    try {
      return { path: localHome() }
    } catch (err) {
      return { error: errMessage(err) }
    }
  })
  ipcMain.handle('local:list', async (_e, path: string): Promise<LocalListResult> => {
    try {
      return await listLocal(path)
    } catch (err) {
      return { error: errMessage(err) }
    }
  })
  ipcMain.handle(
    'local:pickDirectory',
    async (_e, defaultPath?: string): Promise<PickDirectoryResult> => {
      const win = getWindow()
      const opts = { properties: ['openDirectory'] as const }
      const dialogOpts = {
        properties: [...opts.properties],
        ...(defaultPath ? { defaultPath } : {})
      }
      const result = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts)
      if (result.canceled || result.filePaths.length === 0) return { cancelled: true }
      return { path: result.filePaths[0] }
    }
  )
  ipcMain.handle(
    'local:rename',
    async (_e, from: string, to: string): Promise<SftpOpResult> => {
      try {
        await renameLocal(from, to)
        return { ok: true }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )
  ipcMain.handle(
    'local:delete',
    async (_e, path: string, isDir: boolean): Promise<SftpOpResult> => {
      try {
        await deleteLocal(path, isDir)
        return { ok: true }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )

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
    'sftp:uploadPaths',
    async (
      e,
      sessionId: string,
      localPaths: string[],
      remoteDir: string,
      transferId?: string
    ): Promise<SftpBatchTransferResult> => {
      const onProgress = transferId
        ? (progress: SftpTransferProgress): void => {
            e.sender.send('sftp:transferProgress', {
              ...progress,
              transferId,
              direction: 'upload'
            } satisfies SftpTransferProgressEvent)
          }
        : undefined
      const { count, errors } = await ssh.sftpUploadPaths(
        sessionId,
        localPaths,
        remoteDir,
        onProgress
      )
      if (transferId) {
        e.sender.send('sftp:transferDone', {
          transferId,
          direction: 'upload'
        } satisfies SftpTransferDoneEvent)
      }
      if (count === 0 && errors.length > 0) return { count: 0, errors, error: errors[0] }
      return { count, errors: errors.length > 0 ? errors : undefined }
    }
  )
  ipcMain.handle(
    'sftp:downloadPaths',
    async (
      e,
      sessionId: string,
      remotePaths: string[],
      localDir: string,
      transferId?: string
    ): Promise<SftpBatchTransferResult> => {
      const onProgress = transferId
        ? (progress: SftpTransferProgress): void => {
            e.sender.send('sftp:transferProgress', {
              ...progress,
              transferId,
              direction: 'download'
            } satisfies SftpTransferProgressEvent)
          }
        : undefined
      const { count, errors } = await ssh.sftpDownloadPaths(
        sessionId,
        remotePaths,
        localDir,
        onProgress
      )
      if (transferId) {
        e.sender.send('sftp:transferDone', {
          transferId,
          direction: 'download'
        } satisfies SftpTransferDoneEvent)
      }
      if (count === 0 && errors.length > 0) return { count: 0, errors, error: errors[0] }
      return { count, errors: errors.length > 0 ? errors : undefined }
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

  // --- Terminal ---
  ipcMain.handle(
    'terminal:saveLog',
    async (_e, content: string, defaultPath: string): Promise<SaveFileResult> => {
      const win = getWindow()
      const opts = {
        defaultPath,
        filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
      }
      const result = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts)
      if (result.canceled || !result.filePath) return { cancelled: true }
      try {
        await writeFile(result.filePath, content, 'utf8')
        return { path: result.filePath }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )

  // --- App ---
  ipcMain.handle(
    'app:getInfo',
    (): AppInfo => ({
      name: 'AI Terminal',
      version: app.getVersion(),
      description:
        'AI-Augmented multi-tab SSH terminal with an integrated AI Copilot side panel.',
      author: 'zackdlut',
      email: 'zack.dlut@gmail.com',
      license: 'MIT',
      electron: process.versions.electron ?? ''
    })
  )

  // --- Config ---
  ipcMain.handle('config:getAI', () => config.getAISettings())
  ipcMain.handle('config:setAI', (_e, settings: AISettings) => config.setAISettings(settings))
  ipcMain.handle('config:getTheme', () => config.getTheme())
  ipcMain.handle('config:setTheme', (_e, theme: AppTheme) => config.setTheme(theme))
  ipcMain.handle('config:getLocale', () => config.getLocale())
  ipcMain.handle('config:setLocale', (_e, locale: AppLocale) => config.setLocale(locale))
  ipcMain.handle('config:getTerminalAppearance', () => config.getTerminalAppearance())
  ipcMain.handle('config:setTerminalAppearance', (_e, settings: TerminalAppearanceSettings) =>
    config.setTerminalAppearance(settings)
  )
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
  ipcMain.handle('config:getCopilotChats', () => config.getCopilotChats())
  ipcMain.handle('config:setCopilotChats', (_e, state: CopilotChatState | null) =>
    config.setCopilotChats(state)
  )

  // --- Skills ---
  ipcMain.handle('skills:list', () => skills.listSkills())
  ipcMain.handle('skills:install', async (): Promise<SkillInstallResult> => {
    const win = getWindow()
    const dialogOpts = { properties: ['openDirectory' as const] }
    const result = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts)
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true }
    try {
      const skill = await skills.installSkill(result.filePaths[0])
      return { skill, skills: skills.listSkills() }
    } catch (err) {
      return { error: errMessage(err) }
    }
  })
  ipcMain.handle('skills:remove', (_e, id: string) => skills.removeSkill(id))
  ipcMain.handle('skills:setEnabled', (_e, id: string, enabled: boolean) =>
    skills.setSkillEnabled(id, enabled)
  )
  ipcMain.handle('skills:read', async (_e, idOrName: string): Promise<SkillReadResult> => {
    try {
      return { content: await skills.readSkillBody(idOrName) }
    } catch (err) {
      return { error: errMessage(err) }
    }
  })

  return ssh
}
