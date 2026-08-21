import { buildCopilotSystemPrompt, type PromptSections } from './copilot'

/** Wrap trimmed user rules for injection as a system message. */
export function buildUserRulesSystemMessage(rules: string): string | undefined {
  const trimmed = rules.trim()
  if (!trimmed) return undefined
  return `User rules (follow these instructions when they apply; they take precedence over default behavior where they conflict):

${trimmed}`
}

/**
 * Copilot system prompt plus optional user rules, as one string, for token
 * accounting. Callers pass the same `sections` the real turn will use — the
 * default (everything on, full tool set) overstates a trimmed tier by thousands
 * of tokens, which is enough to move the compression threshold.
 */
export function buildEffectiveSystemPrompt(
  userRules = '',
  sections: PromptSections = { chart: true, mermaid: true }
): string {
  const prompt = buildCopilotSystemPrompt(sections)
  const rulesMessage = buildUserRulesSystemMessage(userRules)
  if (!rulesMessage) return prompt
  return `${prompt}\n\n${rulesMessage}`
}
