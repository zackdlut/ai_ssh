import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { readBootWindowBackground } from './config/bootTheme'
import { openExternalUrl } from './openExternal'
import type { IpcManagers } from './ipc'

// A terminal app needs no GPU acceleration; disabling it avoids GPU process
// crashes in headless / VM / WSL environments.
app.disableHardwareAcceleration()

let mainWindow: BrowserWindow | null = null
let ipcManagers: IpcManagers | null = null

// Resolves to <root>/build/icon.* in dev and inside the asar when packaged,
// because out/main sits at the same depth in both layouts. Windows prefers ICO
// for the window / taskbar; Linux uses PNG. macOS uses the bundle icon instead.
const iconPath = join(
  __dirname,
  process.platform === 'win32' ? '../../build/icon.ico' : '../../build/icon.png'
)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'AI Terminal',
    icon: iconPath,
    // The renderer paints over this, but it is what the user sees while the
    // first frame is still pending — so it has to follow the saved theme.
    backgroundColor: readBootWindowBackground(),
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
    void openExternalUrl(details.url)
    return { action: 'deny' }
  })

  // Keep the renderer from navigating away if a link is clicked without
  // target=_blank. Skip the first load (current URL is still about:blank) and
  // same-origin / same-file reloads so Vite HMR and production file loads work.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (!current || current === 'about:blank') return
    try {
      const from = new URL(current)
      const to = new URL(url)
      // file: origins are the string "null", so same-origin is not a safe check.
      if (from.protocol === 'file:' || to.protocol === 'file:') {
        if (from.protocol === 'file:' && to.protocol === 'file:' && from.pathname === to.pathname) {
          return
        }
      } else if (from.origin === to.origin) {
        return
      }
    } catch {
      // Fall through and block the navigation.
    }
    event.preventDefault()
    void openExternalUrl(url)
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
    ipcManagers = registerIpc(() => mainWindow)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => ipcManagers?.disposeAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
