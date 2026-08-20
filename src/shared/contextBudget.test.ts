import { describe, expect, it } from 'vitest'
import {
  buildChatPayload,
  estimateTokens,
  MIN_KEEP_MESSAGES,
  selectMessagesToCompress,
  TARGET_RATIO_AFTER_COMPRESS,
  type BudgetMessage
} from './contextBudget'

function messages(count: number, content: string): BudgetMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${content} #${i}`
  }))
}

describe('estimateTokens', () => {
  it('is zero for empty text', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('charges CJK more per character than Latin', () => {
    // 1.5 chars/token vs ~4.3 chars/token: the same character count costs more
    // in Chinese, which is why a shared ratio understated real usage.
    expect(estimateTokens('中文中文')).toBeGreaterThan(estimateTokens('abcd'))
  })

  it('charges machine output more per character than prose', () => {
    const prose = 'the service restarted cleanly and the port is listening again '.repeat(40)
    const log = '2026-08-20T07:12:33+0800 DEBUG repo=rhel-9,pkg=glibc-2.34-1.el9.x86_64 '.repeat(40)
    expect(log.length).toBeCloseTo(prose.length, -3)
    expect(estimateTokens(log)).toBeGreaterThan(estimateTokens(prose))
  })

  /**
   * The invariant that matters: the estimate may be generous, never short. A
   * short estimate means the payload silently exceeds the window and the server
   * truncates the prompt. These reference points were measured against the
   * model endpoint's own reported prompt_tokens.
   */
  it('does not underestimate measured token counts', () => {
    const log = Array.from(
      { length: 125 },
      (_, i) =>
        `2026-08-20T07:12:${String(i % 60).padStart(2, '0')}+0800 DEBUG repo: downloading from remote: rhel-9-baseos-rpms, pkg=glibc-2.34-${i}.el9.x86_64, path=/var/cache/dnf/rhel-9-baseos-rpms-${i}/packages`
    ).join('\n')
    // 20k characters of this shape measured 9,978 real tokens.
    expect(estimateTokens(log.slice(0, 20000))).toBeGreaterThanOrEqual(9978)

    // 20k characters of English prose measured 3,733 real tokens.
    const prose = 'lorem ipsum dolor sit amet '.repeat(800).slice(0, 20000)
    expect(estimateTokens(prose)).toBeGreaterThanOrEqual(3733)
  })

  it('handles text that is entirely CJK', () => {
    expect(estimateTokens('中文')).toBe(2)
  })
})

describe('buildChatPayload', () => {
  it('splits usage into its parts and sums them', () => {
    const budget = buildChatPayload({
      systemPrompt: 'system prompt text',
      contextMessage: 'context text',
      messages: messages(2, 'hello'),
      draft: 'draft text',
      limit: 1000
    })
    const { system, context, history, draft, total } = budget.breakdown
    expect(total).toBe(system + context + history + draft)
    expect(budget.usageRatio).toBeCloseTo(total / 1000)
  })

  it('never divides by a zero limit', () => {
    const budget = buildChatPayload({
      systemPrompt: 'x',
      contextMessage: null,
      messages: [],
      limit: 0
    })
    expect(Number.isFinite(budget.usageRatio)).toBe(true)
  })
})

describe('selectMessagesToCompress', () => {
  const params = { systemPrompt: 'sys', contextMessage: null, draft: '', limit: 2000 }

  it('compresses nothing while usage is below the threshold', () => {
    const msgs = messages(20, 'short')
    expect(selectMessagesToCompress(msgs, params).toCompress).toHaveLength(0)
  })

  it('keeps the recent tail even when far over budget', () => {
    const msgs = messages(30, 'x'.repeat(600))
    const { toCompress, toKeep } = selectMessagesToCompress(msgs, params)
    expect(toCompress.length).toBeGreaterThan(0)
    expect(toKeep.length).toBeGreaterThanOrEqual(MIN_KEEP_MESSAGES)
    expect([...toCompress, ...toKeep]).toEqual(msgs)
  })

  it('compresses down to the target ratio when it can', () => {
    const msgs = messages(30, 'y'.repeat(400))
    const { toKeep } = selectMessagesToCompress(msgs, params)
    const after = buildChatPayload({ ...params, messages: toKeep })
    expect(after.usageRatio).toBeLessThanOrEqual(TARGET_RATIO_AFTER_COMPRESS)
  })

  it('refuses to compress a conversation that is already short', () => {
    const msgs = messages(MIN_KEEP_MESSAGES, 'z'.repeat(4000))
    expect(selectMessagesToCompress(msgs, params).toCompress).toHaveLength(0)
  })
})
