import { contextBridge, ipcRenderer } from 'electron'
import type {
  AIChatRequest,
  AIChartSpecRequest,
  AIChartSpecResult,
  AIChunkEvent,
  AIReasoningEvent,
  AIDoneEvent,
  AIErrorEvent,
  AISettings,
  AppInfo,
  AppLocale,
  AppTheme,
  AITranslateRequest,
  AITranslateResult,
  AISummarizeRequest,
  BookmarkFolder,
  ConnectionConfig,
  ConnectOptions,
  CopilotChatState,
  ConnectResult,
  TerminalAppearanceSettings,
  SftpListResult,
  SftpOpResult,
  SftpRealpathResult,
  SftpTransferResult,
  SaveFileResult,
  SshDataEvent,
  SshStatusEvent
} from '../shared/types'

type Unsubscribe = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  app: {
    getInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:getInfo')
  },
  ssh: {
    connect: (opts: ConnectOptions): Promise<ConnectResult> =>
      ipcRenderer.invoke('ssh:connect', opts),
    write: (sessionId: string, data: string): void =>
      ipcRenderer.send('ssh:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number): void =>
      ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    close: (sessionId: string): void => ipcRenderer.send('ssh:close', sessionId),
    onData: (cb: (e: SshDataEvent) => void): Unsubscribe => on('ssh:data', cb),
    onStatus: (cb: (e: SshStatusEvent) => void): Unsubscribe => on('ssh:status', cb)
  },
  sftp: {
    list: (sessionId: string, path: string): Promise<SftpListResult> =>
      ipcRenderer.invoke('sftp:list', sessionId, path),
    realpath: (sessionId: string, path: string): Promise<SftpRealpathResult> =>
      ipcRenderer.invoke('sftp:realpath', sessionId, path),
    mkdir: (sessionId: string, path: string): Promise<SftpOpResult> =>
      ipcRenderer.invoke('sftp:mkdir', sessionId, path),
    rename: (sessionId: string, from: string, to: string): Promise<SftpOpResult> =>
      ipcRenderer.invoke('sftp:rename', sessionId, from, to),
    delete: (sessionId: string, path: string, isDir: boolean): Promise<SftpOpResult> =>
      ipcRenderer.invoke('sftp:delete', sessionId, path, isDir),
    download: (sessionId: string, remotePath: string): Promise<SftpTransferResult> =>
      ipcRenderer.invoke('sftp:download', sessionId, remotePath),
    upload: (sessionId: string, remoteDir: string): Promise<SftpTransferResult> =>
      ipcRenderer.invoke('sftp:upload', sessionId, remoteDir)
  },
  terminal: {
    saveLog: (content: string, defaultPath: string): Promise<SaveFileResult> =>
      ipcRenderer.invoke('terminal:saveLog', content, defaultPath)
  },
  ai: {
    chat: (req: AIChatRequest): void => ipcRenderer.send('ai:chat', req),
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
    getConnections: (): Promise<ConnectionConfig[]> => ipcRenderer.invoke('config:getConnections'),
    saveConnection: (c: ConnectionConfig): Promise<ConnectionConfig[]> =>
      ipcRenderer.invoke('config:saveConnection', c),
    deleteConnection: (id: string): Promise<ConnectionConfig[]> =>
      ipcRenderer.invoke('config:deleteConnection', id),
    setConnections: (list: ConnectionConfig[]): Promise<ConnectionConfig[]> =>
      ipcRenderer.invoke('config:setConnections', list),
    getFolders: (): Promise<BookmarkFolder[]> => ipcRenderer.invoke('config:getFolders'),
    saveFolder: (f: BookmarkFolder): Promise<BookmarkFolder[]> =>
      ipcRenderer.invoke('config:saveFolder', f),
    setFolders: (list: BookmarkFolder[]): Promise<BookmarkFolder[]> =>
      ipcRenderer.invoke('config:setFolders', list),
    deleteFolder: (
      id: string
    ): Promise<{ folders: BookmarkFolder[]; connections: ConnectionConfig[] }> =>
      ipcRenderer.invoke('config:deleteFolder', id),
    getCopilotChats: (): Promise<CopilotChatState | null> =>
      ipcRenderer.invoke('config:getCopilotChats'),
    setCopilotChats: (state: CopilotChatState | null): Promise<CopilotChatState | null> =>
      ipcRenderer.invoke('config:setCopilotChats', state)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
