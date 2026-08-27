import { describe, expect, it } from 'vitest'
import { applyUnifiedPatch, hunkToExactEdit, parseUnifiedPatch } from './unifiedPatch'

const NGINX = [
  'server {',
  '    listen 80;',
  '    server_name example.com;',
  '',
  '    location / {',
  '        proxy_pass http://127.0.0.1:3000;',
  '    }',
  '}',
  ''
].join('\n')

describe('parseUnifiedPatch', () => {
  it('parses hunks and the target path from git headers', () => {
    const res = parseUnifiedPatch(
      [
        'diff --git a/etc/nginx/nginx.conf b/etc/nginx/nginx.conf',
        'index 1234567..89abcde 100644',
        '--- a/etc/nginx/nginx.conf',
        '+++ b/etc/nginx/nginx.conf',
        '@@ -2,2 +2,2 @@ server {',
        '-    listen 80;',
        '+    listen 8080;',
        '     server_name example.com;'
      ].join('\n')
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.patch.path).toBe('etc/nginx/nginx.conf')
    expect(res.patch.hunks).toHaveLength(1)
    expect(res.patch.hunks[0]).toMatchObject({ oldStart: 2, oldCount: 2, newStart: 2 })
    expect(res.patch.hunks[0].lines).toEqual([
      { op: 'remove', text: '    listen 80;' },
      { op: 'add', text: '    listen 8080;' },
      { op: 'context', text: '    server_name example.com;' }
    ])
  })

  it('ignores prose the model wrapped around the patch', () => {
    const res = parseUnifiedPatch(
      ['Here is the change:', '@@ -1,1 +1,1 @@', '-server {', '+http {', 'That should do it.'].join('\n')
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.patch.hunks[0].lines).toHaveLength(2)
  })

  it('treats a bare blank body line as empty context', () => {
    const res = parseUnifiedPatch(['@@ -3,3 +3,3 @@', ' a', '', '-b', '+c'].join('\n'))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.patch.hunks[0].lines[1]).toEqual({ op: 'context', text: '' })
  })

  it('rejects an empty patch, one with no hunks, and one that changes nothing', () => {
    expect(parseUnifiedPatch('   ')).toMatchObject({ ok: false, reason: 'empty' })
    expect(parseUnifiedPatch('just some prose')).toMatchObject({ ok: false, reason: 'no_hunks' })
    expect(parseUnifiedPatch('@@ -1,2 +1,2 @@\n a\n b')).toMatchObject({
      ok: false,
      reason: 'no_hunks'
    })
  })

  it('refuses a patch spanning two files', () => {
    const res = parseUnifiedPatch(
      [
        '--- a/one.conf',
        '+++ b/one.conf',
        '@@ -1,1 +1,1 @@',
        '-a',
        '+b',
        '--- a/two.conf',
        '+++ b/two.conf',
        '@@ -1,1 +1,1 @@',
        '-c',
        '+d'
      ].join('\n')
    )
    expect(res).toMatchObject({ ok: false, reason: 'multi_file' })
  })
})

