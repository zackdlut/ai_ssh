import { beforeEach, describe, expect, it } from 'vitest'

// The store reads persisted UI prefs at module load; this suite is about the
// busy map, so a minimal in-memory store is enough to let it import.
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0
} as Storage

const { anyChatBusy, isChatBusy, unreachableBusyTabs, useAIStore } = await import('./aiStore')

describe('isChatBusy / anyChatBusy', () => {
  it('is per chat, so one running loop does not mark another busy', () => {
    const busyByTab = { a: 'req-1' }
    expect(isChatBusy(busyByTab, 'a')).toBe(true)
    expect(isChatBusy(busyByTab, 'b')).toBe(false)
    expect(anyChatBusy(busyByTab)).toBe(true)
  })

  it('counts a chat with no request of its own (history compression) as busy', () => {
    // The entry exists with a null request id; presence is the signal.
    expect(isChatBusy({ a: null }, 'a')).toBe(true)
  })

  it('is not busy for a missing tab id', () => {
    expect(isChatBusy({ a: 'req-1' }, undefined)).toBe(false)
    expect(isChatBusy({ a: 'req-1' }, null)).toBe(false)
    expect(anyChatBusy({})).toBe(false)
  })
})

describe('unreachableBusyTabs', () => {
  const none: ReadonlySet<string> = new Set()

  it('frees a chat whose request is gone and has nothing to revive it', () => {
    // The wedge this exists to prevent: a reply arrived for a requestId nobody
    // holds, so without this the chat stays busy for the rest of the session.
    expect(unreachableBusyTabs({ a: 'req-dead' }, none, none)).toEqual(['a'])
  })

  it('leaves a chat whose turn is still in flight', () => {
    expect(unreachableBusyTabs({ a: 'req-1' }, new Set(['req-1']), none)).toEqual([])
  })

  it('leaves a chat waiting on approval or a parked summarization', () => {
    // Both sit "busy with nothing pending" legitimately and are revived later;
    // sweeping them would abandon a task the user is about to approve.
    expect(unreachableBusyTabs({ a: 'req-dead' }, none, new Set(['a']))).toEqual([])
  })

  it('never sweeps a chat busy without a request of its own', () => {
    // null = history compression, owned by the code that set it.
    expect(unreachableBusyTabs({ a: null }, none, none)).toEqual([])
  })

  it('frees only the dead chats when several are busy at once', () => {
    const swept = unreachableBusyTabs(
      { live: 'req-1', dead: 'req-dead', approving: 'req-old', compacting: null },
      new Set(['req-1']),
      new Set(['approving'])
    )
    expect(swept).toEqual(['dead'])
  })
})

describe('setTabBusy / clearTabBusy', () => {
  beforeEach(() => {
    useAIStore.setState({ busyByTab: {} })
  })

  it('tracks two chats independently', () => {
    const { setTabBusy, clearTabBusy } = useAIStore.getState()
    setTabBusy('a', 'req-a')
    setTabBusy('b', 'req-b')
    expect(useAIStore.getState().busyByTab).toEqual({ a: 'req-a', b: 'req-b' })

    clearTabBusy('a')
    // b's loop is untouched by a finishing — the whole point of the per-tab map.
    expect(useAIStore.getState().busyByTab).toEqual({ b: 'req-b' })
  })

  it('leaves the map identical when clearing a chat that was not busy', () => {
    const { setTabBusy, clearTabBusy } = useAIStore.getState()
    setTabBusy('a', 'req-a')
    const before = useAIStore.getState().busyByTab
    clearTabBusy('b')
    // Reference equality matters: the queue-replay subscription fires on change.
    expect(useAIStore.getState().busyByTab).toBe(before)
  })

  it('records a busy chat with no request id of its own', () => {
    useAIStore.getState().setTabBusy('a')
    expect(useAIStore.getState().busyByTab).toEqual({ a: null })
    expect(isChatBusy(useAIStore.getState().busyByTab, 'a')).toBe(true)
  })
})
