/**
 * Composer slash commands. Parsed locally; they never go to the LLM.
 */
export const SLASH_NAMES = ['plan', 'agent', 'execute', 'compact', 'skill'] as const

export type SlashName = (typeof SLASH_NAMES)[number]

export interface SlashCommandMeta {
  name: SlashName
  hintKey:
    | 'copilot.slash.plan'
    | 'copilot.slash.agent'
    | 'copilot.slash.execute'
    | 'copilot.slash.compact'
    | 'copilot.slash.skill'
}

export const SLASH_COMMANDS: readonly SlashCommandMeta[] = [
  { name: 'plan', hintKey: 'copilot.slash.plan' },
  { name: 'agent', hintKey: 'copilot.slash.agent' },
  { name: 'execute', hintKey: 'copilot.slash.execute' },
  { name: 'compact', hintKey: 'copilot.slash.compact' },
  { name: 'skill', hintKey: 'copilot.slash.skill' }
]

export type ParsedSlash =
  | { kind: 'command'; name: SlashName; arg: string }
  | { kind: 'unknown'; token: string }

function isSlashName(value: string): value is SlashName {
  return (SLASH_NAMES as readonly string[]).includes(value)
}

/**
 * Whole-input slash parse. `null` when the text is not a slash command (plain
 * prompt, or a lone `/` still being typed).
 */
export function parseSlashCommand(text: string): ParsedSlash | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  if (trimmed.includes('\n')) return null
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match) return null
  const token = match[1].toLowerCase()
  const arg = (match[2] ?? '').trim()
  if (!isSlashName(token)) return { kind: 'unknown', token: match[1] }
  return { kind: 'command', name: token, arg }
}

/**
 * Filter the `/` menu. Hidden once the user has typed arguments (`/skill x`)
 * or left the first line.
 */
export function slashMenuPrefix(text: string): string | null {
  if (!text.startsWith('/')) return null
  if (text.includes('\n')) return null
  if (/\s/.test(text.slice(1))) return null
  return text.slice(1).toLowerCase()
}

export function filterSlashCommands(prefix: string): SlashCommandMeta[] {
  if (!prefix) return [...SLASH_COMMANDS]
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix))
}
