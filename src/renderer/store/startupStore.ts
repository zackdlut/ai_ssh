import { create } from 'zustand'

const CONN_SIDEBAR_KEY = 'startup.connSidebarOpen'
const COPILOT_KEY = 'startup.copilotOpen'

const CONN_SIDEBAR_DEFAULT = false
const COPILOT_DEFAULT = true

function loadBool(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key)
  return raw === null ? fallback : raw === 'true'
}

/** Whether the connection sidebar should be open on app startup. */
export function getConnSidebarStartupOpen(): boolean {
  return loadBool(CONN_SIDEBAR_KEY, CONN_SIDEBAR_DEFAULT)
}

/** Whether the Copilot chat panel should be open on app startup. */
export function getCopilotStartupOpen(): boolean {
  return loadBool(COPILOT_KEY, COPILOT_DEFAULT)
}

interface StartupState {
  connSidebarOpen: boolean
  copilotOpen: boolean
  setConnSidebarOpen: (open: boolean) => void
  setCopilotOpen: (open: boolean) => void
}

export const useStartupStore = create<StartupState>((set) => ({
  connSidebarOpen: getConnSidebarStartupOpen(),
  copilotOpen: getCopilotStartupOpen(),
  setConnSidebarOpen: (open) => {
    localStorage.setItem(CONN_SIDEBAR_KEY, String(open))
    set({ connSidebarOpen: open })
  },
  setCopilotOpen: (open) => {
    localStorage.setItem(COPILOT_KEY, String(open))
    set({ copilotOpen: open })
  }
}))
