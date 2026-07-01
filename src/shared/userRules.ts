import { COPILOT_SYSTEM_PROMPT } from './copilotPrompts'

/** Wrap trimmed user rules for injection as a system message. */
export function buildUserRulesSystemMessage(rules: string): string | undefined {
  const trimmed = rules.trim()
  if (!trimmed) return undefined
  return `User rules (follow these instructions when they apply; they take precedence over default behavior where they conflict):

${trimmed}`
}

/** Base copilot system prompt plus optional user rules (for token budget). */
export function buildEffectiveSystemPrompt(userRules = ''): string {
  const rulesMessage = buildUserRulesSystemMessage(userRules)
  if (!rulesMessage) return COPILOT_SYSTEM_PROMPT
  return `${COPILOT_SYSTEM_PROMPT}\n\n${rulesMessage}`
}
