import { contextBridge, ipcRenderer } from 'electron'
import type {
  AIChatRequest,
  AIChunkEvent,
  AIDoneEvent,
  AIErrorEvent,
  AISettings,
  BookmarkFolder,
  ConnectionConfig,
  ConnectOptions,
  ConnectResult,
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
  ai: {
    chat: (req: AIChatRequest): void => ipcRenderer.send('ai:chat', req),
    cancel: (requestId: string): void => ipcRenderer.send('ai:cancel', requestId),
    onChunk: (cb: (e: AIChunkEvent) => void): Unsubscribe => on('ai:chunk', cb),
    onDone: (cb: (e: AIDoneEvent) => void): Unsubscribe => on('ai:done', cb),
    onError: (cb: (e: AIErrorEvent) => void): Unsubscribe => on('ai:error', cb)
  },
  config: {
    getAISettings: (): Promise<AISettings> => ipcRenderer.invoke('config:getAI'),
    setAISettings: (s: AISettings): Promise<AISettings> => ipcRenderer.invoke('config:setAI', s),
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
      ipcRenderer.invoke('config:deleteFolder', id)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
