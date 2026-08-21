import { app, ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { SshManager } from './ssh/manager'
import { WslManager } from './wsl/manager'
import { deleteLocal, listLocal, localHome, renameLocal, resolveLocal } from './local/fs'
import { AIProvider } from './ai/provider'
import * as config from './config/store'
import { exportBookmarks, importBookmarks } from './config/transfer'
import * as skills from './skills/store'
import { initDebugLogger, logDebug } from './debug/logger'
import { truncateForDebug } from '../shared/debugSanitize'
import { remoteTempPath } from '../shared/sftpTempPath'
import type { DebugLogPayload } from '../shared/debugLog'
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
  BookmarkTransferFormat,
  ConnectionConfig,
  ConnectOptions,
  SamplerStartResult,
  SshExecOptions,
  SshExecResult,
  WslConnectOptions,
  CopilotChatState,
  ExportSessionsResult,
  ImportSessionsResult,
  KeybindingsSettings,
  TerminalAppearanceSettings,
  SftpListResult,
  SftpOpResult,
  SftpRealpathResult,
  SftpReadTextResult,
  SftpStatResult,
  SftpTransferResult,
  SftpBatchTransferResult,
  SftpTransferProgress,
  SftpTransferProgressEvent,
  SftpTransferDoneEvent,
  LocalListResult,
  LocalHomeResult,
  OpenPathResult,
  PickDirectoryResult,
  SaveFileResult
} from '../shared/types'

/** Temp subdirectory holding the local copies of remote files opened externally. */
const SFTP_OPEN_TEMP_DIR = 'ai-augmented-terminal-sftp'

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function transferFilter(format: BookmarkTransferFormat): Electron.FileFilter {
  return format === 'json'
    ? { name: 'Connections (JSON)', extensions: ['json'] }
    : { name: 'SuperPuTTY Sessions', extensions: ['xml', 'XML'] }
}

export interface IpcManagers {
  ssh: SshManager
  wsl: WslManager
  disposeAll: () => void
}

