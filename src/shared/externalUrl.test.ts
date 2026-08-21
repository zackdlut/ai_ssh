import { describe, expect, it } from 'vitest'
import { sanitizeExternalUrl, splitByExternalUrls } from './externalUrl'

describe('sanitizeExternalUrl', () => {
  it('allows http(s) URLs', () => {
    expect(sanitizeExternalUrl('https://example.com/path')).toBe('https://example.com/path')
    expect(sanitizeExternalUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/')
  })

  it('allows mailto, ftp, and tel', () => {
    expect(sanitizeExternalUrl('mailto:zack@example.com')).toBe('mailto:zack@example.com')
    expect(sanitizeExternalUrl('ftp://files.example.com/a')).toBe('ftp://files.example.com/a')
    expect(sanitizeExternalUrl('tel:+15551212')).toBe('tel:+15551212')
  })

  it('trims surrounding whitespace', () => {
    expect(sanitizeExternalUrl('  https://example.com  ')).toBe('https://example.com/')
  })

  it('rejects empty, relative, and non-absolute values', () => {
    expect(sanitizeExternalUrl('')).toBeNull()
    expect(sanitizeExternalUrl('example.com')).toBeNull()
    expect(sanitizeExternalUrl('/local/path')).toBeNull()
    expect(sanitizeExternalUrl('www.example.com')).toBeNull()
  })

  it('rejects dangerous or unexpected schemes', () => {
    expect(sanitizeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeExternalUrl('file:///etc/passwd')).toBeNull()
    expect(sanitizeExternalUrl('data:text/html,hi')).toBeNull()
    expect(sanitizeExternalUrl('smb://host/share')).toBeNull()
    expect(sanitizeExternalUrl('vscode://file/tmp')).toBeNull()
  })
})

describe('splitByExternalUrls', () => {
  it('returns the original text when there is no URL', () => {
    expect(splitByExternalUrls('no links here')).toEqual([{ text: 'no links here' }])
  })

  it('extracts a URL in the middle of a line', () => {
    expect(splitByExternalUrls('see https://example.com/docs for more')).toEqual([
      { text: 'see ' },
      { text: 'https://example.com/docs', href: 'https://example.com/docs' },
      { text: ' for more' }
    ])
  })

  it('strips trailing punctuation from a captured URL', () => {
    expect(splitByExternalUrls('Visit https://example.com.')).toEqual([
      { text: 'Visit ' },
      { text: 'https://example.com', href: 'https://example.com/' },
      { text: '.' }
    ])
  })

  it('splits multiple URLs', () => {
    const parts = splitByExternalUrls('a http://a.test b https://b.test/x c')
    expect(parts.map((p) => p.href)).toEqual([undefined, 'http://a.test/', undefined, 'https://b.test/x', undefined])
  })
})
