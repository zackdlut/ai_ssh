import { describe, expect, it } from 'vitest'
import { applyUniqueEdit, countOccurrences } from './textEdit'

const CONFIG = ['server {', '  listen 80;', '  root /var/www;', '}', '', 'server {', '  listen 443;', '}'].join('\n')

describe('countOccurrences', () => {
  it('counts non-overlapping matches', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
    expect(countOccurrences(CONFIG, 'server {')).toBe(2)
    expect(countOccurrences(CONFIG, 'nothing')).toBe(0)
  })
})

describe('applyUniqueEdit', () => {
  it('applies an unambiguous edit', () => {
    const res = applyUniqueEdit(CONFIG, '  listen 80;', '  listen 8080;')
    expect(res).toMatchObject({ ok: true, replacements: 1 })
    if (res.ok) {
      expect(res.text).toContain('listen 8080;')
      expect(res.text).toContain('listen 443;')
    }
  })

  it('refuses an ambiguous match and reports the count', () => {
    // This is the case a `sed -i` would have silently applied to both blocks.
    expect(applyUniqueEdit(CONFIG, 'server {', 'server { # edited')).toEqual({
      ok: false,
      reason: 'ambiguous',
      occurrences: 2
    })
  })

  it('replaces every occurrence when explicitly asked', () => {
    const res = applyUniqueEdit(CONFIG, 'server {', 'http {', true)
    expect(res).toMatchObject({ ok: true, replacements: 2 })
    if (res.ok) expect(countOccurrences(res.text, 'http {')).toBe(2)
  })

  it('reports a missing match instead of writing anything', () => {
    expect(applyUniqueEdit(CONFIG, 'listen 8080;', 'listen 80;')).toMatchObject({
      ok: false,
      reason: 'not_found'
    })
  })

  it('rejects an empty or no-op edit', () => {
    expect(applyUniqueEdit(CONFIG, '', 'x')).toMatchObject({ ok: false, reason: 'empty_old' })
    expect(applyUniqueEdit(CONFIG, '}', '}')).toMatchObject({ ok: false, reason: 'identical' })
  })

  it('treats both strings as literal text, not patterns', () => {
    const text = 'value = $1 + ${x} (a|b)'
    const res = applyUniqueEdit(text, '(a|b)', '$& [c]')
    expect(res).toMatchObject({ ok: true })
    if (res.ok) expect(res.text).toBe('value = $1 + ${x} $& [c]')
  })

  it('preserves indentation and line breaks in multi-line matches', () => {
    const res = applyUniqueEdit(CONFIG, '  listen 443;\n}', '  listen 443 ssl;\n}')
    expect(res).toMatchObject({ ok: true })
    if (res.ok) expect(res.text.endsWith('  listen 443 ssl;\n}')).toBe(true)
  })
})