export function registerIpc(getWindow: () => BrowserWindow | null): IpcManagers {
  initDebugLogger(() => config.getDebugLogSettings().enabled)

  const ssh = new SshManager(getWindow)
  const wsl = new WslManager(getWindow)
  const ai = new AIProvider(
    () => config.getAISettings(),
    () => config.getLocale(),
    () => config.getSkills()
  )

  // --- Debug log ---
  ipcMain.on('debug:log', (_e, entry: DebugLogPayload) => {
    logDebug(entry)
  })
  ipcMain.handle('debug:getSettings', () => config.getDebugLogSettings())
  ipcMain.handle('debug:setEnabled', (_e, enabled: boolean) => config.setDebugLogEnabled(enabled))

  // --- SSH ---
  ipcMain.handle('ssh:connect', (_e, opts: ConnectOptions) => {
    logDebug({
      category: 'ipc',
      message: 'ssh:connect',
      data: { host: opts.host, port: opts.port, username: opts.username }
    })
    return ssh.connect(opts)
  })
  // write/resize/close are shared across SSH and WSL sessions; route by owner.
  ipcMain.on('ssh:write', (_e, sessionId: string, data: string) => {
    logDebug({
      category: 'ipc',
      message: 'ssh:write',
      sessionId_ssh: sessionId,
      data: { data: truncateForDebug(data) }
    })
    if (wsl.has(sessionId)) wsl.write(sessionId, data)
    else ssh.write(sessionId, data)
  })
  ipcMain.on('ssh:resize', (_e, sessionId: string, cols: number, rows: number) => {
    if (wsl.has(sessionId)) wsl.resize(sessionId, cols, rows)
    else ssh.resize(sessionId, cols, rows)
  })
  // Agent commands run on their own channel so they never share the user's
  // interactive shell (see SshManager.execCommand).
  ipcMain.handle(
    'ssh:exec',
    async (
      _e,
      sessionId: string,
      execId: string,
      command: string,
      opts?: SshExecOptions
    ): Promise<SshExecResult> => {
      logDebug({
        category: 'ipc',
        message: 'ssh:exec',
        sessionId_ssh: sessionId,
        traceId: execId,
        data: { command: truncateForDebug(command), cwd: opts?.cwd }
      })
      return ssh.execCommand(sessionId, execId, command, opts)
    }
  )
  ipcMain.on('ssh:execAbort', (_e, execId: string) => {
    logDebug({ category: 'ipc', message: 'ssh:execAbort', traceId: execId })
    ssh.abortExec(execId)
  })
  ipcMain.on('ssh:close', (_e, sessionId: string) => {
    logDebug({ category: 'ipc', message: 'ssh:close', sessionId_ssh: sessionId })
    if (wsl.has(sessionId)) wsl.close(sessionId)
    else ssh.close(sessionId)
  })

  // --- Chart samplers ---
  // Live charts collect metrics on a private channel so the user's visible
  // shell is never written to (see SshManager.startSampler).
  ipcMain.handle(
    'sampler:start',
    (_e, sessionId: string, samplerId: string, command: string): Promise<SamplerStartResult> => {
      logDebug({
        category: 'ipc',
        message: 'sampler:start',
        sessionId_ssh: sessionId,
        traceId: samplerId,
        data: { command: truncateForDebug(command) }
      })
      return wsl.has(sessionId)
        ? wsl.startSampler(sessionId, samplerId, command)
        : ssh.startSampler(sessionId, samplerId, command)
    }
  )
  ipcMain.on('sampler:stop', (_e, samplerId: string) => {
    logDebug({ category: 'ipc', message: 'sampler:stop', traceId: samplerId })
    // The id is unique across both managers, so stopping an unknown id is a
    // no-op on the other one.
    ssh.stopSampler(samplerId)
    wsl.stopSampler(samplerId)
  })

  // --- WSL (local pseudo-terminal) ---
  ipcMain.handle('wsl:list', () => wsl.listDistros())
  ipcMain.handle('wsl:connect', (_e, opts: WslConnectOptions) => {
    logDebug({ category: 'ipc', message: 'wsl:connect', data: { distro: opts.distro } })
    return wsl.connect(opts)
  })

  // --- AI (streaming) ---
  ipcMain.on('ai:chat', (e, req: AIChatRequest) => {
    logDebug({
      category: 'ipc',
      message: 'ai:chat',
      traceId: req.requestId,
      data: {
        messageCount: req.messages.length,
        enableTools: req.enableTools,
        hasContext: !!req.context
      }
    })
    void ai.chat(req, {
      onChunk: (delta) =>
        e.sender.send('ai:chunk', { requestId: req.requestId, delta } satisfies AIChunkEvent),
      onReasoning: (delta) =>
        e.sender.send('ai:reasoning', {
          requestId: req.requestId,
          delta
        } satisfies AIReasoningEvent),
      onDone: (content, toolCalls, usage) =>
        e.sender.send('ai:done', {
          requestId: req.requestId,
          content,
          toolCalls,
          usage
        } satisfies AIDoneEvent),
      onError: (error) =>
        e.sender.send('ai:error', { requestId: req.requestId, error } satisfies AIErrorEvent)
    })
  })
  ipcMain.on('ai:cancel', (_e, requestId: string) => {
    logDebug({ category: 'ipc', message: 'ai:cancel', traceId: requestId })
    ai.cancel(requestId)
  })

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
      logDebug({
        category: 'ipc',
        message: 'ai:translate',
        data: { promptLength: req.prompt.length, hasContext: !!req.context }
      })
      try {
        return { content: await ai.translate(req) }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )

  // Stream command execution summary for the in-terminal NL mode.
  ipcMain.on('ai:summarize', (e, req: AISummarizeRequest) => {
    logDebug({
      category: 'ipc',
      message: 'ai:summarize',
      traceId: req.requestId,
      data: { runCount: req.runs.length, hasContext: !!req.context }
    })
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
  ipcMain.handle('local:openPath', async (_e, path: string): Promise<OpenPathResult> => {
    try {
      const resolved = resolveLocal(path)
      const failure = await shell.openPath(resolved)
      if (failure) return { error: failure }
      return { path: resolved }
    } catch (err) {
      return { error: errMessage(err) }
    }
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
  ipcMain.handle(
    'sftp:stat',
    async (_e, sessionId: string, path: string): Promise<SftpStatResult> => {
      try {
        return { stat: await ssh.sftpStat(sessionId, path) }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )
  ipcMain.handle(
    'sftp:readText',
    async (
      _e,
      sessionId: string,
      path: string,
      opts?: { startByte?: number; maxBytes?: number }
    ): Promise<SftpReadTextResult> => {
      try {
        return { read: await ssh.sftpReadText(sessionId, path, opts) }
      } catch (err) {
        return { error: errMessage(err) }
      }
    }
  )
  ipcMain.handle(
    'sftp:writeText',
    async (_e, sessionId: string, path: string, content: string): Promise<SftpOpResult> => {
      try {
        await ssh.sftpWriteText(sessionId, path, content)
        return { ok: true }
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
    'sftp:openFile',
    async (
      e,
      sessionId: string,
      remotePath: string,
      transferId?: string
    ): Promise<OpenPathResult> => {
      const fileName = basename(remotePath)
      const onStep = transferId
        ? (bytesDone: number, bytesTotal: number): void => {
            e.sender.send('sftp:transferProgress', {
              fileName,
              fileIndex: 1,
              fileTotal: 1,
              bytesDone,
              bytesTotal,
              transferId,
              direction: 'download'
            } satisfies SftpTransferProgressEvent)
          }
        : undefined
      try {
        const target = remoteTempPath(
          join(app.getPath('temp'), SFTP_OPEN_TEMP_DIR),
          sessionId,
          remotePath
        )
        await mkdir(dirname(target), { recursive: true })
        await ssh.sftpDownload(sessionId, remotePath, target, onStep)
        const failure = await shell.openPath(target)
        if (failure) return { path: target, error: failure }
        return { path: target }
      } catch (err) {
        return { error: errMessage(err) }
      } finally {
        if (transferId) {
          e.sender.send('sftp:transferDone', {
            transferId,
            direction: 'download'
          } satisfies SftpTransferDoneEvent)
        }
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
    (): AppInfo => {
      const userDataPath = app.getPath('userData')
      return {
        name: 'AI Terminal',
        version: app.getVersion(),
        description:
          'AI-Augmented multi-tab SSH terminal with an integrated AI Copilot side panel.',
        author: 'zackdlut',
        email: 'zack.dlut@gmail.com',
        license: 'MIT',
        electron: process.versions.electron ?? '',
        userDataPath,
        debugLogDir: join(userDataPath, 'logs')
      }
    }
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
  ipcMain.handle('config:getKeybindings', () => config.getKeybindings())
  ipcMain.handle('config:setKeybindings', (_e, settings: KeybindingsSettings) =>
    config.setKeybindings(settings)
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
  ipcMain.handle(
    'config:importSessions',
    async (_e, format: BookmarkTransferFormat, filePath?: string): Promise<ImportSessionsResult> => {
      let path = filePath
      if (!path) {
        const win = getWindow()
        const dialogOpts = {
          properties: ['openFile' as const],
          filters: [transferFilter(format), { name: 'All Files', extensions: ['*'] }]
        }
        const result = win
          ? await dialog.showOpenDialog(win, dialogOpts)
          : await dialog.showOpenDialog(dialogOpts)
        if (result.canceled || result.filePaths.length === 0) return { cancelled: true }
        path = result.filePaths[0]
      }
      try {
        const text = await readFile(path, 'utf8')
        return { ...importBookmarks(format, text), path }
      } catch (err) {
        return { error: errMessage(err), path }
      }
    }
  )
  ipcMain.handle(
    'config:exportSessions',
    async (_e, format: BookmarkTransferFormat, filePath?: string): Promise<ExportSessionsResult> => {
      let path = filePath
      if (!path) {
        const win = getWindow()
        const dialogOpts = {
          defaultPath: format === 'json' ? 'connections.json' : 'Sessions.XML',
          filters: [transferFilter(format), { name: 'All Files', extensions: ['*'] }]
        }
        const result = win
          ? await dialog.showSaveDialog(win, dialogOpts)
          : await dialog.showSaveDialog(dialogOpts)
        if (result.canceled || !result.filePath) return { cancelled: true }
        path = result.filePath
      }
      try {
        const { text, exported } = exportBookmarks(format)
        await writeFile(path, text, 'utf8')
        return { exported, path }
      } catch (err) {
        return { error: errMessage(err), path }
      }
    }
  )
  ipcMain.handle('config:getCopilotChats', () => config.getCopilotChats())
  ipcMain.handle('config:setCopilotChats', (_e, state: CopilotChatState | null) =>
    config.setCopilotChats(state)
  )
  ipcMain.handle('config:getUserRules', () => config.getUserRules())
  ipcMain.handle('config:setUserRules', (_e, rules: string) => config.setUserRules(rules))

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

  return {
    ssh,
    wsl,
    disposeAll: () => {
      ssh.disposeAll()
      wsl.disposeAll()
    }
  }
}
