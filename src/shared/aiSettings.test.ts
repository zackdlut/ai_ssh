import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeAISettings, resolveHttpProxy, shouldBypassProxy } from './aiSettings'

describe('shouldBypassProxy', () => {
  it('returns false when NO_PROXY is empty', () => {
    expect(shouldBypassProxy('http://10.67.34.44:11434/v1', '')).toBe(false)
  })

  it('matches an exact IP entry', () => {
    expect(shouldBypassProxy('http://10.67.34.44:11434/v1', 'localhost,10.67.34.44')).toBe(true)
  })

  it('matches an IPv4 CIDR block', () => {
    expect(shouldBypassProxy('http://10.67.34.44:11434/v1', '10.0.0.0/8')).toBe(true)
    expect(shouldBypassProxy('http://11.67.34.44:11434/v1', '10.0.0.0/8')).toBe(false)
    expect(shouldBypassProxy('http://192.168.1.9/v1', '192.168.0.0/16')).toBe(true)
  })

  it('matches domains and their subdomains', () => {
    expect(shouldBypassProxy('https://api.corp.example.com/v1', '.example.com')).toBe(true)
    expect(shouldBypassProxy('https://api.corp.example.com/v1', 'example.com')).toBe(true)
    expect(shouldBypassProxy('https://notexample.com/v1', 'example.com')).toBe(false)
  })

  it('honours a port-pinned entry', () => {
    expect(shouldBypassProxy('http://10.67.34.44:11434/v1', '10.67.34.44:11434')).toBe(true)
    expect(shouldBypassProxy('http://10.67.34.44:9000/v1', '10.67.34.44:11434')).toBe(false)
  })

  it('treats * as bypass everything', () => {
    expect(shouldBypassProxy('https://api.openai.com/v1', '*')).toBe(true)
  })

  it('ignores whitespace and case', () => {
    expect(shouldBypassProxy('http://LocalHost:11434/v1', ' localhost , 127.0.0.1 ')).toBe(true)
  })

  it('returns false for an unparseable URL', () => {
    expect(shouldBypassProxy('not a url', '*')).toBe(false)
  })
})

describe('resolveHttpProxy', () => {
  const saved = { ...process.env }
  const PROXY_VARS = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'NO_PROXY',
    'no_proxy'
  ]

  // The test runner itself may export proxy vars; start each case from a clean
  // slate so leftovers cannot decide the result.
  beforeEach(() => {
    for (const name of PROXY_VARS) delete process.env[name]
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  const settings = (httpProxy = '') => ({ ...normalizeAISettings({}), httpProxy })

  it('uses the configured proxy when set', () => {
    expect(resolveHttpProxy(settings('http://proxy:8080'), 'https://api.openai.com/v1')).toBe(
      'http://proxy:8080'
    )
  })

  it('falls back to the environment proxy', () => {
    process.env.HTTPS_PROXY = 'http://env-proxy:8080'
    expect(resolveHttpProxy(settings(), 'https://api.openai.com/v1')).toBe('http://env-proxy:8080')
  })

  it('bypasses the proxy for a NO_PROXY target', () => {
    process.env.HTTP_PROXY = 'http://env-proxy:8080'
    process.env.NO_PROXY = 'localhost,10.0.0.0/8,10.67.34.44'
    expect(resolveHttpProxy(settings(), 'http://10.67.34.44:11434/v1')).toBe('')
    expect(resolveHttpProxy(settings(), 'https://api.openai.com/v1')).toBe('http://env-proxy:8080')
  })

  it('lets NO_PROXY override an explicitly configured proxy', () => {
    process.env.NO_PROXY = '10.67.34.44'
    expect(resolveHttpProxy(settings('http://proxy:8080'), 'http://10.67.34.44:11434/v1')).toBe('')
  })

  it('keeps the proxy when no target is supplied', () => {
    process.env.NO_PROXY = '*'
    process.env.HTTP_PROXY = 'http://env-proxy:8080'
    expect(resolveHttpProxy(settings())).toBe('http://env-proxy:8080')
  })
})
