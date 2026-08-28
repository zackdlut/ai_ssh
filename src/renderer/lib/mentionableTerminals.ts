import { usePaneLayoutStore, type PaneTab } from '../store/paneLayoutStore'
import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'
import { collectLeaves } from './paneLayout'

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
 * The terminals `@` can name.
 *
 * A blank tab off "+" is registered as an idle session with no pty behind it, so
 * naming one promises a shell the tools cannot reach; a session whose pane has
 * gone is one the user has no way to look at. Neither belongs in a list of
 * things to point the agent at.
 *
 * Everything that resolves a mention has to work from this one list, because the
 * `@` tokens are only unique within the list they were derived from.
 */
export function selectMentionableTerminals(
  sessions: readonly TerminalSession[],
  paneTabs: readonly PaneTab[]
): TerminalSession[] {
  const placed = placedTerminalIds(paneTabs)
  return sessions.filter((session) => session.status !== 'idle' && placed.has(session.id))
}

/** Store-reading form, for mention handling that runs outside React. */
export function mentionableTerminals(): TerminalSession[] {
  return selectMentionableTerminals(
    useSessionsStore.getState().sessions,
    usePaneLayoutStore.getState().tabs
  )
}
