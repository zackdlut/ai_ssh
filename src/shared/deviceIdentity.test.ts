import { describe, expect, it } from 'vitest'
import {
  compareSerialPorts,
  identifySerialDevice,
  type SerialPortInfo
} from './deviceIdentity'

const port = (over: Partial<SerialPortInfo> = {}): SerialPortInfo => ({
  path: '/dev/ttyUSB0',
  ...over
})

describe('identifySerialDevice', () => {
  it('names a board that exposes its own USB, with no ambiguity', () => {
    const id = identifySerialDevice(port({ vendorId: '2341', productId: '0043' }))
    expect(id.kind).toBe('arduino')
    expect(id.chip).toBe('Arduino UNO R3')
    expect(id.ambiguous).toBe(false)
    expect(id.candidates).toEqual(['arduino'])
  })

  it('accepts the 0x-prefixed uppercase ids Windows reports', () => {
    const lower = identifySerialDevice(port({ vendorId: '303a', productId: '1001' }))
    const upper = identifySerialDevice(port({ vendorId: '0x303A', productId: '0X1001' }))
    expect(upper).toEqual(lower)
    expect(upper.kind).toBe('esp32')
  })

  it('holds DTR and RTS low for ESP32, because asserting both keeps it in reset', () => {
    const id = identifySerialDevice(port({ vendorId: '10c4', productId: 'ea60' }))
    expect(id.kind).toBe('esp32')
    expect(id.dtr).toBe(false)
    expect(id.rts).toBe(false)
  })

  it('asserts DTR for Arduino, where the reset pulse is what shows boot output', () => {
    const id = identifySerialDevice(port({ vendorId: '2341', productId: '0043' }))
    expect(id.dtr).toBe(true)
    expect(id.rts).toBe(true)
  })

  it('sends LF to firmware and CR to anything with a tty', () => {
    // readStringUntil('\n') is the Arduino idiom; CRLF would leave a stray CR.
    expect(identifySerialDevice(port({ vendorId: '2341', productId: '0043' })).newline).toBe('lf')
    expect(identifySerialDevice(port({ vendorId: '303a', productId: '1001' })).newline).toBe('lf')
    // A Linux console has ICRNL, so CRLF would produce a doubled prompt.
    expect(identifySerialDevice(port({ vendorId: '067b', productId: '2303' })).newline).toBe('cr')
    expect(identifySerialDevice(port({ path: '/dev/ttyS0' })).newline).toBe('cr')
  })

  it('defaults ESP32 to 115200 and Arduino to 9600', () => {
    expect(identifySerialDevice(port({ vendorId: '303a', productId: '1001' })).baudRate).toBe(
      115200
    )
    expect(identifySerialDevice(port({ vendorId: '2341', productId: '0043' })).baudRate).toBe(9600)
  })

  it('reports a CH340 as ambiguous, since ESP32 devkits and Arduino clones share it', () => {
    const id = identifySerialDevice(port({ vendorId: '1a86', productId: '7523' }))
    expect(id.ambiguous).toBe(true)
    expect(id.candidates).toContain('esp32')
    expect(id.candidates).toContain('arduino')
    // Labelled by the chip, so the row never claims a board that may not be there.
    expect(id.label).toBe('CH340 USB-UART')
  })

  it('names the specific bridge chip rather than the vendor-wide family', () => {
    expect(identifySerialDevice(port({ vendorId: '10c4', productId: 'ea60' })).chip).toBe(
      'CP2102 USB-UART'
    )
    expect(identifySerialDevice(port({ vendorId: '1a86', productId: '55d4' })).chip).toBe(
      'CH9102 USB-UART'
    )
  })

  it('falls back to the vendor entry for an unlisted product id', () => {
    const id = identifySerialDevice(port({ vendorId: '10c4', productId: 'ffff' }))
    expect(id.kind).toBe('esp32')
    expect(id.chip).toBe('CP210x USB-UART')
  })

  it('treats an unknown port as a generic serial device with library defaults', () => {
    const id = identifySerialDevice(port({ path: '/dev/ttyS0' }))
    expect(id.kind).toBe('serial')
    expect(id.usb).toBe(false)
    expect(id.ambiguous).toBe(false)
    expect(id.dtr).toBe(true)
    expect(id.rts).toBe(true)
  })

  it('uses the name the OS volunteered when the ids mean nothing', () => {
    const id = identifySerialDevice(port({ friendlyName: 'USB Serial Device (COM7)' }))
    expect(id.label).toBe('USB Serial Device (COM7)')
  })

  it('recognizes a Pico as RP2040 rather than a Raspberry Pi SBC', () => {
    const id = identifySerialDevice(port({ vendorId: '2e8a', productId: '000a' }))
    expect(id.kind).toBe('rp2040')
    expect(id.ambiguous).toBe(false)
  })
})

describe('compareSerialPorts', () => {
  it('ranks a recognized board above a bare bridge chip above a legacy port', () => {
    const uno = port({ path: '/dev/ttyACM0', vendorId: '2341', productId: '0043' })
    const ch340 = port({ path: '/dev/ttyUSB0', vendorId: '1a86', productId: '7523' })
    const legacy = port({ path: '/dev/ttyS0' })
    expect([legacy, ch340, uno].sort(compareSerialPorts)).toEqual([uno, ch340, legacy])
  })

  it('keeps the WSL wall of ttyS ports below the board that was plugged in', () => {
    const legacy = Array.from({ length: 8 }, (_, i) => port({ path: `/dev/ttyS${i}` }))
    const esp = port({ path: '/dev/ttyUSB0', vendorId: '10c4', productId: 'ea60' })
    const sorted = [...legacy, esp].sort(compareSerialPorts)
    expect(sorted[0]).toBe(esp)
  })

  it('orders same-rank ports numerically, so ttyS10 follows ttyS9', () => {
    const ports = [port({ path: '/dev/ttyS10' }), port({ path: '/dev/ttyS9' })]
    expect(ports.sort(compareSerialPorts).map((p) => p.path)).toEqual([
      '/dev/ttyS9',
      '/dev/ttyS10'
    ])
  })
})
