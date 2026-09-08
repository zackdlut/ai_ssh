/**
 * Embedded-device tools for the agent loop.
 *
 * These exist because a serial device is the one target on this surface with no
 * shell. `exec_command` needs something that runs a command and reports an exit
 * status; a UART offers neither, so the loop's whole "run, check status, decide"
 * cycle is unavailable and has to be replaced by "write, read, judge the text".
 *
 * Every result here therefore says so explicitly. A model that assumes a silent
 * reply means success will confidently report a working board that is in fact
 * mute, so the absence of an exit code is stated in the result rather than left
 * to be inferred.
 */
import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import { useDevicesStore } from './../store/devicesStore'
import { isTerminalReadOnly } from '../store/paneSyncStore'
import { stripAnsi } from './streamParse'
import { debugLog } from './debugLog'
import {
  deviceKindLabel,
  identifySerialDevice,
  type SerialPortInfo
} from '../../shared/deviceIdentity'
import type { ToolResult } from './aiTools'

/** Default and maximum capture windows, in milliseconds. */
const SEND_CAPTURE_MS = 2000
const RESET_CAPTURE_MS = 3000
const MAX_CAPTURE_MS = 15_000

/** Cap on captured text handed back, so one chatty board cannot flood a turn. */
const MAX_CAPTURE_CHARS = 8000

/**
 * The sentence every serial result carries.
 *
 * Repeated on both tools on purpose: this is the fact most likely to be
 * forgotten mid-task, and the failure it prevents is a confident wrong answer
 * rather than an error.
 */
const NO_EXIT_CODE_NOTE =
  'NOTE: serial has no exit code. Judge success only from the device output below; empty output means the device said nothing, which is not the same as success.'

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

function clampCapture(v: unknown, fallback: number): number {
  const n = num(v)
  if (n === undefined || n <= 0) return fallback
  return Math.min(n, MAX_CAPTURE_MS)
}

interface ResolvedSerial {
  tab: TerminalSession
  sessionId: string
}

/**
 * Resolve a tab_id to a live serial session.
 *
 * The wrong-kind case gets its own message because it is the mistake the model
 * actually makes: reaching for `serial_send` on the SSH tab it was already
 * working on. Naming the right tool for that tab saves a whole failed turn.
 */
function resolveSerialTab(tabId: string | undefined): ResolvedSerial | { error: string } {
  if (!tabId) return { error: 'tab_id is required.' }
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === tabId)
  if (!tab) return { error: `No open tab with id "${tabId}".` }
  if (tab.kind !== 'serial') {
    return {
      error: `Tab "${tabId}" is not a serial device, so this tool does not apply. Use exec_command on that tab instead. Call list_devices to find a serial tab.`
    }
  }
  if (tab.status !== 'connected' || !tab.sessionId) {
    return {
      error: `Serial tab "${tabId}" is not connected (status: ${tab.status}). A board that reset itself takes the port down with it; the user can reconnect from the tab.`
    }
  }
  // Both tools that resolve a tab here write to the device, which is precisely
  // what a read-only marking exists to prevent — and it matters more on serial
  // than on a shell, since the user may have marked the tab read-only to watch
  // a long run without a stray byte disturbing it.
  if (isTerminalReadOnly(tab.id)) {
    return {
      error: `Serial tab "${tabId}" is marked read-only by the user, so nothing may be written to the device. Read what it prints with search_terminal, or ask the user to clear read-only.`
    }
  }
  return { tab, sessionId: tab.sessionId }
}

/**
 * Collect everything a session prints for `ms`, then stop.
 *
 * Subscribes to the same `ssh:data` stream the terminal renders, so the capture
 * sees exactly what the user sees and the output also lands in the scrollback
 * where `search_terminal` can reach it later.
 *
 * Always waits the full window rather than stopping at the first chunk. Serial
 * output arrives in fragments at the mercy of the baud rate and the device's own
 * buffering, so a first-chunk return would routinely truncate a reply
 * mid-sentence — and a boot log is many chunks over hundreds of milliseconds.
 */
