import { usePaneLayoutStore, type PaneTab } from '../store/paneLayoutStore'
import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'
import { collectLeaves } from './paneLayout'

export type MentionableSession = TerminalSession & {
  paneNumber?: number
  paneCount?: number
}

/** Terminals that still have a pane somewhere, in any tab. */
function placedTerminalIds(paneTabs: readonly PaneTab[]): Set<string> {
  return new Set(
    paneTabs.flatMap((tab) =>
      collectLeaves(tab.root)
        .map((leaf) => leaf.terminalId)
        .filter((id): id is string => Boolean(id))
    )
  )
}

/**
 * The 1-based index painted on a split pane header, keyed by terminal.
 *
 * Matches `PaneGrid`: only a tab with more than one leaf draws numbers, and the
 * index is `collectLeaves` order — the same walk that lays the frames out.
 */
export function paneNumberByTerminalId(
  paneTabs: readonly PaneTab[]
): Map<string, { paneNumber: number; paneCount: number }> {
  const map = new Map<string, { paneNumber: number; paneCount: number }>()
  for (const tab of paneTabs) {
    const leaves = collectLeaves(tab.root)
    if (leaves.length < 2) continue
    leaves.forEach((leaf, index) => {
      if (!leaf.terminalId) return
      map.set(leaf.terminalId, { paneNumber: index + 1, paneCount: leaves.length })
    })
  }
  return map
}

function tabsInMentionOrder(paneTabs: readonly PaneTab[], activeTabId?: string): PaneTab[] {
  if (!activeTabId) return [...paneTabs]
  const active = paneTabs.filter((tab) => tab.id === activeTabId)
  const rest = paneTabs.filter((tab) => tab.id !== activeTabId)
  return [...active, ...rest]
}

/**
 * The terminals `@` can name.
 *
 * A blank tab off "+" is registered as an idle session with no pty behind it, so
 * naming one promises a shell the tools cannot reach; a session whose pane has
 * gone is one the user has no way to look at. Neither belongs in a list of
 * things to point the agent at.
 *
 * Everything that resolves a mention has to work from this one list, because the
 * `@` tokens are only unique within the list they were derived from.
 *
 * Order follows the layout the user can see: the active tab's panes in leaf
 * order (the same 1, 2, 3 as the headers), then the other tabs. Duplicate
 * `@host-N` suffixes read `paneNumber` off this list so they match those
 * headers rather than session-store insertion order.
 */
export function selectMentionableTerminals(
  sessions: readonly TerminalSession[],
  paneTabs: readonly PaneTab[],
  activeTabId?: string
): MentionableSession[] {
  const placed = placedTerminalIds(paneTabs)
  const byId = new Map(
    sessions
      .filter((session) => session.status !== 'idle' && placed.has(session.id))
      .map((session) => [session.id, session])
  )
  const paneInfo = paneNumberByTerminalId(paneTabs)
  const seen = new Set<string>()
  const ordered: MentionableSession[] = []
  for (const tab of tabsInMentionOrder(paneTabs, activeTabId)) {
    for (const leaf of collectLeaves(tab.root)) {
      if (!leaf.terminalId || seen.has(leaf.terminalId)) continue
      const session = byId.get(leaf.terminalId)
      if (!session) continue
      seen.add(leaf.terminalId)
      const info = paneInfo.get(leaf.terminalId)
      ordered.push(info ? { ...session, paneNumber: info.paneNumber, paneCount: info.paneCount } : session)
    }
  }
  return ordered
}

/** Store-reading form, for mention handling that runs outside React. */
export function mentionableTerminals(): MentionableSession[] {
  const layout = usePaneLayoutStore.getState()
  return selectMentionableTerminals(
    useSessionsStore.getState().sessions,
    layout.tabs,
    layout.activeTabId
  )
}
