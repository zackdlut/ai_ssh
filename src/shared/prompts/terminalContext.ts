import type { TerminalContext } from '../types'

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
