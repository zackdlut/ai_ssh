import type { TerminalContext } from './types'

export function buildContextMessage(context?: TerminalContext): string | null {
  if (!context) return null
  const parts: string[] = []
  if (context.host) parts.push(`Host: ${context.host}`)
  if (context.username) parts.push(`User: ${context.username}`)
  if (context.osHint) parts.push(`OS hint: ${context.osHint}`)
  if (context.recentOutput?.trim()) {
    parts.push(`Recent terminal output:\n\`\`\`\n${context.recentOutput.trim()}\n\`\`\``)
  }
  if (parts.length === 0) return null
  return `Current terminal context (for reference):\n${parts.join('\n')}`
}
