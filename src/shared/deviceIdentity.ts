/**
 * Recognize an embedded board from the USB-serial adapter it appears as.
 *
 * The identification is a guess and the type says so, because the hardware
 * makes certainty impossible: a CH340 is the bridge chip on both an ESP32
 * devkit and an Arduino clone, and a CP2102 on a USB-TTL cable is just as
 * likely to be wired to a Raspberry Pi's UART header. Boards that expose their
 * own USB (Espressif's native CDC, an official Arduino, an RP2040) do identify
 * themselves, so those are the only cases treated as known.
 *
 * What the guess is FOR is the two settings a user cannot debug by looking at
 * them: the baud rate, and the DTR/RTS lines. Both wrong-by-default cases end
 * with an empty terminal and no error (see `SERIAL_SIGNAL_NOTE`), so the cost
 * of a defaulted-wrong board is much lower than the cost of no default at all.
 */

/**
 * What to append to a line the user submits on a serial terminal.
 *
 * Declared here, next to the per-board defaults that choose it, so the device
 * table stays the single source of truth for port settings.
 */
export type SerialNewline = 'none' | 'cr' | 'lf' | 'crlf'

/** Board family a device belongs to, for icons, defaults, and AI context. */
export type DeviceKind =
  | 'esp32'
  | 'arduino'
  | 'raspberry-pi'
  | 'orange-pi'
  | 'rp2040'
  | 'linux-host'
  | 'serial'

/** A serial port as enumerated by the OS (mirrors serialport's `PortInfo`). */
export interface SerialPortInfo {
  /** `COM3` on Windows, `/dev/ttyUSB0` or `/dev/ttyACM0` elsewhere. */
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
  locationId?: string
  /** Lowercase hex without `0x`, e.g. `10c4`. Absent for non-USB ports. */
  vendorId?: string
  productId?: string
  /** Windows-only descriptive name from the driver. */
  friendlyName?: string
}

/**
 * Why DTR/RTS defaults are per-board rather than a single sensible value.
 *
 * A serial library opens a port with both lines asserted, which is right for a
 * plain USB-UART cable and wrong for the two boards this app targets. On an
 * ESP32 devkit the bridge chip's DTR and RTS drive IO0 and EN, so asserting
 * both holds the chip in reset and it prints nothing at all. On an Arduino UNO
 * the same assertion pulses the MCU's reset line, which is what makes the boot
 * output appear and is therefore wanted.
 */
export const SERIAL_SIGNAL_NOTE =
  'DTR/RTS drive EN/IO0 on ESP32 devkits (asserting both holds the chip in reset) and reset on Arduino boards.'

/** Everything a board guess decides, including the two settings that matter. */
export interface DeviceIdentity {
  kind: DeviceKind
  /** Human label for the device row, e.g. `ESP32 · CP210x`. */
  label: string
  /** Chip or product the label was derived from, when known. */
  chip?: string
  baudRate: number
  dtr: boolean
  rts: boolean
  /** Bytes Enter should send. See `DEFAULT_NEWLINE`. */
  newline: SerialNewline
  /**
   * True when this bridge chip is used by several board families, so the UI
   * and the AI should offer `candidates` instead of stating `kind` as fact.
   */
  ambiguous: boolean
  /** Families this chip is commonly found on, most likely first. */
  candidates: DeviceKind[]
  /** True for a real USB device, false for a legacy/virtual `ttyS*` port. */
  usb: boolean
}

/** Baud rate a board family is normally read at. */
const DEFAULT_BAUD: Record<DeviceKind, number> = {
  esp32: 115200,
  // Serial.begin(9600) is the default in Arduino's own examples, and 9600 is
  // what the IDE's Serial Monitor opens with.
  arduino: 9600,
  'raspberry-pi': 115200,
  'orange-pi': 115200,
  rp2040: 115200,
  'linux-host': 115200,
  serial: 115200
}

/**
 * What Enter should send, per board family.
 *
 * The split is between targets that run a terminal driver and targets that
 * read bytes. A Linux console — a Pi over its UART header, or any SBC — arrives
 * with `ICRNL` set, so the tty turns a CR into the newline the shell wants;
 * sending CRLF there produces two newlines and a doubled prompt. Firmware has
 * no tty, and the near-universal Arduino idiom is
 * `Serial.readStringUntil('\n')`, which on CRLF input returns a string with a
 * trailing CR still attached — the quiet kind of bug that costs an evening.
 * So: CR for anything with a shell, LF for anything without one.
 */
const DEFAULT_NEWLINE: Record<DeviceKind, SerialNewline> = {
  esp32: 'lf',
  arduino: 'lf',
  'raspberry-pi': 'cr',
  'orange-pi': 'cr',
  rp2040: 'cr',
  'linux-host': 'cr',
  serial: 'cr'
}

