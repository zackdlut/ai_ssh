import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'

;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: () => null,
  setItem: () => {}
}

const {
  findSerialTabByPath,
  serialConfigFromPort,
  shortPortPath,
  toggleSerialSignal,
  resetSerialDevice,
  disconnectSerialTab
} = await import('./serialActions')

/** Calls made through the preload bridge, so each test can assert on them. */
let setSignalsCalls: { sessionId: string; signals: Record<string, unknown> }[] = []
let resetCalls: { sessionId: string; kind?: string }[] = []
let closeCalls: string[] = []
let signalReply: { ok?: true; error?: string; dtr?: boolean; rts?: boolean } = { ok: true }
let resetReply: { ok?: true; error?: string; dtr?: boolean; rts?: boolean } = { ok: true }

function serialTab(over: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 'tab-1',
    sessionId: 'ses-1',
    title: 'ttyUSB0',
    status: 'connected',
    host: '',
    port: 0,
    username: '',
    kind: 'serial',
    serialOpts: { path: '/dev/ttyUSB0', baudRate: 115200 },
    ...over
  }
}

beforeEach(() => {
  setSignalsCalls = []
  resetCalls = []
  closeCalls = []
  signalReply = { ok: true }
  resetReply = { ok: true }
  useSessionsStore.setState({ sessions: [], activeSessionId: null })
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      serial: {
        setSignals: (sessionId: string, signals: Record<string, unknown>) => {
          setSignalsCalls.push({ sessionId, signals })
          return Promise.resolve(signalReply)
        },
        reset: (sessionId: string, kind?: string) => {
          resetCalls.push({ sessionId, kind })
          return Promise.resolve(resetReply)
        }
      },
      ssh: { close: (sessionId: string) => closeCalls.push(sessionId) }
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }
})

describe('findSerialTabByPath', () => {
  it('matches a connected serial tab by the port it holds', () => {
    useSessionsStore.setState({ sessions: [serialTab()] })
    expect(findSerialTabByPath('/dev/ttyUSB0')?.id).toBe('tab-1')
    expect(findSerialTabByPath('/dev/ttyUSB1')).toBeUndefined()
  })

  it('ignores a tab that is not connected', () => {
    // A closed tab still remembers its port. Treating it as live would make
    // the sidebar offer a reset on a session that no longer exists.
    useSessionsStore.setState({ sessions: [serialTab({ status: 'closed' })] })
    expect(findSerialTabByPath('/dev/ttyUSB0')).toBeUndefined()
  })

  it('does not match an SSH tab, whose port field means something else', () => {
    useSessionsStore.setState({
      sessions: [serialTab({ kind: 'ssh', serialOpts: undefined })]
    })
    expect(findSerialTabByPath('/dev/ttyUSB0')).toBeUndefined()
  })

  it('is undefined for a path nobody supplied', () => {
    expect(findSerialTabByPath(undefined)).toBeUndefined()
  })
})

describe('toggleSerialSignal', () => {
  it('treats an unset line as asserted, so the first toggle clears it', () => {
    // This is the case that matters on an ESP32: the port opened with both
    // lines defaulted on, the terminal is empty, and the user reaches for the
    // toggle to clear one. If unset were read as false, the first click would
    // assert it and make the symptom worse.
    useSessionsStore.setState({ sessions: [serialTab()] })
    return toggleSerialSignal('tab-1', 'dtr').then(() => {
      expect(setSignalsCalls).toEqual([{ sessionId: 'ses-1', signals: { dtr: false } }])
    })
  })

  it('flips back from an explicitly cleared line', async () => {
    useSessionsStore.setState({
      sessions: [serialTab({ serialOpts: { path: '/dev/ttyUSB0', baudRate: 115200, dtr: false } })]
    })
    await toggleSerialSignal('tab-1', 'dtr')
    expect(setSignalsCalls[0].signals).toEqual({ dtr: true })
  })

  it('touches only the line it was asked about', async () => {
    useSessionsStore.setState({
      sessions: [serialTab({ serialOpts: { path: '/dev/ttyUSB0', baudRate: 115200, dtr: true, rts: false } })]
    })
    await toggleSerialSignal('tab-1', 'rts')
    expect(setSignalsCalls[0].signals).toEqual({ rts: true })
    expect(useSessionsStore.getState().sessions[0].serialOpts?.dtr).toBe(true)
  })

  it('records the state the main process reports, not the one it asked for', async () => {
    // Main owns the real lines. If it answers with a different state, the
    // checkmark has to follow it rather than the optimistic guess.
    useSessionsStore.setState({ sessions: [serialTab()] })
    signalReply = { ok: true, dtr: false, rts: false }
    await toggleSerialSignal('tab-1', 'dtr')
    const opts = useSessionsStore.getState().sessions[0].serialOpts
    expect(opts?.dtr).toBe(false)
    expect(opts?.rts).toBe(false)
  })

  it('falls back to the requested value when main reports no state', async () => {
    useSessionsStore.setState({ sessions: [serialTab()] })
    signalReply = { ok: true }
    await toggleSerialSignal('tab-1', 'dtr')
    expect(useSessionsStore.getState().sessions[0].serialOpts?.dtr).toBe(false)
  })

  it('returns the error and leaves the stored state alone on failure', async () => {
    useSessionsStore.setState({ sessions: [serialTab()] })
    signalReply = { error: 'Port closed.' }
    expect(await toggleSerialSignal('tab-1', 'dtr')).toBe('Port closed.')
    // A checkmark that moved while the line did not is worse than no feedback.
    expect(useSessionsStore.getState().sessions[0].serialOpts?.dtr).toBeUndefined()
  })

  it('refuses a tab with no live session', async () => {
    useSessionsStore.setState({ sessions: [serialTab({ sessionId: undefined })] })
    expect(await toggleSerialSignal('tab-1', 'dtr')).toMatch(/no longer connected/i)
    expect(setSignalsCalls).toHaveLength(0)
  })
})

