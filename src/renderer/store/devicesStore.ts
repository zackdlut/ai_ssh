import { create } from 'zustand'
import type { DeviceProbeResult, SerialPortInfo, ToolchainInfo } from '../../shared/types'
import { useBookmarksStore } from './bookmarksStore'

/**
 * Discovery state: which serial ports exist right now, which saved SSH devices
 * answer, and which embedded toolchains this machine has.
 *
 * Kept in a store rather than in the sidebar's local state because the same
 * answers are needed in three places that do not share a component tree — the
 * device list, the serial connect dialog, and the AI's `list_devices` tool.
 *
 * The polling is reference-counted. Serial enumeration wakes the USB bus and a
 * TCP probe touches every saved device, so neither should run because a panel
 * was opened once and never closed; `acquire`/`release` mean the work happens
 * only while something is actually displaying it.
 */

/** How often to re-probe saved SSH devices while the list is visible. */
const PROBE_INTERVAL_MS = 30_000

interface DevicesState {
  /** Live serial ports, already ordered with recognized boards first. */
  ports: SerialPortInfo[]
  /** Reachability by saved connection id. */
  probes: Record<string, DeviceProbeResult>
  toolchains: ToolchainInfo[]
  portsError?: string
  probing: boolean
  /** True until the first enumeration completes, to tell "none" from "not yet". */
  loadingPorts: boolean

  /** Start watching if this is the first holder. Returns a release function. */
  acquire: () => () => void
  refreshPorts: () => Promise<void>
  refreshProbes: () => Promise<void>
  refreshToolchains: () => Promise<void>
}

let holders = 0
let unsubscribePorts: (() => void) | null = null
let probeTimer: ReturnType<typeof setInterval> | null = null

export const useDevicesStore = create<DevicesState>((set, get) => ({
  ports: [],
  probes: {},
  toolchains: [],
  probing: false,
  loadingPorts: true,

  acquire: () => {
    holders++
    if (holders === 1) {
      unsubscribePorts = window.api.serial.onPorts((e) => {
        set({ ports: e.ports, portsError: undefined, loadingPorts: false })
      })
      window.api.serial.startWatch()
      void get().refreshPorts()
      void get().refreshProbes()
      void get().refreshToolchains()
      probeTimer = setInterval(() => void get().refreshProbes(), PROBE_INTERVAL_MS)
    }

    let released = false
    return () => {
      // Guard against a double release: React can invoke an effect's cleanup
      // more than once, and an over-release would stop polling for the panels
      // still open.
      if (released) return
      released = true
      holders = Math.max(0, holders - 1)
      if (holders > 0) return
      window.api.serial.stopWatch()
      unsubscribePorts?.()
      unsubscribePorts = null
      if (probeTimer) clearInterval(probeTimer)
      probeTimer = null
    }
  },

  refreshPorts: async () => {
    const res = await window.api.serial.list()
    if (res.error) {
      set({ portsError: res.error, loadingPorts: false })
      return
    }
    set({ ports: res.ports ?? [], portsError: undefined, loadingPorts: false })
  },

  /**
   * Probe every saved SSH device.
   *
   * Only SSH entries: "reachable" is not a question that applies to the local
   * transports. A serial port either enumerates or it does not, which the port
   * list already says, and a local shell is on the machine doing the asking.
   * The fan-out cap lives in the main process.
   */
  refreshProbes: async () => {
    if (get().probing) return
    const targets = useBookmarksStore
      .getState()
      .connections.filter((c) => (c.kind ?? 'ssh') === 'ssh' && c.host)
      .map((c) => ({ id: c.id, host: c.host, port: c.port || 22 }))
    if (targets.length === 0) {
      set({ probes: {} })
      return
    }
    set({ probing: true })
    try {
      set({ probes: await window.api.device.probeMany(targets) })
    } finally {
      set({ probing: false })
    }
  },

  refreshToolchains: async () => {
    const res = await window.api.device.toolchains()
    if (res.tools) set({ toolchains: res.tools })
  }
}))
