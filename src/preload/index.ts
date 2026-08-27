import { contextBridge, ipcRenderer } from 'electron'
import type {
  AIAgentTurnRequest,
  AIAgentTurnResult,
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
  AppInfo,
  AppLocale,
  AppTheme,
  AITranslateRequest,
  AITranslateResult,
  AISummarizeRequest,
  BookmarkFolder,
  SavedLayout,
  BookmarkTransferFormat,
  ConnectionConfig,
  ConnectOptions,
  CopilotChatState,
  ConnectResult,
  ExportSessionsResult,
  ImportSessionsResult,
  InstalledSkill,
  SkillInstallResult,
  SkillReadResult,
  TerminalAppearanceSettings,
  KeybindingsSettings,
  SftpListResult,
  SftpOpResult,
  SftpRealpathResult,
  SftpReadTextResult,
  SftpStatResult,
  SftpTransferResult,
  SftpBatchTransferResult,
  SftpTransferProgressEvent,
  SftpTransferDoneEvent,
  LocalListResult,
  LocalHomeResult,
  OpenExternalResult,
  OpenPathResult,
  PickDirectoryResult,
  SaveFileResult,
  SamplerDataEvent,
  SamplerEndEvent,
  SamplerStartResult,
  SshDataEvent,
  SshExecOptions,
  SshExecResult,
  SshStatusEvent,
  WslConnectOptions,
  WslDistro
} from '../shared/types'
import type { DebugLogPayload, DebugLogSettings } from '../shared/debugLog'

