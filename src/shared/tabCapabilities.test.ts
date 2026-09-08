import { describe, expect, it } from 'vitest'
import {
  describeTabLimits,
  hasCommandChannel,
  hasFileChannel,
  isSerialTab
} from './tabCapabilities'
import { describeTabOs } from './prompts/terminalContext'

describe('hasFileChannel', () => {
  it('is true only for SSH, which is where SFTP lives', () => {
    expect(hasFileChannel('ssh')).toBe(true)
    expect(hasFileChannel('wsl')).toBe(false)
    expect(hasFileChannel('serial')).toBe(false)
  })

  it('treats a tab with no kind as SSH', () => {
    // The field postdates the app, so every session saved before it exists
    // without one — and they were all SSH.
    expect(hasFileChannel(undefined)).toBe(true)
  })
})

describe('hasCommandChannel', () => {
  it('excludes only serial, which has no shell to run anything', () => {
    expect(hasCommandChannel('ssh')).toBe(true)
    expect(hasCommandChannel('wsl')).toBe(true)
    expect(hasCommandChannel(undefined)).toBe(true)
    expect(hasCommandChannel('serial')).toBe(false)
  })

  it('is a different question from hasFileChannel', () => {
    // WSL is the case that proves the two are not one predicate: it runs
    // commands fine and has no SFTP, so a single "is it ssh" check would have
    // taken away exec_command along with read_file.
    expect(hasFileChannel('wsl')).toBe(false)
    expect(hasCommandChannel('wsl')).toBe(true)
  })
})

describe('isSerialTab', () => {
  it('recognises serial and nothing else', () => {
    expect(isSerialTab('serial')).toBe(true)
    expect(isSerialTab('ssh')).toBe(false)
    expect(isSerialTab('wsl')).toBe(false)
    expect(isSerialTab(undefined)).toBe(false)
  })
})

describe('describeTabLimits', () => {
  it('names a working alternative for every transport it restricts', () => {
    // These strings go to the model as the reason a call failed. A refusal that
    // does not say what does work costs another failed call to find out.
    expect(describeTabLimits('wsl')).toMatch(/exec_command/)
    expect(describeTabLimits('serial')).toMatch(/serial_send/)
  })

  it('says plainly that serial has no shell', () => {
    expect(describeTabLimits('serial')).toMatch(/no shell/i)
    expect(describeTabLimits('serial')).toMatch(/exit code/i)
  })
})

describe('describeTabOs', () => {
  it('describes an SSH tab as a remote host', () => {
    expect(describeTabOs('ssh')).toMatch(/SSH/)
    expect(describeTabOs(undefined)).toMatch(/SSH/)
  })

  it('names the WSL distro and the missing SFTP channel', () => {
    const text = describeTabOs('wsl', 'Ubuntu-24.04')
    expect(text).toContain('Ubuntu-24.04')
    expect(text).toMatch(/no SFTP/i)
  })

  it('carries the port, baud and board so the model can address the device', () => {
    const text = describeTabOs('serial', undefined, {
      path: '/dev/ttyUSB0',
      baudRate: 115200,
      board: 'ESP32'
    })
    expect(text).toContain('/dev/ttyUSB0')
    expect(text).toContain('115200')
    expect(text).toContain('ESP32')
  })

  it('rules out the tools that cannot work, and names the two that can', () => {
    // Without this the model spends a turn discovering that exec_command
    // fails, and on a device that prints nothing it is liable to read the
    // failure as a dead board.
    const text = describeTabOs('serial', undefined, { path: '/dev/ttyUSB0' })
    for (const tool of ['exec_command', 'run_in_terminal', 'grep', 'glob', 'git']) {
      expect(text, tool).toContain(tool)
    }
    expect(text).toContain('serial_send')
    expect(text).toContain('serial_reset')
    expect(text).toMatch(/no exit code/i)
  })

  it('reads cleanly when the board is unidentified', () => {
    // A CH340 is shared between ESP32 and Arduino clones and cannot be told
    // apart, so an unlabelled serial tab is a normal case, not a broken one.
    const text = describeTabOs('serial', undefined, { path: 'COM3' })
    expect(text).toContain('COM3')
    expect(text).not.toContain('()')
    expect(text).not.toContain('undefined')
  })
})
