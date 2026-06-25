import { create } from 'zustand'
import { clampPanelWidth } from './aiStore'

const PANEL_DEFAULT_WIDTH = 460
const PANEL_WIDTH_KEY = 'sftp.panelWidth'

function loadPanelWidth(): number {
  const raw = Number(localStorage.getItem(PANEL_WIDTH_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampPanelWidth(raw) : PANEL_DEFAULT_WIDTH
}

interface SftpState {
  panelOpen: boolean
  panelWidth: number
  togglePanel: () => void
  setPanelOpen: (open: boolean) => void
  setPanelWidth: (width: number) => void
}

export const useSftpStore = create<SftpState>((set) => ({
  panelOpen: false,
  panelWidth: loadPanelWidth(),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPanelOpen: (open) => set({ panelOpen: open }),
  setPanelWidth: (width) => {
    const clamped = clampPanelWidth(width)
    localStorage.setItem(PANEL_WIDTH_KEY, String(clamped))
    set({ panelWidth: clamped })
  }
}))