/** See SERIAL_SIGNAL_NOTE: only ESP32 needs both lines held low. */
const DEFAULT_SIGNALS: Record<DeviceKind, { dtr: boolean; rts: boolean }> = {
  esp32: { dtr: false, rts: false },
  arduino: { dtr: true, rts: true },
  'raspberry-pi': { dtr: true, rts: true },
  'orange-pi': { dtr: true, rts: true },
  rp2040: { dtr: true, rts: true },
  'linux-host': { dtr: true, rts: true },
  serial: { dtr: true, rts: true }
}

interface ChipEntry {
  chip: string
  kind: DeviceKind
  candidates?: DeviceKind[]
  /** Overrides the family default, for a board that is known exactly. */
  baudRate?: number
}

/**
 * Exact vendor:product matches, for devices that expose their own USB and so
 * name themselves unambiguously.
 */
const BY_VID_PID: Record<string, ChipEntry> = {
  // --- Espressif native USB-CDC (ESP32-S2/S3/C3/C6) -----------------------
  '303a:1001': { chip: 'ESP32 USB-CDC', kind: 'esp32' },
  '303a:0002': { chip: 'ESP32-S2', kind: 'esp32' },
  '303a:1002': { chip: 'ESP32-S3', kind: 'esp32' },
  '303a:4001': { chip: 'ESP32 USB-JTAG/serial', kind: 'esp32' },

  // --- Official Arduino ----------------------------------------------------
  '2341:0043': { chip: 'Arduino UNO R3', kind: 'arduino' },
  '2341:0001': { chip: 'Arduino UNO', kind: 'arduino' },
  '2341:0069': { chip: 'Arduino UNO R4 Minima', kind: 'arduino' },
  '2341:1002': { chip: 'Arduino UNO R4 WiFi', kind: 'arduino' },
  '2341:0010': { chip: 'Arduino Mega 2560', kind: 'arduino' },
  '2341:0042': { chip: 'Arduino Mega 2560 R3', kind: 'arduino' },
  '2341:003d': { chip: 'Arduino Due', kind: 'arduino' },
  '2341:8036': { chip: 'Arduino Leonardo', kind: 'arduino' },
  '2341:0036': { chip: 'Arduino Leonardo (bootloader)', kind: 'arduino' },
  '2341:804d': { chip: 'Arduino Zero', kind: 'arduino' },
  // Arduino.org fork, same boards under a different vendor id.
  '2a03:0043': { chip: 'Arduino UNO R3', kind: 'arduino' },
  '2a03:0001': { chip: 'Arduino UNO', kind: 'arduino' },

  // --- Raspberry Pi silicon ------------------------------------------------
  '2e8a:0005': { chip: 'Raspberry Pi Pico (CDC)', kind: 'rp2040' },
  '2e8a:000a': { chip: 'Raspberry Pi Pico (SDK CDC)', kind: 'rp2040' },
  '2e8a:000c': { chip: 'Raspberry Pi Debug Probe', kind: 'rp2040' },
  '2e8a:0003': { chip: 'Raspberry Pi RP2 Boot', kind: 'rp2040' }
}

/**
 * Bridge chips, matched on vendor id alone.
 *
 * Every entry here is ambiguous by nature: the chip is soldered onto boards
 * from different families, or sold as a bare USB-TTL cable. `kind` is the most
 * common board it is found on, and `candidates` carries the rest so nothing
 * downstream has to pretend the guess was certain.
 */
const BY_VID: Record<string, ChipEntry> = {
  // Silicon Labs CP210x — the usual ESP32 devkit bridge, also sold as a cable.
  '10c4': {
    chip: 'CP210x USB-UART',
    kind: 'esp32',
    candidates: ['esp32', 'raspberry-pi', 'serial']
  },
  // QinHeng CH340/CH341/CH9102 — ESP32 devkits and Arduino clones both.
  '1a86': {
    chip: 'CH34x USB-UART',
    kind: 'esp32',
    candidates: ['esp32', 'arduino', 'raspberry-pi', 'serial']
  },
  // FTDI — older Arduino boards, ESP dev boards, and generic cables.
  '0403': {
    chip: 'FTDI USB-UART',
    kind: 'serial',
    candidates: ['arduino', 'esp32', 'raspberry-pi', 'serial']
  },
  // Prolific PL2303 — almost always a bare USB-TTL cable.
  '067b': {
    chip: 'PL2303 USB-UART',
    kind: 'serial',
    candidates: ['raspberry-pi', 'serial']
  }
}

