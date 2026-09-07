import { estimateTokens } from '../../shared/contextBudget'
import type { AITokenUsage } from '../../shared/types'

/** Estimate completion tokens from streamed assistant text. */
export function estimatedCompletionTokens(content: string, reasoning?: string): number {
  return estimateTokens([content, reasoning].filter(Boolean).join('\n'))
}

/** Tokens per second from provider usage, or undefined when not computable. */
export function completionTokensPerSecond(
  usage: AITokenUsage | undefined,
  generationMs: number | undefined
): number | undefined {
  if (!usage || usage.completion <= 0 || !generationMs || generationMs <= 0) return undefined
  return usage.completion / (generationMs / 1000)
}

/** Live streaming rate from estimated output tokens and elapsed wall time. */
export function streamingTokensPerSecond(
  content: string,
  reasoning?: string,
  streamStartedAt?: number,
  now = Date.now()
): number | undefined {
  if (!streamStartedAt) return undefined
  const elapsedMs = now - streamStartedAt
  if (elapsedMs <= 0) return undefined
  const tokens = estimatedCompletionTokens(content, reasoning)
  if (tokens <= 0) return undefined
  return tokens / (elapsedMs / 1000)
}
