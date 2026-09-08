import { randomUUID } from 'crypto'
import { StringDecoder } from 'string_decoder'
import type { BrowserWindow } from 'electron'
import type {
  ConnectResult,
  SerialConnectOptions,
  SerialPortInfo,
  SerialSignalResult,
  SshDataEvent,
  SshStatusEvent
} from '../../shared/types'
import { compareSerialPorts, type DeviceKind } from '../../shared/deviceIdentity'
import {
  normalizeSerialOutput,
  serialEchoText,
  serialWriteBytes
} from '../../shared/serialStream'

type SerialPortModule = typeof import('serialport')
let serialModule: SerialPortModule | null = null

async function loadSerial(): Promise<SerialPortModule> {
  if (!serialModule) serialModule = await import('serialport')
  return serialModule
}

/** The subset of serialport's class this manager uses. */
interface PortLike {
  isOpen: boolean
  open(cb: (err: Error | null) => void): void
  close(cb?: (err: Error | null) => void): void
  write(data: Buffer | string, cb?: (err: Error | null | undefined) => void): boolean
  set(options: { dtr?: boolean; rts?: boolean }, cb: (err: Error | null) => void): void
  on(event: 'data', cb: (chunk: Buffer) => void): void
  on(event: 'close' | 'error' | 'end', cb: (err?: Error) => void): void
}

interface Session {
  port: PortLike
  opts: SerialConnectOptions
  /**
   * Decoder kept across chunks: a serial read boundary lands mid-character
   * often enough that decoding each chunk on its own turns UTF-8 output into
   * replacement characters at random offsets.
   */
  decoder: StringDecoder
  /** True when the previous chunk ended on a CR, for newline normalization. */
  pendingCr: boolean
  /** Set while closing on purpose, so 'close' does not report a device drop. */
  closing: boolean
}

/**
 * Reset pulse widths, in milliseconds.
 *
 * Long enough for the target to notice the line, short enough that the app is
 * not visibly blocked. The ESP32 numbers follow esptool's classic reset.
 */
const RESET_HOLD_MS = 120
const RESET_SETTLE_MS = 60

/**
 * Enumeration interval while the device list is open.
 *
 * Fast enough that plugging a board in feels immediate, slow enough that it is
 * not a continuous USB scan. A board that re-enumerates on reset (native-USB
 * ESP32-S3) disappears and returns within a couple of ticks.
 */
const WATCH_INTERVAL_MS = 2500

/**
 * Manages local serial-port sessions, one per terminal tab.
 *
 * Reuses the same `ssh:data` / `ssh:status` renderer events as SshManager and
 * WslManager, so the terminal UI, the scrollback, and every AI tool that reads
 * a tab's buffer work on a serial device without changing.
 *
 * What a serial port does NOT share with those two is a shell: there is no
 * command, no exit status, and no working directory, only bytes. Three
 * consequences are handled here rather than left to the device:
 *
 *  - Line endings. Firmware prints bare LF, which a terminal renders as a
 *    staircase, so inbound LF is normalized to CRLF.
 *  - Echo. A microcontroller does not echo what it receives, so a user typing
 *    into a serial tab would otherwise see nothing at all.
 *  - Modem control lines. See `SERIAL_SIGNAL_NOTE` in shared/deviceIdentity:
 *    the wrong DTR/RTS state leaves an ESP32 mute with no error to explain it.
 */
export class SerialManager {
  private sessions = new Map<string, Session>()
  private watchTimer: ReturnType<typeof setInterval> | undefined
  /** Signature of the last enumeration, to emit only on real changes. */
  private lastPortsKey = ''

  constructor(private getWindow: () => BrowserWindow | null) {}

