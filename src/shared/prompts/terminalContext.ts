import type { TerminalContext } from '../types'
import type { TabKind } from '../tabCapabilities'
import { deviceKindLabel, type DeviceKind } from '../deviceIdentity'
import { shellDialect } from '../shellDialect'

/**
 * Describe what kind of shell a tab is, for the context message's OS hint.
 *
 * The distinction is load-bearing rather than cosmetic, and it is what the
 * transport can DO that matters. WSL tabs have no SFTP channel, so the file
 * tools cannot run there and the model has to fall back to exec_command. A
 * serial tab is narrower still: it has no shell at all, so most of the tool
 * surface is inapplicable and the two that replace it have to be named. Saying
 * so up front saves a failed tool call — and on serial, saves a whole turn
 * spent concluding that a device is broken when it was only unaddressable.
 */
export function describeTabOs(
  kind: TabKind,
  wslDistro?: string,
  serial?: { path?: string; baudRate?: number; board?: string },
  local?: { shell?: string }
): string {
  if (kind === 'wsl') {
    const distro = wslDistro ? ` (${wslDistro})` : ''
    return `local WSL${distro} — no SFTP channel, so the file tools do not work on this tab; use exec_command`
  }
  // Without this the fallthrough would call a local Windows shell a remote
  // Linux host, and the model would answer `systemctl` and `apt` to everything.
  if (kind === 'local') {
    const dialect = shellDialect(local?.shell)
    const name = local?.shell ? ` (${local.shell})` : ''
    if (dialect === 'powershell') {
      return `a PowerShell session on the user's own Windows machine${name} — use PowerShell cmdlets, not POSIX tools: no systemctl, apt, or /etc. Paths use backslashes. The file tools DO work here.`
    }
    if (dialect === 'cmd') {
      return `a Windows Command Prompt on the user's own machine${name} — cmd.exe builtins only, not POSIX tools. Paths use backslashes. The file tools DO work here.`
    }
    return `a ${process.platform === 'darwin' ? 'macOS' : 'Unix'} shell on the user's own machine${name} — this is their workstation, not a server, so be conservative with anything destructive. The file tools DO work here.`
  }
  if (kind === 'serial') {
    const where = serial?.path ? ` on ${serial.path}` : ''
    const baud = serial?.baudRate ? ` at ${serial.baudRate} baud` : ''
    const board = serial?.board ? ` (${serial.board})` : ''
    return `serial console${where}${baud}${board} — a byte stream with NO shell. There is no working directory and no exit code, and exec_command, run_in_terminal, the file tools, grep, glob, and git do NOT work on this tab. Read what the device printed with search_terminal, write to it with serial_send, and reboot it with serial_reset to capture a fresh boot log.`
  }
  return 'remote Linux/Unix over SSH'
}

/**
 * `describeTabOs` for a live session object.
 *
 * Every caller holds a whole session and had to unpack the same three fields to
 * ask this question; a serial tab would have made that four. Taking the session
 * keeps the unpacking in one place, so a transport that needs a fifth field
 * does not have to be threaded through the call sites again.
 */
export function describeSessionOs(tab: {
  kind?: TabKind
  wslDistro?: string
  deviceKind?: DeviceKind
  serialOpts?: { path?: string; baudRate?: number }
  localShell?: string
}): string {
  return describeTabOs(
    tab.kind,
    tab.wslDistro,
    {
      path: tab.serialOpts?.path,
      baudRate: tab.serialOpts?.baudRate,
      board: tab.deviceKind ? deviceKindLabel(tab.deviceKind) : undefined
    },
    { shell: tab.localShell }
  )
}

/**
 * Build the per-turn "current terminal context" system message from the
 * connected host / user / cwd / OS hint and a snippet of recent output.
 * Returns null when there is nothing worth injecting.
 */
export function buildContextMessage(context?: TerminalContext): string | null {
  if (!context) return null
  const parts: string[] = []
  if (context.host) parts.push(`Host: ${context.host}`)
  if (context.username) parts.push(`User: ${context.username}`)
  if (context.cwd) parts.push(`Working directory: ${context.cwd}`)
  if (context.osHint) parts.push(`OS hint: ${context.osHint}`)
  if (context.recentOutput?.trim()) {
    parts.push(`Recent terminal output:\n\`\`\`\n${context.recentOutput.trim()}\n\`\`\``)
  }
  if (parts.length === 0) return null
  return `Current terminal context (for reference):\n${parts.join('\n')}`
}
