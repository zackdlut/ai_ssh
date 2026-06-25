import { ipcMain, type BrowserWindow } from 'electron'
import { SshManager } from './ssh/manager'
import { AIProvider } from './ai/provider'
import * as config from './config/store'
import type {
  AIChatRequest,
  AIChunkEvent,
  AIDoneEvent,
  AIErrorEvent,
  AISettings,
  ConnectionConfig,
  ConnectOptions
} from '../shared/types'

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

  // --- Config ---
  ipcMain.handle('config:getAI', () => config.getAISettings())
  ipcMain.handle('config:setAI', (_e, settings: AISettings) => config.setAISettings(settings))
  ipcMain.handle('config:getConnections', () => config.getConnections())
  ipcMain.handle('config:saveConnection', (_e, conn: ConnectionConfig) =>
    config.saveConnection(conn)
  )
  ipcMain.handle('config:deleteConnection', (_e, id: string) => config.deleteConnection(id))

  return ssh
}
