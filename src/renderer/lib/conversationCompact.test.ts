import { describe, expect, it } from 'vitest'
import { compactConversation } from './conversationCompact'
import { estimateTokens } from '../../shared/contextBudget'
import type { ChatMessageDTO } from '../../shared/types'

function totalTokens(messages: ChatMessageDTO[]): number {
  let sum = 0
  for (const m of messages) {
    sum += estimateTokens(m.content)
    for (const call of m.tool_calls ?? []) sum += estimateTokens(call.arguments)
  }
  return sum
}

/** One agent step: an assistant turn that called a tool, plus its reply. */
function step(index: number, resultChars: number = 4000): ChatMessageDTO[] {
  const id = `call_${index}`
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, name: 'exec_command', arguments: `{"command":"cmd ${index}"}` }]
    },
    { role: 'tool', tool_call_id: id, content: 'x'.repeat(resultChars) }
  ]
}

function conversation(steps: number, resultChars?: number): ChatMessageDTO[] {
  const messages: ChatMessageDTO[] = [{ role: 'user', content: 'restart nginx and confirm it came back up' }]
  for (let i = 0; i < steps; i++) messages.push(...step(i, resultChars))
  return messages
}

/**
 * The OpenAI protocol rejects a request where an announced tool_call_id has no
 * matching `role:'tool'` reply, so this is the invariant compaction must never
 * break — an unpaired call fails the whole turn, not just that step.
 */
function assertPaired(messages: ChatMessageDTO[]): void {
  const announced = new Set<string>()
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) announced.add(call.id)
  }
  const answered = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'tool') continue
    expect(m.tool_call_id).toBeTruthy()
    expect(announced.has(m.tool_call_id as string)).toBe(true)
    answered.add(m.tool_call_id as string)
  }
  expect([...announced].sort()).toEqual([...answered].sort())
}

describe('compactConversation', () => {
  it('leaves a conversation that already fits untouched', () => {
    const messages = conversation(2)
    const res = compactConversation(messages, 1_000_000)
    expect(res.messages).toBe(messages)
    expect(res).toMatchObject({ trimmed: 0, dropped: 0 })
  })

  it('shrinks old tool results instead of removing steps when that is enough', () => {
    const messages = conversation(12)
    const res = compactConversation(messages, 6000)
    expect(res.trimmed).toBeGreaterThan(0)
    expect(res.dropped).toBe(0)
    expect(res.messages).toHaveLength(messages.length)
    assertPaired(res.messages)
    // A trimmed reply keeps its id and its call, so the model still sees what
    // it ran and in what order — only the bulky output is gone.
    const trimmedReply = res.messages.find((m) => m.content.startsWith('[trimmed to save context]'))
    expect(trimmedReply?.tool_call_id).toBeTruthy()
  })

  it('does not mutate the caller-owned messages', () => {
    const messages = conversation(12)
    const before = messages.map((m) => m.content)
    compactConversation(messages, 6000)
    expect(messages.map((m) => m.content)).toEqual(before)
  })

  it('keeps tool calls paired even when whole steps have to go', () => {
    const res = compactConversation(conversation(20), 400)
    expect(res.dropped).toBeGreaterThan(0)
    assertPaired(res.messages)
  })

  it('always keeps the original instruction and says what was dropped', () => {
    const res = compactConversation(conversation(20), 400)
    expect(res.messages[0]).toMatchObject({ role: 'user' })
    expect(res.messages[0].content).toContain('restart nginx')
    expect(res.messages[1].content).toMatch(/dropped from this conversation/)
  })

  it('protects the most recent steps from being dropped', () => {
    const messages = conversation(20)
    const res = compactConversation(messages, 400)
    const lastCallId = messages[messages.length - 1].tool_call_id
    expect(res.messages.some((m) => m.tool_call_id === lastCallId)).toBe(true)
  })

  // Regression: a single 118k-character read_file reply on the first step used
  // to pass through every pass untouched — the recent window protected it and
  // there was no older turn to drop — so the request went out over-window and
  // the server truncated the user's question off the front.
  it('condenses one oversized recent result down into the budget', () => {
    const messages = conversation(1, 118_593)
    const res = compactConversation(messages, 4096)
    expect(res.condensed).toBeGreaterThan(0)
    expect(totalTokens(res.messages)).toBeLessThanOrEqual(4096)
    assertPaired(res.messages)
    expect(res.messages[0].content).toContain('restart nginx')
  })

  it('keeps the head and the tail of a condensed result', () => {
    const messages: ChatMessageDTO[] = [
      { role: 'user', content: 'read the log' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_0', name: 'read_file', arguments: '{}' }]
      },
      { role: 'tool', tool_call_id: 'call_0', content: `HEAD${'x'.repeat(90_000)}VERDICT` }
    ]
    const res = compactConversation(messages, 4096)
    const reply = res.messages.find((m) => m.role === 'tool')
    expect(reply?.content.startsWith('HEAD')).toBe(true)
    expect(reply?.content.endsWith('VERDICT')).toBe(true)
  })

  it('stops shrinking at the floor rather than looping forever', () => {
    const res = compactConversation(conversation(1, 118_593), 1)
    expect(totalTokens(res.messages)).toBeGreaterThan(0)
    assertPaired(res.messages)
  })
})
