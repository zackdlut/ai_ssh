import { describe, expect, it } from 'vitest'
import {
  completionTokensPerSecond,
  estimatedCompletionTokens,
  streamingTokensPerSecond
} from './turnTokenStats'

describe('estimatedCompletionTokens', () => {
  it('counts content and reasoning together', () => {
    const text = 'hello world'
    const withReasoning = estimatedCompletionTokens(text, 'thinking')
    expect(withReasoning).toBeGreaterThan(estimatedCompletionTokens(text))
  })
})

describe('completionTokensPerSecond', () => {
  it('computes rate from provider usage', () => {
    expect(
      completionTokensPerSecond({ prompt: 1000, completion: 120, total: 1120 }, 2000)
    ).toBe(60)
  })

  it('returns undefined when inputs are missing', () => {
    expect(completionTokensPerSecond(undefined, 2000)).toBeUndefined()
    expect(
      completionTokensPerSecond({ prompt: 1, completion: 0, total: 1 }, 2000)
    ).toBeUndefined()
  })
})

describe('streamingTokensPerSecond', () => {
  it('computes live rate from elapsed time', () => {
    const started = 1_000
    const rate = streamingTokensPerSecond('abcd', undefined, started, started + 1000)
    expect(rate).toBeGreaterThan(0)
  })

  it('returns undefined before streaming starts', () => {
    expect(streamingTokensPerSecond('hello', undefined, undefined)).toBeUndefined()
  })
})
