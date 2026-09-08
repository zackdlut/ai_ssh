/**
 * Which shell language a local session speaks.
 *
 * Every transport before this one spoke POSIX `sh`: SSH reaches a Unix host,
 * and a WSL pty is a Linux shell by definition. A shell on this machine is the
 * first that might not be, and the difference is not cosmetic — the agent's
 * command wrapper needs an exit code, a working directory, and a way to chain
 * three statements, and PowerShell and `cmd` spell all three differently.
 *
 * The dialect is derived from the executable's name rather than stored, so a
 * session recorded by an older build still resolves correctly, and a shell the
 * user typed by hand (`C:\Program Files\Git\bin\bash.exe`) is classified by
 * what it is rather than by the platform it runs on.
 */
export type ShellDialect = 'posix' | 'powershell' | 'cmd'

/** Sentinel that carries the post-command working directory out of stdout. */
export const EXEC_CWD_MARKER = '__AISSH_CWD__:'

/**
 * Classify a shell executable path.
 *
 * Defaults to POSIX: an unrecognised name is far more likely to be a Unix shell
 * (fish, dash, a wrapper script) than a new Windows one, and POSIX is also what
 * every pre-existing caller assumed.
 */
export function shellDialect(shellPath?: string): ShellDialect {
  if (!shellPath) return process.platform === 'win32' ? 'powershell' : 'posix'
  const base = shellPath
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (base === 'pwsh' || base === 'powershell') return 'powershell'
  if (base === 'cmd') return 'cmd'
  return 'posix'
}

/**
 * Wrap a command so its output ends with the working directory it left behind.
 *
 * The agent runs each command on a fresh process, so without this a `cd` in one
 * call would silently not apply to the next. The exit code has to be captured
 * before the probe runs and re-raised after it, or the probe's own success
 * would overwrite the command's failure.
 *
 * `$?` in PowerShell is a boolean about the last *statement*, not an exit code,
 * and `$LASTEXITCODE` is only set once a native executable has run — it is
 * stale, not absent, on a cmdlet. Consulting both in that order is what makes
 * `Get-ChildItem nope` and `git nope` both report failure.
 */
export function wrapExecCommand(command: string, dialect: ShellDialect): string {
  switch (dialect) {
    case 'powershell':
      return [
        command,
        `$__aissh_ok = $?`,
        `$__aissh_ec = if ($__aissh_ok) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }`,
        `Write-Output ("${EXEC_CWD_MARKER}" + (Get-Location).Path)`,
        `exit $__aissh_ec`
      ].join('\n')
    case 'cmd':
      return [
        command,
        `set __aissh_ec=%ERRORLEVEL%`,
        `echo ${EXEC_CWD_MARKER}%CD%`,
        `exit /b %__aissh_ec%`
      ].join('\r\n')
    case 'posix':
      return `${command}\n__aissh_ec=$?; printf '\\n${EXEC_CWD_MARKER}%s\\n' "$(pwd 2>/dev/null)"; exit $__aissh_ec`
  }
}

/** Argv that hands `command` to `shellPath` as a single non-interactive run. */
export function execShellArgs(dialect: ShellDialect, command: string): string[] {
  switch (dialect) {
    case 'powershell':
      // -NoProfile keeps a user's prompt customisations out of captured stdout.
      return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    case 'cmd':
      // /d skips AutoRun registry commands, which would print into stdout.
      return ['/d', '/s', '/c', command]
    case 'posix':
      return ['-c', command]
  }
}

/** Argv for launching `shellPath` as the user's interactive terminal. */
export function interactiveShellArgs(dialect: ShellDialect): string[] {
  return dialect === 'powershell' ? ['-NoLogo'] : []
}

/** Pull the trailing cwd sentinel out of captured stdout. */
export function splitCwdMarker(stdout: string): { text: string; cwd?: string } {
  const idx = stdout.lastIndexOf(EXEC_CWD_MARKER)
  if (idx === -1) return { text: stdout }
  const after = stdout.slice(idx + EXEC_CWD_MARKER.length)
  const cwd = after.split('\n')[0]?.trim()
  return {
    text: stdout.slice(0, idx).replace(/\n$/, ''),
    cwd: cwd || undefined
  }
}

/**
 * Quote a value so a shell of this dialect sees it as one literal argument.
 *
 * POSIX single-quoting has no escape inside the quotes, so a quote is closed,
 * escaped, and reopened. PowerShell single-quoting doubles the quote. `cmd` has
 * no quoting that survives its own parser reliably, so it gets double quotes
 * with the interior ones stripped — enough for paths and patterns, which is all
 * the callers pass.
 */
export function quoteForShell(value: string, dialect: ShellDialect): string {
  switch (dialect) {
    case 'powershell':
      return `'${value.replace(/'/g, "''")}'`
    case 'cmd':
      return `"${value.replace(/"/g, '')}"`
    case 'posix':
      return `'${value.replace(/'/g, `'\\''`)}'`
  }
}
