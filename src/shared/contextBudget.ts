export const COMPRESS_THRESHOLD = 0.8
export const TARGET_RATIO_AFTER_COMPRESS = 0.5
/** Keep at least this many recent messages (4 user+assistant turns). */
export const MIN_KEEP_MESSAGES = 8
const MIN_COMPRESS_TOKENS = 100

/**
 * Characters per token for prose, and for machine output (logs, JSON, paths,
 * code). Measured against this project's own model endpoint: English prose runs
 * ~5.4 chars/token, dnf log lines ~2.0, tool schemas ~3.8. A single ratio
 * cannot span that, and picking the prose end is what let a log-heavy turn sail
 * past the context window — the estimate said 5k tokens where the tokenizer
 * charged 10k, so nothing compacted and the server truncated the prompt from
 * the front, taking the user's question with it.
 */
const PROSE_CHARS_PER_TOKEN = 4.3
const DENSE_CHARS_PER_TOKEN = 2
/**
 * Share of visible characters that are digits, punctuation or symbols at which
 * text is treated as fully machine output. Those are the characters a BPE
 * tokenizer splits on, so their density is what separates a paragraph from a
 * log line.
 */
const FULLY_DENSE_SHARE = 0.35

function isCJK(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  )
}

/** Single pass over the text: CJK count, dense-character count, visible count. */
function classify(text: string): { cjk: number; dense: number; visible: number } {
  let cjk = 0
  let dense = 0
  let visible = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 32 || code === 9 || code === 10 || code === 13) continue
    visible++
    if (isCJK(code)) {
      cjk++
      continue
    }
    const isLetter = (code >= 97 && code <= 122) || (code >= 65 && code <= 90)
    if (!isLetter) dense++
  }
  return { cjk, dense, visible }
}

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

/**
 * Heuristic token estimate. CJK is charged at ~1.5 chars/token; everything else
 * is charged on a ratio interpolated from how dense the text is, so a log or a
 * JSON blob costs roughly what the tokenizer will actually charge for it.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const { cjk, dense, visible } = classify(text)
  const other = text.length - cjk
  if (other <= 0) return Math.ceil(cjk / 1.5)

  const share = visible > 0 ? dense / visible : 0
  const weight = Math.min(1, share / FULLY_DENSE_SHARE)
  const ratio = PROSE_CHARS_PER_TOKEN + (DENSE_CHARS_PER_TOKEN - PROSE_CHARS_PER_TOKEN) * weight
  return Math.ceil(cjk / 1.5 + other / ratio)
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