describe('resetSerialDevice', () => {
  it('passes the board family, since the pulse differs per family', async () => {
    useSessionsStore.setState({ sessions: [serialTab({ deviceKind: 'esp32' })] })
    await resetSerialDevice('tab-1')
    expect(resetCalls).toEqual([{ sessionId: 'ses-1', kind: 'esp32' }])
  })

  it('adopts the signal state the reset sequence ended on', async () => {
    // The sequence's final step is per-family, so the UI must take main's word
    // for where the lines landed instead of modelling the sequence twice.
    useSessionsStore.setState({ sessions: [serialTab({ deviceKind: 'esp32' })] })
    resetReply = { ok: true, dtr: false, rts: false }
    await resetSerialDevice('tab-1')
    const opts = useSessionsStore.getState().sessions[0].serialOpts
    expect(opts?.dtr).toBe(false)
    expect(opts?.rts).toBe(false)
  })

  it('surfaces a failure instead of implying the board rebooted', async () => {
    useSessionsStore.setState({ sessions: [serialTab()] })
    resetReply = { error: 'Session not found.' }
    expect(await resetSerialDevice('tab-1')).toBe('Session not found.')
  })
})

describe('disconnectSerialTab', () => {
  it('closes the underlying session', () => {
    useSessionsStore.setState({ sessions: [serialTab()] })
    disconnectSerialTab('tab-1')
    expect(closeCalls).toEqual(['ses-1'])
  })

  it('does nothing for a tab that holds no session', () => {
    useSessionsStore.setState({ sessions: [serialTab({ sessionId: undefined })] })
    disconnectSerialTab('tab-1')
    expect(closeCalls).toHaveLength(0)
  })
})

describe('serialConfigFromPort', () => {
  it('derives a stable id from the path, so saving twice updates one entry', () => {
    const a = serialConfigFromPort({ path: '/dev/ttyUSB0' })
    const b = serialConfigFromPort({ path: '/dev/ttyUSB0', vendorId: '1a86' })
    expect(a.id).toBe(b.id)
    expect(a.id).toBe('serial:/dev/ttyUSB0')
  })

  it('carries the guessed port settings so a reconnect behaves the same', () => {
    // A recognised ESP32 must be saved with both lines cleared, or reopening
    // the bookmark reproduces the empty-terminal symptom the guess avoided.
    const config = serialConfigFromPort({
      path: '/dev/ttyUSB0',
      vendorId: '10c4',
      productId: 'ea60'
    })
    expect(config.kind).toBe('serial')
    expect(config.deviceKind).toBe('esp32')
    expect(config.serial?.baudRate).toBe(115200)
    expect(config.serial?.dtr).toBe(false)
    expect(config.serial?.rts).toBe(false)
  })

  it('leaves the SSH fields empty rather than inventing an address', () => {
    const config = serialConfigFromPort({ path: 'COM3' })
    expect(config.host).toBe('')
    expect(config.username).toBe('')
    expect(config.port).toBe(0)
  })

  it('names an unidentified port after the port itself', () => {
    expect(serialConfigFromPort({ path: '/dev/ttyS0' }).name).toBe('ttyS0')
  })
})

describe('shortPortPath', () => {
  it('drops the /dev prefix and leaves a Windows name alone', () => {
    expect(shortPortPath('/dev/ttyUSB0')).toBe('ttyUSB0')
    expect(shortPortPath('COM7')).toBe('COM7')
  })
})