describe('applyUnifiedPatch', () => {
  it('applies a single-hunk change', () => {
    const res = applyUnifiedPatch(
      NGINX,
      ['@@ -2,2 +2,2 @@', '-    listen 80;', '+    listen 8080;', '     server_name example.com;'].join('\n')
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toContain('    listen 8080;')
    expect(res.text).not.toContain('    listen 80;')
    expect(res.applied).toEqual([{ index: 1, atLine: 2, offset: 0, fuzzy: false }])
  })

  it('applies several hunks in one call without their edits shifting each other', () => {
    const res = applyUnifiedPatch(
      NGINX,
      [
        '@@ -1,3 +1,3 @@',
        ' server {',
        '-    listen 80;',
        '+    listen 8080;',
        '     server_name example.com;',
        '@@ -5,3 +5,3 @@',
        '     location / {',
        '-        proxy_pass http://127.0.0.1:3000;',
        '+        proxy_pass http://127.0.0.1:4000;',
        '     }'
      ].join('\n')
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toContain('listen 8080;')
    expect(res.text).toContain('proxy_pass http://127.0.0.1:4000;')
    expect(res.applied).toHaveLength(2)
  })

  it('locates a hunk whose line numbers drifted', () => {
    const shifted = `# added header\n# another\n${NGINX}`
    const res = applyUnifiedPatch(
      shifted,
      ['@@ -2,2 +2,2 @@', '-    listen 80;', '+    listen 8080;', '     server_name example.com;'].join('\n')
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.applied[0]).toMatchObject({ atLine: 4, offset: 2, fuzzy: false })
  })

  it('falls back to a whitespace-insensitive match and says so', () => {
    const trailing = NGINX.replace('    listen 80;', '    listen 80;   ')
    const res = applyUnifiedPatch(
      trailing,
      ['@@ -2,1 +2,1 @@', '-    listen 80;', '+    listen 8080;'].join('\n')
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.applied[0].fuzzy).toBe(true)
  })

  it('prefers an exact match further away over a fuzzy one nearby', () => {
    const text = ['alpha  ', 'beta', 'alpha', 'gamma'].join('\n')
    const res = applyUnifiedPatch(text, ['@@ -1,1 +1,1 @@', '-alpha', '+delta'].join('\n'))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.applied[0]).toMatchObject({ atLine: 3, fuzzy: false })
    expect(res.text).toBe(['alpha  ', 'beta', 'delta', 'gamma'].join('\n'))
  })

  it('inserts a pure-addition hunk after the anchor line', () => {
    const res = applyUnifiedPatch(NGINX, ['@@ -2,0 +3,1 @@', '+    listen 443 ssl;'].join('\n'))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text.split('\n')[2]).toBe('    listen 443 ssl;')
  })

  it('reports which hunk failed to match', () => {
    const res = applyUnifiedPatch(
      NGINX,
      [
        '@@ -2,1 +2,1 @@',
        '-    listen 80;',
        '+    listen 8080;',
        '@@ -20,1 +20,1 @@',
        '-    keepalive_timeout 65;',
        '+    keepalive_timeout 30;'
      ].join('\n')
    )
    expect(res).toMatchObject({ ok: false, reason: 'context_mismatch', hunkIndex: 2 })
    if (!res.ok) expect(res.detail).toContain('keepalive_timeout 65;')
  })

  it('rejects a second hunk that reaches back into an already-patched region', () => {
    const text = ['a', 'b', 'c'].join('\n')
    const res = applyUnifiedPatch(
      text,
      ['@@ -1,2 +1,2 @@', '-a', '+A', ' b', '@@ -1,1 +1,1 @@', '-a', '+z'].join('\n')
    )
    expect(res).toMatchObject({ ok: false, reason: 'overlap', hunkIndex: 2 })
  })

  it('reports a patch that applies but changes nothing as parse-clean and inert', () => {
    const res = applyUnifiedPatch('a\nb', ['@@ -1,1 +1,1 @@', '-a', '+a'].join('\n'))
    expect(res).toMatchObject({ ok: false, reason: 'no_change' })
  })

  it('preserves a trailing newline', () => {
    const res = applyUnifiedPatch(NGINX, ['@@ -2,1 +2,1 @@', '-    listen 80;', '+    listen 8080;'].join('\n'))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.text.endsWith('}\n')).toBe(true)
  })

  it('surfaces a parse failure rather than pretending nothing matched', () => {
    expect(applyUnifiedPatch(NGINX, 'not a patch')).toMatchObject({ ok: false, reason: 'parse' })
  })
})

describe('hunkToExactEdit', () => {
  it('renders a hunk as the old/new pair edit_file takes', () => {
    const parsed = parseUnifiedPatch(
      ['@@ -1,3 +1,3 @@', ' server {', '-    listen 80;', '+    listen 8080;', ' }'].join('\n')
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(hunkToExactEdit(parsed.patch.hunks[0])).toEqual({
      oldString: 'server {\n    listen 80;\n}',
      newString: 'server {\n    listen 8080;\n}'
    })
  })

  it('returns null for a hunk with nothing to anchor on', () => {
    const parsed = parseUnifiedPatch(['@@ -2,0 +3,1 @@', '+    listen 443 ssl;'].join('\n'))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(hunkToExactEdit(parsed.patch.hunks[0])).toBeNull()
  })
})
