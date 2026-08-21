import { describe, expect, it } from 'vitest'
import {
  applyPinnedTabId,
  needsTerminalPicker,
  replaceAtMention,
  resolvePinnedTab,
  shouldPinOnSend,
  snapshotTabMarkers,
  terminalContextTabId
} from './pinnedTerminal'

describe('resolvePinnedTab', () => {
  it('is none when nothing is pinned', () => {
    expect(resolvePinnedTab(undefined, undefined, ['a'])).toEqual({ status: 'none' })
  })

  it('is live when the pinned tab is still open', () => {
    expect(resolvePinnedTab('a', 'u@h', ['a', 'b'])).toEqual({ status: 'live', tabId: 'a' })
  })

  it('is stale when the pinned tab was closed', () => {
    expect(resolvePinnedTab('gone', 'u@h', ['a'])).toEqual({
      status: 'stale',
      tabId: 'gone',
      label: 'u@h'
    })
  })
})

describe('shouldPinOnSend', () => {
  it('pins the active terminal on the first send', () => {
    expect(shouldPinOnSend(undefined, 't1')).toBe('t1')
  })

  it('keeps an existing pin on follow-up, even if another tab is active', () => {
    expect(shouldPinOnSend('t1', 't2')).toBe('t1')
  })

  it('keeps a stale pin instead of silently switching', () => {
    expect(shouldPinOnSend('closed', 't2')).toBe('closed')
  })
})

describe('needsTerminalPicker', () => {
  it('blocks a bare @terminal when there is no live pin', () => {
    expect(needsTerminalPicker('@terminal chart cpu', { status: 'none' })).toBe(true)
    expect(
      needsTerminalPicker('@terminal chart cpu', { status: 'stale', tabId: 'x', label: 'u@h' })
    ).toBe(true)
  })

  it('does not block when a live pin already exists', () => {
    expect(needsTerminalPicker('@terminal chart cpu', { status: 'live', tabId: 'a' })).toBe(false)
  })

  it('does not open for a prompt without @terminal', () => {
    expect(needsTerminalPicker('restart nginx', { status: 'none' })).toBe(false)
  })
})

describe('terminalContextTabId', () => {
  it('prefers the live pin over the visible tab', () => {
    expect(terminalContextTabId({ status: 'live', tabId: 'pinned' }, 'active')).toBe('pinned')
  })

  it('falls back to the active tab when unpinned', () => {
    expect(terminalContextTabId({ status: 'none' }, 'active')).toBe('active')
  })

  it('does not silently switch to the visible tab when the pin is stale', () => {
    expect(terminalContextTabId({ status: 'stale', tabId: 'gone', label: 'u@h' }, 'active')).toBe(
      undefined
    )
  })
})

describe('applyPinnedTabId', () => {
  it('fills a missing tab_id for host tools', () => {
    expect(applyPinnedTabId('exec_command', { command: 'ls' }, 'tab-1')).toEqual({
      command: 'ls',
      tab_id: 'tab-1'
    })
  })

  it('does not override an explicit tab_id', () => {
    expect(
      applyPinnedTabId('read_file', { tab_id: 'other', path: '/etc/hosts' }, 'tab-1')
    ).toEqual({ tab_id: 'other', path: '/etc/hosts' })
  })

  it('does not default close_tab', () => {
    expect(applyPinnedTabId('close_tab', {}, 'tab-1')).toEqual({})
  })
})

describe('snapshotTabMarkers', () => {
  it('marks pinned and active independently', () => {
    expect(snapshotTabMarkers('a', 'a', 'a')).toBe(' | pinned | active')
    expect(snapshotTabMarkers('a', 'b', 'a')).toBe(' | pinned')
    expect(snapshotTabMarkers('b', 'b', 'a')).toBe(' | active')
    expect(snapshotTabMarkers('c', 'b', 'a')).toBe('')
  })
})

describe('replaceAtMention', () => {
  it('turns a partial @ prefix into @terminal', () => {
    expect(replaceAtMention('see @ter', 8)).toEqual({ next: 'see @terminal ', caret: 14 })
  })
})
