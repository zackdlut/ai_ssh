import { describe, expect, it } from 'vitest'
import {
  applyPinnedTabId,
  applyMentionHotkey,
  filterTabsForMention,
  findMentionSpans,
  hasTerminalMention,
  matchTabByMention,
  mentionTokenFor,
  mentionTokenMap,
  needsTerminalPicker,
  parseAtQuery,
  replaceAtMention,
  resolvePinnedTab,
  rewriteTerminalMentions,
  shouldPinOnSend,
  snapshotTabMarkers,
  terminalContextTabId,
  uniqueMentionTokens
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

describe('mentionTokenFor', () => {
  it('uses the SSH host, not user@host or the word terminal', () => {
    expect(
      mentionTokenFor({ username: 'root', host: 'prod.example.com', kind: 'ssh' })
    ).toBe('prod.example.com')
  })

  it('uses the WSL distro when there is no host', () => {
    expect(mentionTokenFor({ kind: 'wsl', host: '', wslDistro: 'Ubuntu-22.04' })).toBe(
      'Ubuntu-22.04'
    )
  })
})

describe('uniqueMentionTokens', () => {
  it('leaves a host alone when only one session is on it', () => {
    expect(
      uniqueMentionTokens([
        { id: 'a', username: 'root', host: 'prod.example.com', port: 22 },
        { id: 'b', username: 'root', host: 'staging.internal', port: 22 }
      ])
    ).toEqual(['prod.example.com', 'staging.internal'])
  })

  it('falls back to the connection name for a second session on the host', () => {
    expect(
      uniqueMentionTokens([
        { id: 'a', username: 'root', host: '10.0.0.7', port: 22, title: 'web' },
        { id: 'b', username: 'deploy', host: '10.0.0.7', port: 22, title: 'db' }
      ])
    ).toEqual(['10.0.0.7', 'db'])
  })

  it('falls back to user@host when neither session is named', () => {
    expect(
      uniqueMentionTokens([
        { id: 'a', username: 'root', host: '10.0.0.7', port: 22 },
        { id: 'b', username: 'deploy', host: '10.0.0.7', port: 22 }
      ])
    ).toEqual(['10.0.0.7', 'deploy@10.0.0.7'])
  })

  it('falls back to the port when the account matches too', () => {
    expect(
      uniqueMentionTokens([
        { id: 'a', username: 'root', host: '10.0.0.7', port: 22 },
        { id: 'b', username: 'root', host: '10.0.0.7', port: 2222 }
      ])
    ).toEqual(['10.0.0.7', 'root@10.0.0.7:2222'])
  })

  it('numbers sessions that are identical in every other way', () => {
    expect(
      uniqueMentionTokens([
        { id: 'a', username: 'root', host: '10.0.0.7', port: 22 },
        { id: 'b', username: 'root', host: '10.0.0.7', port: 22 },
        { id: 'c', username: 'root', host: '10.0.0.7', port: 22 }
      ])
    ).toEqual(['10.0.0.7', '10.0.0.7-2', '10.0.0.7-3'])
  })

  it('numbers duplicates of one saved connection, which share every name', () => {
    expect(
      uniqueMentionTokens([
        { id: 'a', username: 'root', host: '10.0.0.7', port: 22, title: 'web' },
        { id: 'b', username: 'root', host: '10.0.0.7', port: 22, title: 'web' }
      ])
    ).toEqual(['10.0.0.7', '10.0.0.7-2'])
  })

  it('numbers duplicate WSL distros, which have nothing else to go on', () => {
    expect(
      uniqueMentionTokens([
        { id: 'a', kind: 'wsl', host: '', wslDistro: 'Ubuntu' },
        { id: 'b', kind: 'wsl', host: '', wslDistro: 'Ubuntu' }
      ])
    ).toEqual(['Ubuntu', 'Ubuntu-2'])
  })

  it('keys the tokens by terminal id', () => {
    const tabs = [
      { id: 'a', username: 'root', host: '10.0.0.7', port: 22 },
      { id: 'b', username: 'deploy', host: '10.0.0.7', port: 22 }
    ]
    expect([...mentionTokenMap(tabs)]).toEqual([
      ['a', '10.0.0.7'],
      ['b', 'deploy@10.0.0.7']
    ])
  })
})

describe('parseAtQuery / filterTabsForMention', () => {
  const tabs = [
    { id: 'a', username: 'root', host: 'prod.example.com' },
    { id: 'b', username: 'ubuntu', host: 'staging.internal' }
  ]

  it('treats a trailing @ as an open mention query', () => {
    expect(parseAtQuery('see @')).toBe('')
    expect(parseAtQuery('see @prod')).toBe('prod')
    expect(parseAtQuery('see @prod chart')).toBe(null)
  })

  it('keeps all tabs for the @terminal alias prefix', () => {
    expect(filterTabsForMention(tabs, 'ter').map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('filters by host as you type', () => {
    expect(filterTabsForMention(tabs, 'prod').map((t) => t.id)).toEqual(['a'])
    expect(filterTabsForMention(tabs, 'staging').map((t) => t.id)).toEqual(['b'])
  })
})

describe('hasTerminalMention / matchTabByMention', () => {
  const tabs = [
    { id: 'a', host: 'prod.example.com' },
    { id: 'b', host: 'prod' }
  ]

  it('treats @hostname as a terminal mention, including dotted hosts', () => {
    expect(hasTerminalMention('@prod.example.com chart cpu', tabs)).toBe(true)
    expect(hasTerminalMention('@terminal chart cpu', tabs)).toBe(true)
    expect(hasTerminalMention('restart nginx', tabs)).toBe(false)
  })

  it('does not match a shorter host prefix inside a dotted hostname', () => {
    expect(matchTabByMention('@prod.example.com chart', tabs)?.id).toBe('a')
  })
})

describe('matching two sessions on one host', () => {
  const tabs = [
    { id: 'a', username: 'root', host: '10.0.0.7', port: 22 },
    { id: 'b', username: 'deploy', host: '10.0.0.7', port: 22 }
  ]

  it('sends the bare host to the first session and user@host to the second', () => {
    expect(matchTabByMention('@10.0.0.7 df -h', tabs)?.id).toBe('a')
    expect(matchTabByMention('@deploy@10.0.0.7 df -h', tabs)?.id).toBe('b')
  })

  it('chips the qualified mention whole, not just the host inside it', () => {
    expect(findMentionSpans('@deploy@10.0.0.7 df -h', tabs)).toEqual([
      { start: 0, end: 16, token: 'deploy@10.0.0.7' }
    ])
  })

  it('finds the qualified session by what the user is typing', () => {
    expect(filterTabsForMention(tabs, 'deploy@10').map((t) => t.id)).toEqual(['b'])
  })

  it('finds a numbered duplicate by its token', () => {
    const dupes = [
      { id: 'a', username: 'root', host: '10.0.0.7', port: 22 },
      { id: 'b', username: 'root', host: '10.0.0.7', port: 22 }
    ]
    expect(filterTabsForMention(dupes, '10.0.0.7-2').map((t) => t.id)).toEqual(['b'])
    expect(matchTabByMention('@10.0.0.7-2 uptime', dupes)?.id).toBe('b')
  })
})

describe('rewriteTerminalMentions', () => {
  it('rewrites the @terminal alias to the selected host token', () => {
    expect(rewriteTerminalMentions('@terminal 把 CPU 画成图', 'prod.example.com')).toBe(
      '@prod.example.com 把 CPU 画成图'
    )
  })
})

describe('replaceAtMention', () => {
  it('turns a partial @ prefix into @hostname', () => {
    expect(replaceAtMention('see @ter', 8, 'prod.example.com')).toEqual({
      next: 'see @prod.example.com ',
      caret: 22
    })
  })
})

describe('findMentionSpans / applyMentionHotkey', () => {
  const tabs = [{ id: 'a', host: 'prod.example.com' }]

  it('chips a committed @host followed by a space, not an in-progress query', () => {
    expect(findMentionSpans('@prod.example.com chart cpu', tabs)).toEqual([
      { start: 0, end: 17, token: 'prod.example.com' }
    ])
    expect(findMentionSpans('@prod.example.com', tabs)).toEqual([])
    expect(findMentionSpans('@prod', tabs)).toEqual([])
  })

  it('deletes the whole chip on Backspace at its end', () => {
    expect(applyMentionHotkey('@prod.example.com 画图', 17, 17, 'Backspace', tabs)).toEqual({
      type: 'edit',
      text: ' 画图',
      caret: 0
    })
  })

  it('skips over the chip with ArrowLeft', () => {
    expect(applyMentionHotkey('@prod.example.com 画图', 17, 17, 'ArrowLeft', tabs)).toEqual({
      type: 'select',
      start: 0,
      end: 0
    })
  })
})
