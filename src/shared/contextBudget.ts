export const COMPRESS_THRESHOLD = 0.8
export const TARGET_RATIO_AFTER_COMPRESS = 0.5
/** Keep at least this many recent messages (4 user+assistant turns). */
export const MIN_KEEP_MESSAGES = 8
const MIN_COMPRESS_TOKENS = 100

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g

export interface BudgetMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ContextBreakdown {
  system: number
  context: number
  history: number
  draft: number
  total: number
}

export interface ChatPayloadBudget {
  breakdown: ContextBreakdown
  limit: number
  usageRatio: number
}

/** Heuristic token estimate: CJK ~1.5 chars/token, Latin ~4 chars/token. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjkMatches = text.match(CJK_RE)
  const cjkChars = cjkMatches?.length ?? 0
  const otherChars = text.length - cjkChars
  return Math.ceil(cjkChars / 1.5 + otherChars / 4)
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function buildChatPayload(params: {
  systemPrompt: string
  contextMessage: string | null
  messages: BudgetMessage[]
  draft?: string
  limit: number
}): ChatPayloadBudget {
  const system = estimateTokens(params.systemPrompt)
  const context = estimateTokens(params.contextMessage ?? '')
  const history = params.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  const draft = estimateTokens(params.draft ?? '')
  const total = system + context + history + draft
  const limit = params.limit > 0 ? params.limit : 1
  return {
    breakdown: { system, context, history, draft, total },
    limit,
    usageRatio: total / limit
  }
}

function historyTokens(messages: BudgetMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}

/**
 * Pick the oldest messages to summarize when usage is at or above COMPRESS_THRESHOLD.
 * Always keeps at least MIN_KEEP_MESSAGES recent messages.
 */
export function selectMessagesToCompress(
  messages: BudgetMessage[],
  params: {
    systemPrompt: string
    contextMessage: string | null
    draft?: string
    limit: number
  }
): { toCompress: BudgetMessage[]; toKeep: BudgetMessage[] } {
  const budget = buildChatPayload({ ...params, messages })
  if (budget.usageRatio < COMPRESS_THRESHOLD || messages.length <= MIN_KEEP_MESSAGES) {
    return { toCompress: [], toKeep: messages }
  }

  const fixedOverhead =
    budget.breakdown.system + budget.breakdown.context + budget.breakdown.draft
  const maxCompress = messages.length - MIN_KEEP_MESSAGES
  let compressCount = 0

  for (let n = 1; n <= maxCompress; n++) {
    const toKeep = messages.slice(n)
    const ratio = (fixedOverhead + historyTokens(toKeep)) / budget.limit
    if (ratio <= TARGET_RATIO_AFTER_COMPRESS) {
      compressCount = n
      break
    }
  }

  if (compressCount === 0) {
    compressCount = maxCompress
  }

  if (compressCount < 1) {
    return { toCompress: [], toKeep: messages }
  }

  const toCompress = messages.slice(0, compressCount)
  const compressTokens = historyTokens(toCompress)
  if (compressTokens < MIN_COMPRESS_TOKENS && toCompress.length < 2) {
    return { toCompress: [], toKeep: messages }
  }

  return {
    toCompress,
    toKeep: messages.slice(compressCount)
  }
}
