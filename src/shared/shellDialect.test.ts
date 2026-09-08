import { describe, expect, it } from 'vitest'
import {
  execShellArgs,
  shellDialect,
  splitCwdMarker,
  wrapExecCommand,
  EXEC_CWD_MARKER
} from './shellDialect'

describe('shellDialect', () => {
  it('classifies by executable name, not by platform', () => {
    // Git Bash on Windows is POSIX and WSL's shell reached from Windows is
    // too, so keying off `process.platform` would get both wrong.
    expect(shellDialect('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('posix')
    expect(shellDialect('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell')
    expect(shellDialect('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(
      'powershell'
    )
    expect(shellDialect('C:\\Windows\\system32\\cmd.exe')).toBe('cmd')
    expect(shellDialect('/usr/bin/zsh')).toBe('posix')
  })

  it('defaults an unrecognised shell to POSIX', () => {
    // fish, dash, or a wrapper script is far likelier than a new Windows
    // shell, and POSIX is what every pre-existing caller already assumed.
    expect(shellDialect('/usr/local/bin/fish')).toBe('posix')
  })
})

describe('wrapExecCommand', () => {
  it('re-raises the command exit code after the cwd probe, not the probe s', () => {
    // The probe runs last and succeeds, so a wrapper that let it set the exit
    // status would report every failing command as a success.
    const posix = wrapExecCommand('false', 'posix')
    expect(posix).toContain('__aissh_ec=$?')
    expect(posix.trimEnd().endsWith('exit $__aissh_ec')).toBe(true)

    const ps = wrapExecCommand('Get-Item nope', 'powershell')
    expect(ps.trimEnd().endsWith('exit $__aissh_ec')).toBe(true)

    const cmd = wrapExecCommand('dir nope', 'cmd')
    expect(cmd).toContain('set __aissh_ec=%ERRORLEVEL%')
    expect(cmd.trimEnd().endsWith('exit /b %__aissh_ec%')).toBe(true)
  })

  it('captures the PowerShell status before anything can overwrite it', () => {
    // Assigning to a variable is itself a statement, so it sets `$?`. Reading
    // `$?` on the very first line after the command is the only correct order.
    const ps = wrapExecCommand('Get-Item nope', 'powershell')
    const lines = ps.split('\n')
    expect(lines[1]).toBe('$__aissh_ok = $?')
  })

  it('emits the same marker on every dialect, so one parser reads them all', () => {
    for (const dialect of ['posix', 'powershell', 'cmd'] as const) {
      expect(wrapExecCommand('x', dialect)).toContain(EXEC_CWD_MARKER)
    }
  })
})

describe('execShellArgs', () => {
  it('keeps a user profile out of captured stdout', () => {
    // A prompt customisation printed by the profile would land in the agent's
    // stdout and be read as part of the command's output.
    expect(execShellArgs('powershell', 'x')).toContain('-NoProfile')
    expect(execShellArgs('cmd', 'x')).toContain('/d')
  })

  it('passes the command last, where the shell expects it', () => {
    expect(execShellArgs('posix', 'ls -l')).toEqual(['-c', 'ls -l'])
    expect(execShellArgs('powershell', 'ls').at(-1)).toBe('ls')
    expect(execShellArgs('cmd', 'dir').at(-1)).toBe('dir')
  })
})

describe('splitCwdMarker', () => {
  it('pulls the directory out and leaves the output clean', () => {
    const { text, cwd } = splitCwdMarker(`hello\nworld\n${EXEC_CWD_MARKER}/tmp/x\n`)
    expect(text).toBe('hello\nworld')
    expect(cwd).toBe('/tmp/x')
  })

  it('takes the last marker, so output that happens to contain one is safe', () => {
    // `cat` of a file holding the sentinel would otherwise truncate the output
    // at the file's copy and report a directory the shell was never in.
    const raw = `${EXEC_CWD_MARKER}/decoy\nreal output\n${EXEC_CWD_MARKER}/tmp/real\n`
    expect(splitCwdMarker(raw).cwd).toBe('/tmp/real')
  })

  it('returns the text untouched when there is no marker', () => {
    expect(splitCwdMarker('plain')).toEqual({ text: 'plain' })
  })

  it('handles a Windows path, which contains no forward slashes at all', () => {
    expect(splitCwdMarker(`out\n${EXEC_CWD_MARKER}C:\\Users\\me\n`).cwd).toBe('C:\\Users\\me')
  })
})