/** Specific bridge chips worth naming, where the product id is known. */
const BRIDGE_BY_VID_PID: Record<string, string> = {
  '10c4:ea60': 'CP2102 USB-UART',
  '10c4:ea70': 'CP2105 USB-UART',
  '10c4:ea71': 'CP2108 USB-UART',
  '1a86:7523': 'CH340 USB-UART',
  '1a86:5523': 'CH341 USB-UART',
  '1a86:55d3': 'CH343 USB-UART',
  '1a86:55d4': 'CH9102 USB-UART',
  '0403:6001': 'FT232R USB-UART',
  '0403:6010': 'FT2232 USB-UART',
  '0403:6015': 'FT231X USB-UART',
  '067b:2303': 'PL2303 USB-UART'
}

/** Lowercase a USB id and drop an `0x` prefix, so Windows and Linux agree. */
function normalizeId(id: string | undefined): string {
  if (!id) return ''
  return id.trim().toLowerCase().replace(/^0x/, '')
}

/** Display name for a board family. */
export function deviceKindLabel(kind: DeviceKind): string {
  switch (kind) {
    case 'esp32':
      return 'ESP32'
    case 'arduino':
      return 'Arduino'
    case 'raspberry-pi':
      return 'Raspberry Pi'
    case 'orange-pi':
      return 'Orange Pi'
    case 'rp2040':
      return 'RP2040'
    case 'linux-host':
      return 'Linux host'
    case 'serial':
      return 'Serial device'
  }
}

/**
 * Identify the board behind a serial port.
 *
 * Never throws and never returns null: an unrecognized port is still a port the
 * user may want to open, so it comes back as `serial` with library defaults.
 */
export function identifySerialDevice(info: SerialPortInfo): DeviceIdentity {
  const vid = normalizeId(info.vendorId)
  const pid = normalizeId(info.productId)
  const usb = vid.length > 0
  const key = `${vid}:${pid}`

  const exact = BY_VID_PID[key]
  const bridge = exact ? undefined : BY_VID[vid]
  const entry: ChipEntry = exact ??
    bridge ?? { chip: '', kind: 'serial', candidates: ['serial'] }

  // A named bridge beats the vendor-wide label: "CH340" is more use than "CH34x".
  const chip = (!exact && BRIDGE_BY_VID_PID[key]) || entry.chip || undefined

  const kind = entry.kind
  const candidates = entry.candidates ?? [kind]
  const ambiguous = candidates.length > 1
  const signals = DEFAULT_SIGNALS[kind]

  return {
    kind,
    label: buildLabel(info, kind, chip, ambiguous),
    chip,
    baudRate: entry.baudRate ?? DEFAULT_BAUD[kind],
    dtr: signals.dtr,
    rts: signals.rts,
    newline: DEFAULT_NEWLINE[kind],
    ambiguous,
    candidates,
    usb
  }
}

/**
 * Label a device row.
 *
 * An exactly-known board is named outright; an ambiguous bridge chip is named
 * by the chip rather than the guessed family, so the row never asserts a board
 * that may not be plugged in. The port path is left to the UI, which shows it
 * in its own column.
 */
function buildLabel(
  info: SerialPortInfo,
  kind: DeviceKind,
  chip: string | undefined,
  ambiguous: boolean
): string {
  if (!ambiguous && chip) return chip
  if (chip) return chip
  // Fall back to whatever the OS volunteered before saying nothing useful.
  const osName = info.friendlyName?.trim() || info.manufacturer?.trim()
  if (osName) return osName
  return deviceKindLabel(kind)
}

/**
 * Order ports for the device list: recognized boards first, then other USB
 * devices, then legacy `ttyS*` ports.
 *
 * The last group is why this exists. A Linux host (and every WSL install)
 * enumerates eight or more `/dev/ttyS*` ports that carry no USB identity and
 * almost never have anything attached, which would otherwise bury the one
 * board the user actually plugged in.
 */
export function compareSerialPorts(a: SerialPortInfo, b: SerialPortInfo): number {
  const ia = identifySerialDevice(a)
  const ib = identifySerialDevice(b)
  const rank = (id: DeviceIdentity): number => {
    if (id.usb && !id.ambiguous && id.kind !== 'serial') return 0
    if (id.usb) return 1
    return 2
  }
  const byRank = rank(ia) - rank(ib)
  if (byRank !== 0) return byRank
  return a.path.localeCompare(b.path, undefined, { numeric: true })
}

/** Baud rates offered in the connect dialog. */
export const SERIAL_BAUD_PRESETS = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600,
  // The ESP32/ESP8266 ROM bootloader logs at 74880 before the app starts, which
  // is why a board opened at 115200 shows a line of garbage on every reset.
  74880, 115200, 230400, 250000, 460800, 921600, 1000000, 2000000
] as const
