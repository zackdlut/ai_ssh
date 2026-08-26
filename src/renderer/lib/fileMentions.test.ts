import { describe, expect, it } from 'vitest'
import {
  expandMentionPath,
  extractFileMentionPaths,
  findFileMentionSpans,
  isFilePathMentionQuery,
  needsFileMentionPicker
} from './fileMentions'

describe('isFilePathMentionQuery', () => {
  it('only treats slash-shaped tails as paths', () => {
    expect(isFilePathMentionQuery('/etc/nginx.conf')).toBe(true)
    expect(isFilePathMentionQuery('./src/a.ts')).toBe(true)
    expect(isFilePathMentionQuery('~/nginx.conf')).toBe(true)
    expect(isFilePathMentionQuery('nginx')).toBe(false)
    expect(isFilePathMentionQuery('host.example')).toBe(false)
  })
})

describe('findFileMentionSpans', () => {
  it('highlights @/ ./ and ~/ and ignores @host', () => {
    const text = 'see @/etc/nginx.conf and @nginx then @./conf.d/a.conf and @~/app.env'
    const spans = findFileMentionSpans(text)
    expect(spans.map((s) => s.path)).toEqual(['/etc/nginx.conf', './conf.d/a.conf', '~/app.env'])
  })
})

describe('extractFileMentionPaths', () => {
  it('dedupes repeated paths', () => {
    expect(extractFileMentionPaths('@/etc/hosts then @/etc/hosts')).toEqual(['/etc/hosts'])
  })
})

describe('expandMentionPath', () => {
  it('expands ~/ with the SSH username', () => {
    expect(expandMentionPath('~/a.conf', 'deploy')).toBe('/home/deploy/a.conf')
    expect(expandMentionPath('~/a.conf', 'root')).toBe('/root/a.conf')
    expect(expandMentionPath('/etc/hosts', 'deploy')).toBe('/etc/hosts')
    expect(expandMentionPath('~/a.conf')).toBe('~/a.conf')
  })
})

describe('needsFileMentionPicker', () => {
  it('asks for a terminal when @path is used without a live pin', () => {
    expect(needsFileMentionPicker('@/etc/hosts', { status: 'none' })).toBe(true)
    expect(needsFileMentionPicker('@/etc/hosts', { status: 'live', tabId: 't1' })).toBe(false)
    expect(needsFileMentionPicker('hello @nginx', { status: 'none' })).toBe(false)
  })
})
