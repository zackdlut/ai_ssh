import { create } from 'zustand'

export const CONN_SIDEBAR_MIN_WIDTH = 200
export const CONN_SIDEBAR_MAX_WIDTH = 520
const CONN_SIDEBAR_DEFAULT_WIDTH = 256
const PANEL_WIDTH_KEY = 'conn.sidebarWidth'

export const clampConnSidebarWidth = (w: number): number =>
  Math.min(CONN_SIDEBAR_MAX_WIDTH, Math.max(CONN_SIDEBAR_MIN_WIDTH, Math.round(w)))

function loadPanelWidth(): number {
  const raw = Number(localStorage.getItem(PANEL_WIDTH_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampConnSidebarWidth(raw) : CONN_SIDEBAR_DEFAULT_WIDTH
}

interface ConnSidebarState {
  panelWidth: number
  setPanelWidth: (width: number) => void
}

export const useConnSidebarStore = create<ConnSidebarState>((set) => ({
  panelWidth: loadPanelWidth(),
  setPanelWidth: (width) => {
    const clamped = clampConnSidebarWidth(width)
    localStorage.setItem(PANEL_WIDTH_KEY, String(clamped))
    set({ panelWidth: clamped })
  }
}))