  private send(channel: string, payload: unknown): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send(channel, payload)
  }

  private emitData(event: SshDataEvent): void {
    this.send('ssh:data', event)
  }

  private emitStatus(event: SshStatusEvent): void {
    this.send('ssh:status', event)
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Port settings of a live session, for the AI's device context. */
  optionsFor(sessionId: string): SerialConnectOptions | undefined {
    return this.sessions.get(sessionId)?.opts
  }

  /**
   * Enumerate the serial ports the OS knows about.
   *
   * Ordered by `compareSerialPorts` so a recognized board outranks the wall of
   * identity-less `/dev/ttyS*` entries that every Linux host and WSL install
   * reports.
   */
  async listPorts(): Promise<SerialPortInfo[]> {
    const { SerialPort } = await loadSerial()
    const raw = await SerialPort.list()
    const ports: SerialPortInfo[] = raw.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      pnpId: p.pnpId,
      locationId: p.locationId,
      vendorId: p.vendorId,
      productId: p.productId,
      // Windows-only field, absent from the cross-platform PortInfo type.
      friendlyName: (p as { friendlyName?: string }).friendlyName
    }))
    return ports.sort(compareSerialPorts)
  }

  /**
   * Watch for boards being plugged in and unplugged, emitting `serial:ports`
   * when the set changes.
   *
   * Polling rather than subscribing because serialport exposes no hot-plug
   * event on any platform; enumeration is the only mechanism there is. The
   * renderer starts this when the device list becomes visible and stops it
   * when the list is hidden, so a backgrounded window is not enumerating USB
   * on a timer forever.
   *
   * Only a changed signature is emitted. An unconditional push every tick would
   * re-render the list and, worse, discard the selection of anyone in the middle
   * of picking a port.
   */
  startWatch(intervalMs = WATCH_INTERVAL_MS): void {
    if (this.watchTimer) return
    const tick = async (): Promise<void> => {
      try {
        const ports = await this.listPorts()
        const key = ports
          .map((p) => `${p.path}|${p.vendorId ?? ''}:${p.productId ?? ''}`)
          .join(',')
        if (key === this.lastPortsKey) return
        this.lastPortsKey = key
        this.send('serial:ports', { ports })
      } catch {
        // Enumeration can fail transiently while a device re-enumerates; the
        // next tick retries and the list keeps whatever it last showed.
      }
    }
    void tick()
    this.watchTimer = setInterval(() => void tick(), intervalMs)
  }

  stopWatch(): void {
    if (!this.watchTimer) return
    clearInterval(this.watchTimer)
    this.watchTimer = undefined
    // Forget the signature so the next start emits a fresh list rather than
    // assuming nothing moved while the panel was closed.
    this.lastPortsKey = ''
  }

  async connect(opts: SerialConnectOptions): Promise<ConnectResult> {
    const path = opts.path?.trim()
    if (!path) return { error: 'No serial port was given.' }
    if (!Number.isFinite(opts.baudRate) || opts.baudRate <= 0) {
      return { error: `Invalid baud rate: ${String(opts.baudRate)}` }
    }

    const sessionId = randomUUID()
    this.emitStatus({ sessionId, status: 'connecting' })

    try {
      const { SerialPort } = await loadSerial()
      const port = new SerialPort({
        path,
        baudRate: opts.baudRate,
        dataBits: opts.dataBits ?? 8,
        stopBits: opts.stopBits ?? 1,
        parity: opts.parity ?? 'none',
        rtscts: opts.rtscts ?? false,
        autoOpen: false
      }) as unknown as PortLike

      await new Promise<void>((resolve, reject) => {
        port.open((err) => (err ? reject(err) : resolve()))
      })

      const session: Session = {
        port,
        opts: { ...opts, path },
        decoder: new StringDecoder('utf8'),
        pendingCr: false,
        closing: false
      }
      this.sessions.set(sessionId, session)

      // Opening a port asserts DTR and RTS. For an ESP32 that holds the chip in
      // reset, so the requested state is applied immediately; the brief hold
      // releases into a clean boot log rather than silence.
      await this.applySignals(sessionId, {
        dtr: opts.dtr ?? true,
        rts: opts.rts ?? true
      }).catch(() => undefined)

      port.on('data', (chunk: Buffer) => {
        const text = this.normalizeInbound(session, chunk)
        if (text) this.emitData({ sessionId, data: text })
      })
      port.on('error', (err?: Error) => {
        // A device unplugged mid-session surfaces here on some platforms and as
        // 'close' on others; both end the session.
        this.emitStatus({
          sessionId,
          status: 'error',
          message: err?.message ?? 'Serial port error.'
        })
        this.cleanup(sessionId)
      })
      port.on('close', () => {
        if (!this.sessions.has(sessionId)) return
        this.emitStatus({
          sessionId,
          status: 'closed',
          message: session.closing ? undefined : 'Serial port closed (device reset or unplugged).'
        })
        this.cleanup(sessionId)
      })

      this.emitStatus({ sessionId, status: 'connected' })
      return { sessionId }
    } catch (e) {
      const message = describeOpenError(e, path)
      this.emitStatus({ sessionId, status: 'error', message })
      this.cleanup(sessionId)
      return { error: message }
    }
  }

  /** Decode a chunk, carrying the decoder and CR state across reads. */
  private normalizeInbound(session: Session, chunk: Buffer): string {
    const decoded = session.decoder.write(chunk)
    if (!decoded) return ''
    const { text, pendingCr } = normalizeSerialOutput(decoded, session.pendingCr)
    session.pendingCr = pendingCr
    return text
  }

  /** Send renderer keystrokes to the device, translating Enter and echoing. */
  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !session.port.isOpen) return

    const payload = serialWriteBytes(data, session.opts.newline ?? 'cr')
    if (payload) {
      try {
        session.port.write(Buffer.from(payload, 'utf8'))
      } catch {
        // The port dropped between the keystroke and this write; 'close' follows.
      }
    }

    if (session.opts.echo) this.emitData({ sessionId, data: serialEchoText(data) })
  }

  /** Serial ports have no window size; the terminal's geometry is local only. */
  resize(_sessionId: string, _cols: number, _rows: number): void {
    // Intentionally empty.
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.closing = true
    try {
      if (session.port.isOpen) session.port.close()
    } catch {
      // already gone
    }
    this.cleanup(sessionId)
  }

  /** Assert or clear DTR/RTS on a live session. */
  async setSignals(
    sessionId: string,
    signals: { dtr?: boolean; rts?: boolean }
  ): Promise<SerialSignalResult> {
    if (!this.sessions.has(sessionId)) return { error: 'Session not found.' }
    try {
      await this.applySignals(sessionId, signals)
      return { ok: true, ...this.signalState(sessionId) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** The lines as this manager last set them, for the caller's UI state. */
  private signalState(sessionId: string): { dtr?: boolean; rts?: boolean } {
    const opts = this.sessions.get(sessionId)?.opts
    return { dtr: opts?.dtr, rts: opts?.rts }
  }

  private applySignals(
    sessionId: string,
    signals: { dtr?: boolean; rts?: boolean }
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.reject(new Error('Session not found.'))
    const next = { ...session.opts, ...signals }
    session.opts = next
    return new Promise<void>((resolve, reject) => {
      session.port.set({ dtr: signals.dtr, rts: signals.rts }, (err) =>
        err ? reject(err) : resolve()
      )
    })
  }

  /**
   * Reboot the attached board by pulsing its reset line, so the caller can read
   * the boot log that follows.
   *
   * The pulse differs per family because the wiring does. On an ESP32 devkit
   * the bridge chip's RTS drives EN, so asserting RTS with DTR clear resets the
   * chip into the running firmware — asserting both would drop it into the
   * download stub instead, which prints nothing useful. On an Arduino it is DTR
   * that is capacitively coupled to the MCU's reset pin, so a DTR transition is
   * the pulse. Anything else gets both lines cycled, which is the best a
   * generic USB-UART allows.
   */
  async resetDevice(sessionId: string, kind?: DeviceKind): Promise<SerialSignalResult> {
    const session = this.sessions.get(sessionId)
    if (!session) return { error: 'Session not found.' }

    const sequence: { dtr: boolean; rts: boolean }[] =
      kind === 'esp32'
        ? [
            { dtr: false, rts: true },
            { dtr: false, rts: false }
          ]
        : kind === 'arduino'
          ? [
              { dtr: false, rts: false },
              { dtr: true, rts: true }
            ]
          : [
              { dtr: false, rts: false },
              { dtr: true, rts: true }
            ]

    try {
      for (const [index, step] of sequence.entries()) {
        await this.applySignals(sessionId, step)
        await delay(index === 0 ? RESET_HOLD_MS : RESET_SETTLE_MS)
      }
      return { ok: true, ...this.signalState(sessionId) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  private cleanup(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  disposeAll(): void {
    this.stopWatch()
    for (const id of [...this.sessions.keys()]) {
      this.close(id)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Turn a port-open failure into something actionable.
 *
 * The raw errors are opaque ("Error: Error: No such file or directory, cannot
 * open /dev/ttyUSB0"), and the two common causes both have a specific fix the
 * user can act on: a Linux account that is not in the dialout group, or another
 * program already holding the port.
 */
function describeOpenError(e: unknown, path: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (/permission denied/i.test(raw)) {
    return process.platform === 'linux'
      ? `Permission denied opening ${path}. Add your user to the 'dialout' group (sudo usermod -aG dialout $USER) and log back in.`
      : `Permission denied opening ${path}.`
  }
  if (/busy|access denied/i.test(raw)) {
    return `${path} is in use. Close any serial monitor, esptool, or arduino-cli session holding it.`
  }
  if (/no such file|cannot open/i.test(raw)) {
    return `${path} is not available. The device may have been unplugged.`
  }
  return raw
}
