/**
 * Unified home for every prompt the app sends to the LLM.
 *
 * All system prompts, prompt-building functions and prompt-related intent
 * detection live under this module so the prompt surface is managed in one
 * place instead of being scattered across main/renderer/shared. Runtime context
 * builders that read live app state (the tool snapshot and skills catalog in the
 * renderer) stay next to their data — this module owns the prompt TEXT.
 *
 * Organized by concern:
 * - copilot:         the main chat copilot system prompt (core + chart/mermaid sections)
 * - subAgent:        the read-only prompt for a delegated per-host sub-agent
 * - userRules:       user-rules system message + effective (prompt + rules) assembly
 * - terminalContext: the per-turn terminal context system message
 * - chart:           chart-spec system prompt, chart-turn nudge, chart/mermaid intent regexes
 * - nlMode:          in-terminal natural-language translate + summarize prompts
 * - history:         conversation-history compression prompts
 */
export * from './copilot'
export * from './subAgent'
export * from './userRules'
export * from './terminalContext'
export * from './chart'
export * from './nlMode'
export * from './history'
