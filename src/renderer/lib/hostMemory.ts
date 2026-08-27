/**
 * Per-host memory: a remote `AGENTS.md` the agent reads before acting.
 *
 * `user_rules` is one global block, which is the wrong shape for operations
 * work: "deploys go through systemctl, never the init script" is true of one
 * host and wrong on the next, so it either pollutes every task or is not
 * written down at all. Claude Code solves the same problem with a `CLAUDE.md`
 * in the repo; here the natural scope is the MACHINE, so the file lives on the
 * host and is fetched over SFTP when a task targets it.
 *
 * Reads are cached per session and warmed from `sendPrompt`, which is already
 * async — the turn assembly in `startTurn` is synchronous and must not grow a
 * network round trip. A host with no `AGENTS.md` is the common case, so a miss
 * is remembered too: the alternative is one wasted SFTP probe per turn, on
 * every host, forever.
 */
import { useSessionsStore } from '../store/sessionsStore'

/** Candidate locations, in priority order. The first that exists wins. */
const MEMORY_FILENAMES = ['AGENTS.md', '.ai-terminal.md']

/**
 * Cap on the injected text. This rides in every turn's context for the whole
 * task, so a host whose AGENTS.md grew into a runbook must not silently eat the
 * window that the actual command output needs.
 */
const MEMORY_MAX_CHARS = 4000

interface CacheEntry {
  /** Resolved absolute path, when a file was found. */
  path?: string
  content?: string
  /** Set when the probe ran and found nothing, so it is not repeated. */
  missing: boolean
}

const cache = new Map<string, CacheEntry>()

/** Home directory for an SSH user, matching the @path mention expansion. */
function homeDir(username: string | undefined): string {
  if (!username) return '~'
  return username === 'root' ? '/root' : `/home/${username}`
}

export function hostMemoryCandidates(username: string | undefined): string[] {
  const home = homeDir(username)
  return MEMORY_FILENAMES.map((name) => `${home}/${name}`)
}

/** True when a write to this path invalidates a host's cached memory. */
export function isHostMemoryPath(path: string): boolean {
  const name = path.split('/').filter(Boolean).pop()
  return !!name && MEMORY_FILENAMES.includes(name)
}

/**
 * Forget a host's cached memory so the next turn re-reads it. Called after any
 * write that lands on an `AGENTS.md`, which is how "the model recorded a
 * convention" becomes "the next turn is bound by it".
 */
export function invalidateHostMemory(terminalTabId: string): void {
  cache.delete(terminalTabId)
}

export function clearHostMemoryCache(): void {
  cache.clear()
}

/**
 * Read (and cache) the host memory for a terminal tab. Resolves to undefined
 * when the tab cannot be read or carries no memory file.
 */
export async function loadHostMemory(terminalTabId: string | undefined): Promise<void> {
  if (!terminalTabId || cache.has(terminalTabId)) return
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === terminalTabId)
  // WSL tabs have no SFTP channel; an unconnected tab has nothing to read.
  if (!tab || tab.kind === 'wsl' || tab.status !== 'connected' || !tab.sessionId) return

  for (const path of hostMemoryCandidates(tab.username)) {
    const res = await window.api.sftp.readText(tab.sessionId, path, {
      maxBytes: MEMORY_MAX_CHARS * 2
    })
    const text = res.read?.text?.trim()
    if (res.error || !text) continue
    cache.set(terminalTabId, {
      path,
      content: text.length > MEMORY_MAX_CHARS ? `${text.slice(0, MEMORY_MAX_CHARS)}\n…` : text,
      missing: false
    })
    return
  }
  cache.set(terminalTabId, { missing: true })
}

/**
 * Render the cached host memory as a system message. Synchronous by design so
 * turn assembly never waits on the network: a host warmed by `loadHostMemory`
 * is injected, one that is not simply is not, and the next turn has it.
 */
export function buildHostMemoryMessage(terminalTabId: string | undefined): string | undefined {
  if (!terminalTabId) return undefined
  const entry = cache.get(terminalTabId)
  if (!entry || entry.missing || !entry.content) return undefined
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === terminalTabId)
  const host = tab?.host ? ` (${tab.host})` : ''
  return `Host memory for the pinned host${host}, from ${entry.path} — conventions this machine's operators recorded for you. Follow them; they lose only to an explicit instruction in this conversation.

${entry.content}`
}

/** Where a new convention should be written for this tab, for the prompt. */
export function hostMemoryPath(terminalTabId: string | undefined): string | undefined {
  if (!terminalTabId) return undefined
  const entry = cache.get(terminalTabId)
  if (entry?.path) return entry.path
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === terminalTabId)
  if (!tab || tab.kind === 'wsl') return undefined
  return hostMemoryCandidates(tab.username)[0]
}
