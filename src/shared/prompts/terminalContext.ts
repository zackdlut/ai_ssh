import type { TerminalContext } from '../types'

/**
 * Describe what kind of shell a tab is, for the context message's OS hint.
 *
 * The SSH/WSL distinction is load-bearing rather than cosmetic: WSL tabs have
 * no SFTP channel, so the file tools cannot run there and the model has to fall
 * back to exec_command. Saying so up front saves a failed tool call.
 */
export function describeTabOs(kind: 'ssh' | 'wsl' | undefined, wslDistro?: string): string {
  if (kind !== 'wsl') return 'remote Linux/Unix over SSH'
  const distro = wslDistro ? ` (${wslDistro})` : ''
  return `local WSL${distro} — no SFTP channel, so the file tools do not work on this tab; use exec_command`
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