type Unsubscribe = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  app: {
    getInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:getInfo'),
    openExternal: (url: string): Promise<OpenExternalResult> =>
      ipcRenderer.invoke('app:openExternal', url)
  },
  ssh: {
    connect: (opts: ConnectOptions): Promise<ConnectResult> =>
      ipcRenderer.invoke('ssh:connect', opts),
    write: (sessionId: string, data: string): void =>
      ipcRenderer.send('ssh:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number): void =>
      ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    close: (sessionId: string): void => ipcRenderer.send('ssh:close', sessionId),
    exec: (
      sessionId: string,
      execId: string,
      command: string,
      opts?: SshExecOptions
    ): Promise<SshExecResult> =>
      ipcRenderer.invoke('ssh:exec', sessionId, execId, command, opts),
    abortExec: (execId: string): void => ipcRenderer.send('ssh:execAbort', execId),
    onData: (cb: (e: SshDataEvent) => void): Unsubscribe => on('ssh:data', cb),
    onStatus: (cb: (e: SshStatusEvent) => void): Unsubscribe => on('ssh:status', cb)
  },
  sampler: {
    start: (sessionId: string, samplerId: string, command: string): Promise<SamplerStartResult> =>
      ipcRenderer.invoke('sampler:start', sessionId, samplerId, command),
    stop: (samplerId: string): void => ipcRenderer.send('sampler:stop', samplerId),
    onData: (cb: (e: SamplerDataEvent) => void): Unsubscribe => on('sampler:data', cb),
    onEnd: (cb: (e: SamplerEndEvent) => void): Unsubscribe => on('sampler:end', cb)
  },
  wsl: {
    list: (): Promise<WslDistro[]> => ipcRenderer.invoke('wsl:list'),
    connect: (opts: WslConnectOptions): Promise<ConnectResult> =>
      ipcRenderer.invoke('wsl:connect', opts)
  },
  local: {
    home: (): Promise<LocalHomeResult> => ipcRenderer.invoke('local:home'),
    list: (path: string): Promise<LocalListResult> => ipcRenderer.invoke('local:list', path),
    pickDirectory: (defaultPath?: string): Promise<PickDirectoryResult> =>
      ipcRenderer.invoke('local:pickDirectory', defaultPath),
    rename: (from: string, to: string): Promise<SftpOpResult> =>
      ipcRenderer.invoke('local:rename', from, to),
    delete: (path: string, isDir: boolean): Promise<SftpOpResult> =>
      ipcRenderer.invoke('local:delete', path, isDir),
    openPath: (path: string): Promise<OpenPathResult> =>
      ipcRenderer.invoke('local:openPath', path)
  },
  sftp: {
    list: (sessionId: string, path: string): Promise<SftpListResult> =>
      ipcRenderer.invoke('sftp:list', sessionId, path),
    realpath: (sessionId: string, path: string): Promise<SftpRealpathResult> =>
      ipcRenderer.invoke('sftp:realpath', sessionId, path),
    stat: (sessionId: string, path: string): Promise<SftpStatResult> =>
      ipcRenderer.invoke('sftp:stat', sessionId, path),
    readText: (
      sessionId: string,
      path: string,
      opts?: { startByte?: number; maxBytes?: number }
    ): Promise<SftpReadTextResult> => ipcRenderer.invoke('sftp:readText', sessionId, path, opts),
    writeText: (sessionId: string, path: string, content: string): Promise<SftpOpResult> =>
      ipcRenderer.invoke('sftp:writeText', sessionId, path, content),
    mkdir: (sessionId: string, path: string): Promise<SftpOpResult> =>
      ipcRenderer.invoke('sftp:mkdir', sessionId, path),
    rename: (sessionId: string, from: string, to: string): Promise<SftpOpResult> =>
      ipcRenderer.invoke('sftp:rename', sessionId, from, to),
    delete: (sessionId: string, path: string, isDir: boolean): Promise<SftpOpResult> =>
      ipcRenderer.invoke('sftp:delete', sessionId, path, isDir),
    download: (sessionId: string, remotePath: string): Promise<SftpTransferResult> =>
      ipcRenderer.invoke('sftp:download', sessionId, remotePath),
    /** Copy a remote file to temp and hand it to the OS default application. */
    openFile: (
      sessionId: string,
      remotePath: string,
      transferId?: string
    ): Promise<OpenPathResult> =>
      ipcRenderer.invoke('sftp:openFile', sessionId, remotePath, transferId),
    upload: (sessionId: string, remoteDir: string): Promise<SftpTransferResult> =>
      ipcRenderer.invoke('sftp:upload', sessionId, remoteDir),
    uploadPaths: (
      sessionId: string,
      localPaths: string[],
      remoteDir: string,
      transferId?: string
    ): Promise<SftpBatchTransferResult> =>
      ipcRenderer.invoke('sftp:uploadPaths', sessionId, localPaths, remoteDir, transferId),
    downloadPaths: (
      sessionId: string,
      remotePaths: string[],
      localDir: string,
      transferId?: string
    ): Promise<SftpBatchTransferResult> =>
      ipcRenderer.invoke('sftp:downloadPaths', sessionId, remotePaths, localDir, transferId),
    onTransferProgress: (cb: (e: SftpTransferProgressEvent) => void): Unsubscribe =>
      on('sftp:transferProgress', cb),
    onTransferDone: (cb: (e: SftpTransferDoneEvent) => void): Unsubscribe =>
      on('sftp:transferDone', cb)
  },
  terminal: {
    saveLog: (content: string, defaultPath: string): Promise<SaveFileResult> =>
      ipcRenderer.invoke('terminal:saveLog', content, defaultPath)
  },
  ai: {
    chat: (req: AIChatRequest): void => ipcRenderer.send('ai:chat', req),
    agentTurn: (req: AIAgentTurnRequest): Promise<AIAgentTurnResult> =>
      ipcRenderer.invoke('ai:agentTurn', req),
    compressHistory: (req: AICompressHistoryRequest): Promise<AICompressHistoryResult> =>
      ipcRenderer.invoke('ai:compressHistory', req),
    chartSpec: (req: AIChartSpecRequest): Promise<AIChartSpecResult> =>
      ipcRenderer.invoke('ai:chartSpec', req),
    translate: (req: AITranslateRequest): Promise<AITranslateResult> =>
      ipcRenderer.invoke('ai:translate', req),
    summarize: (req: AISummarizeRequest): void => ipcRenderer.send('ai:summarize', req),
    cancel: (requestId: string): void => ipcRenderer.send('ai:cancel', requestId),
    onChunk: (cb: (e: AIChunkEvent) => void): Unsubscribe => on('ai:chunk', cb),
    onReasoning: (cb: (e: AIReasoningEvent) => void): Unsubscribe => on('ai:reasoning', cb),
    onDone: (cb: (e: AIDoneEvent) => void): Unsubscribe => on('ai:done', cb),
    onError: (cb: (e: AIErrorEvent) => void): Unsubscribe => on('ai:error', cb)
  },
  config: {
    getAISettings: (): Promise<AISettings> => ipcRenderer.invoke('config:getAI'),
    setAISettings: (s: AISettings): Promise<AISettings> => ipcRenderer.invoke('config:setAI', s),
    getTheme: (): Promise<AppTheme> => ipcRenderer.invoke('config:getTheme'),
    setTheme: (theme: AppTheme): Promise<AppTheme> => ipcRenderer.invoke('config:setTheme', theme),
    getLocale: (): Promise<AppLocale> => ipcRenderer.invoke('config:getLocale'),
    setLocale: (locale: AppLocale): Promise<AppLocale> =>
      ipcRenderer.invoke('config:setLocale', locale),
    getTerminalAppearance: (): Promise<TerminalAppearanceSettings> =>
      ipcRenderer.invoke('config:getTerminalAppearance'),
    setTerminalAppearance: (s: TerminalAppearanceSettings): Promise<TerminalAppearanceSettings> =>
      ipcRenderer.invoke('config:setTerminalAppearance', s),
    getKeybindings: (): Promise<KeybindingsSettings> =>
      ipcRenderer.invoke('config:getKeybindings'),
    setKeybindings: (s: KeybindingsSettings): Promise<KeybindingsSettings> =>
      ipcRenderer.invoke('config:setKeybindings', s),
    getConnections: (): Promise<ConnectionConfig[]> => ipcRenderer.invoke('config:getConnections'),
    saveConnection: (c: ConnectionConfig): Promise<ConnectionConfig[]> =>
      ipcRenderer.invoke('config:saveConnection', c),
    deleteConnection: (id: string): Promise<ConnectionConfig[]> =>
      ipcRenderer.invoke('config:deleteConnection', id),
    setConnections: (list: ConnectionConfig[]): Promise<ConnectionConfig[]> =>
      ipcRenderer.invoke('config:setConnections', list),
    getLayouts: (): Promise<SavedLayout[]> => ipcRenderer.invoke('config:getLayouts'),
    setLayouts: (list: SavedLayout[]): Promise<SavedLayout[]> =>
      ipcRenderer.invoke('config:setLayouts', list),
    getFolders: (): Promise<BookmarkFolder[]> => ipcRenderer.invoke('config:getFolders'),
    saveFolder: (f: BookmarkFolder): Promise<BookmarkFolder[]> =>
      ipcRenderer.invoke('config:saveFolder', f),
    setFolders: (list: BookmarkFolder[]): Promise<BookmarkFolder[]> =>
      ipcRenderer.invoke('config:setFolders', list),
    deleteFolder: (
      id: string
    ): Promise<{ folders: BookmarkFolder[]; connections: ConnectionConfig[] }> =>
      ipcRenderer.invoke('config:deleteFolder', id),
    /** Read saved connections from a SuperPuTTY XML or a native JSON export. */
    importSessions: (
      format: BookmarkTransferFormat,
      filePath?: string
    ): Promise<ImportSessionsResult> =>
      ipcRenderer.invoke('config:importSessions', format, filePath),
    /** Write saved connections out in the given format. */
    exportSessions: (
      format: BookmarkTransferFormat,
      filePath?: string
    ): Promise<ExportSessionsResult> =>
      ipcRenderer.invoke('config:exportSessions', format, filePath),
    getCopilotChats: (): Promise<CopilotChatState | null> =>
      ipcRenderer.invoke('config:getCopilotChats'),
    setCopilotChats: (state: CopilotChatState | null): Promise<CopilotChatState | null> =>
      ipcRenderer.invoke('config:setCopilotChats', state),
    getUserRules: (): Promise<string> => ipcRenderer.invoke('config:getUserRules'),
    setUserRules: (rules: string): Promise<string> => ipcRenderer.invoke('config:setUserRules', rules)
  },
  skills: {
    list: (): Promise<InstalledSkill[]> => ipcRenderer.invoke('skills:list'),
    install: (): Promise<SkillInstallResult> => ipcRenderer.invoke('skills:install'),
    remove: (id: string): Promise<InstalledSkill[]> => ipcRenderer.invoke('skills:remove', id),
    setEnabled: (id: string, enabled: boolean): Promise<InstalledSkill[]> =>
      ipcRenderer.invoke('skills:setEnabled', id, enabled),
    read: (idOrName: string): Promise<SkillReadResult> =>
      ipcRenderer.invoke('skills:read', idOrName)
  },
  debug: {
    log: (entry: DebugLogPayload): void => ipcRenderer.send('debug:log', entry),
    getSettings: (): Promise<DebugLogSettings> => ipcRenderer.invoke('debug:getSettings'),
    setEnabled: (enabled: boolean): Promise<DebugLogSettings> =>
      ipcRenderer.invoke('debug:setEnabled', enabled)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