function captureFor(
  sessionId: string,
  ms: number
): { done: Promise<string>; stop: () => void } {
  let buffer = ''
  const unsubscribe = window.api.ssh.onData((e) => {
    if (e.sessionId !== sessionId) return
    buffer += e.data
  })
  let finish: (text: string) => void = () => {}
  const done = new Promise<string>((resolve) => {
    finish = resolve
  })
  const end = (): void => {
    clearTimeout(timer)
    unsubscribe()
    finish(buffer)
  }
  const timer = setTimeout(end, ms)
  // Cutting the window short matters when the action it was opened for never
  // happened: waiting out a three-second boot window after a reset that failed
  // to fire just delays the error the user needs to see.
  return { done, stop: end }
}

/** Normalize captured bytes into something a model can read. */
function presentCapture(raw: string): string {
  // ESP-IDF and a Linux console both emit color codes, which are noise to a
  // model and would eat a good share of the character budget.
  const text = stripAnsi(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (text.length <= MAX_CAPTURE_CHARS) return text
  // Keep the tail: on a serial device the newest lines are the ones that answer
  // the question, and a boot log's useful part is at the end.
  return `… (truncated, showing the last ${MAX_CAPTURE_CHARS} characters)\n${text.slice(
    -MAX_CAPTURE_CHARS
  )}`
}

export async function serialSend(args: Record<string, unknown>): Promise<ToolResult> {
  const resolved = resolveSerialTab(str(args.tab_id))
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const { tab, sessionId } = resolved

  // An empty line is legitimate: it is how you wake a prompt that is waiting
  // for Enter, so `data: ""` must not be rejected as a missing argument.
  const data = str(args.data) ?? ''
  const captureMs = clampCapture(args.capture_ms, SEND_CAPTURE_MS)

  debugLog({
    category: 'action.triggered',
    tabId: tab.id,
    message: 'serial_send',
    data: { bytes: data.length, captureMs }
  })

  const capture = captureFor(sessionId, captureMs)
  // The manager translates this CR into the session's configured terminator.
  window.api.ssh.write(sessionId, `${data}\r`)
  const raw = await capture.done

  const output = presentCapture(raw)
  const port = tab.serialOpts?.path ?? '(unknown port)'
  const header = [
    `Sent to ${port}: ${data ? JSON.stringify(data) : '(empty line)'}`,
    `Captured ${captureMs}ms of output.`,
    NO_EXIT_CODE_NOTE
  ].join('\n')

  if (!output.trim()) {
    return {
      ok: true,
      result: `${header}\n\n--- no output ---\nThe device printed nothing in this window. Common causes: the baud rate is wrong (garbage or silence), the line ending does not match what the firmware reads, the device only prints on its own schedule, or it is held in reset. Try serial_reset to capture a boot log, or a longer capture_ms.`
    }
  }
  return { ok: true, result: `${header}\n\n--- device output ---\n${output}` }
}

export async function serialReset(args: Record<string, unknown>): Promise<ToolResult> {
  const resolved = resolveSerialTab(str(args.tab_id))
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const { tab, sessionId } = resolved

  const captureMs = clampCapture(args.capture_ms, RESET_CAPTURE_MS)
  debugLog({
    category: 'action.triggered',
    tabId: tab.id,
    message: 'serial_reset',
    data: { kind: tab.deviceKind, captureMs }
  })

  // Subscribe before pulsing: the boot banner is the first thing out and it is
  // the most useful line in the whole log, so it must not be missed.
  const capture = captureFor(sessionId, captureMs)
  const res = await window.api.serial.reset(sessionId, tab.deviceKind)
  if (res.error) {
    capture.stop()
    return { ok: false, error: `Could not reset the device: ${res.error}` }
  }
  const raw = await capture.done

  const output = presentCapture(raw)
  const board = tab.deviceKind ? deviceKindLabel(tab.deviceKind) : 'generic serial device'
  const header = [
    `Reset ${tab.serialOpts?.path ?? '(unknown port)'} (${board}) and captured ${captureMs}ms.`,
    NO_EXIT_CODE_NOTE
  ].join('\n')

  if (!output.trim()) {
    return {
      ok: true,
      result: `${header}\n\n--- no boot log ---\nThe device printed nothing after the reset. On an ESP32 devkit this usually means the baud rate is wrong (the ROM bootloader logs at 74880, not 115200) or DTR/RTS are both asserted, which holds the chip in reset. On a board with no bridge chip wired to reset, the pulse may simply have no effect.`
    }
  }
  return { ok: true, result: `${header}\n\n--- boot log ---\n${output}` }
}

/**
 * Everything the app knows about attached and saved devices.
 *
 * Refreshes rather than reading whatever the sidebar last cached, because the
 * sidebar may never have been opened — the AI has to be able to answer "what is
 * plugged in" in a chat-only session, and a stale or empty snapshot would have
 * it report no devices at all.
 */
export async function listDevices(): Promise<ToolResult> {
  const devices = useDevicesStore.getState()
  await Promise.all([
    devices.refreshPorts(),
    devices.refreshProbes(),
    devices.refreshToolchains()
  ])
  const { ports, probes, toolchains, portsError } = useDevicesStore.getState()
  const connections = useBookmarksStore.getState().connections
  const sessions = useSessionsStore.getState().sessions

  const openSerialPaths = new Map(
    sessions
      .filter((s) => s.kind === 'serial' && s.status === 'connected' && s.serialOpts?.path)
      .map((s) => [s.serialOpts?.path as string, s.id])
  )

  const portLines = ports.length
    ? ports.map((p) => describeLivePort(p, openSerialPaths.get(p.path))).join('\n')
    : portsError
      ? `(enumeration failed: ${portsError})`
      : '(none plugged in)'

  const savedLines = connections.length
    ? connections
        .map((c) => {
          if (c.kind === 'serial') {
            const openTab = c.serial?.path ? openSerialPaths.get(c.serial.path) : undefined
            return `- config_id=${c.id} | ${c.name} | serial ${c.serial?.path ?? '(no port)'}${
              c.serial?.baudRate ? ` @ ${c.serial.baudRate}` : ''
            }${c.deviceKind ? ` | ${deviceKindLabel(c.deviceKind)}` : ''}${
              openTab ? ` | OPEN as tab_id=${openTab}` : ''
            }`
          }
          const probe = probes[c.id]
          const reach = probe
            ? probe.reachable
              ? ` | reachable (${probe.latencyMs ?? '?'}ms)`
              : ` | unreachable (${probe.error ?? 'no answer'})`
            : ''
          const openTab = sessions.find(
            (s) => s.status === 'connected' && s.kind !== 'serial' && s.host === c.host
          )
          return `- config_id=${c.id} | ${c.name} | ssh ${c.username}@${c.host}:${c.port}${
            c.deviceKind ? ` | ${deviceKindLabel(c.deviceKind)}` : ''
          }${reach}${openTab ? ` | OPEN as tab_id=${openTab.id}` : ''}`
        })
        .join('\n')
    : '(none saved)'

  const toolLines = toolchains.length
    ? toolchains
        .map((tool) =>
          tool.found
            ? `- ${tool.id}: installed${tool.version ? ` (${tool.version})` : ''} as \`${tool.command}\``
            : `- ${tool.id}: NOT installed`
        )
        .join('\n')
    : '(not detected)'

  const sections = [
    `Serial ports plugged in right now:\n${portLines}`,
    `Saved devices:\n${savedLines}`,
    // What is installed decides which next step is even possible, so a
    // suggestion can be grounded rather than guessed.
    `Toolchains on the user's own machine (this app does not flash; these are for advising the user what to run):\n${toolLines}`
  ]

  return {
    ok: true,
    result: `Devices known to this app. A serial port must be OPEN as a tab before serial_send or serial_reset can address it; the user opens one from the device list.\n\n${sections.join(
      '\n\n'
    )}`
  }
}

function describeLivePort(port: SerialPortInfo, openTabId: string | undefined): string {
  const identity = identifySerialDevice(port)
  const parts = [`- ${port.path}`]
  parts.push(identity.chip ?? identity.label)
  // Say when the board is a guess, so a recommendation is not built on it.
  parts.push(
    identity.ambiguous
      ? `probably ${deviceKindLabel(identity.kind)} (ambiguous: ${identity.candidates
          .map(deviceKindLabel)
          .join(' / ')})`
      : deviceKindLabel(identity.kind)
  )
  parts.push(`default ${identity.baudRate} baud`)
  if (port.serialNumber) parts.push(`SN ${port.serialNumber}`)
  parts.push(openTabId ? `OPEN as tab_id=${openTabId}` : 'not open')
  return parts.join(' | ')
}
