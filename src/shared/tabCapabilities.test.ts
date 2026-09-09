import { describe, expect, it } from 'vitest'
import {
  describeTabLimits,
  hasCommandChannel,
  hasFileChannel,
  isSerialTab
} from './tabCapabilities'
import { describeTabOs } from './prompts/terminalContext'

describe('hasFileChannel', () => {
  it('covers the transports that can address a filesystem', () => {
    // SSH gets one from SFTP and a local shell from the machine it runs on.
    expect(hasFileChannel('ssh')).toBe(true)
    expect(hasFileChannel('local')).toBe(true)
    // A WSL pty's files live inside the distro, which the main process cannot
    // reach as local paths, and a serial port has no filesystem at all.
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
    expect(hasCommandChannel('local')).toBe(true)
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
    expect(isSerialTab('local')).toBe(false)
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

  it('does not restrict a local shell, which has both channels', () => {
    expect(describeTabLimits('local')).not.toMatch(/no |cannot|use exec_command/i)
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

  it('never lets a local tab fall through to the SSH description', () => {
    // This is the whole reason the case exists. The function ends in a bare
    // `return 'remote Linux/Unix over SSH'`, so a missing branch does not fail
    // loudly — it tells the model a Windows workstation is a Linux server, and
    // the next tool call is `systemctl` or `apt`.
    for (const shell of [undefined, 'pwsh.exe', 'C:\\Windows\\system32\\cmd.exe', '/bin/zsh']) {
      expect(describeTabOs('local', undefined, undefined, { shell })).not.toMatch(/over SSH/)
    }
  })

  it('names the shell language, because it decides what commands are valid', () => {
    const ps = describeTabOs('local', undefined, undefined, { shell: 'C:\\pwsh.exe' })
    expect(ps).toMatch(/PowerShell/)
    expect(ps).toMatch(/no systemctl/i)

    const cmd = describeTabOs('local', undefined, undefined, { shell: 'cmd.exe' })
    expect(cmd).toMatch(/Command Prompt/)

    const posix = describeTabOs('local', undefined, undefined, { shell: '/bin/bash' })
    expect(posix).not.toMatch(/PowerShell|Command Prompt/)
  })

  it('tells the model the file tools DO work on a local tab', () => {
    // The WSL sentence says the opposite, and the two are one branch apart.
    expect(describeTabOs('local')).toMatch(/file tools DO work/)
    expect(describeTabOs('wsl')).toMatch(/do not work/)
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

  it('survives the renderer, which has no `process` global', () => {
    /*
     * This module is imported by the renderer, whose main world gets no
     * `process` binding — so `process.platform` there is a ReferenceError that
     * takes down the turn assembly calling it, with no error surfacing anywhere
     * because the callers are all `void`-ed promises. Every other test in this
     * file runs under Node, where the global exists and the bug is invisible.
     */
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'process')
    // @ts-expect-error deleting a global to emulate the renderer's main world
    delete globalThis.process
    try {
      expect(typeof process).toBe('undefined')
      for (const shell of [undefined, '/bin/bash', 'pwsh.exe', 'cmd.exe']) {
        expect(() => describeTabOs('local', undefined, undefined, { shell })).not.toThrow()
      }
      expect(describeTabOs('local', undefined, undefined, { shell: '/bin/bash' })).toMatch(
        /own machine/
      )
    } finally {
      if (saved) Object.defineProperty(globalThis, 'process', saved)
    }
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
