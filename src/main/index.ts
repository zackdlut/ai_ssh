import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import type { SshManager } from './ssh/manager'

// A terminal app needs no GPU acceleration; disabling it avoids GPU process
// crashes in headless / VM / WSL environments.
app.disableHardwareAcceleration()

let mainWindow: BrowserWindow | null = null
let sshManager: SshManager | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'AI Terminal',
    backgroundColor: '#0c0f18',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite injects ELECTRON_RENDERER_URL in dev.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Show the window first; defer IPC registration so cold starts do not block
  // on loading ssh2 / openai from disk before the renderer can begin loading.
  createWindow()

  void import('./ipc').then(({ registerIpc }) => {
    sshManager = registerIpc(() => mainWindow)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => sshManager?.disposeAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
