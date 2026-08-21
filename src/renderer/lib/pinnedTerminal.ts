/** Matches the @terminal mention used to request live output / charts. */
export const TERMINAL_MENTION = /@terminal\b/i

/** Host-facing tools that may omit tab_id and fall back to the pinned terminal. */
export const PIN_DEFAULT_TOOLS = new Set([
  'exec_command',
  'run_in_terminal',
  'read_file',
  'edit_file',
  'write_file',
  'grep',
  'glob'
])

export type PinResolution =
  | { status: 'none' }
  | { status: 'live'; tabId: string }
  | { status: 'stale'; tabId: string; label?: string }

export function formatTerminalLabel(tab: {
  customTitle?: string
  username: string
  host: string
}): string {
  const custom = tab.customTitle?.trim()
  return custom || `${tab.username}@${tab.host}`
}

export function resolvePinnedTab(
  pinnedTabId: string | undefined,
  pinnedLabel: string | undefined,
  openTabIds: ReadonlySet<string> | readonly string[]
): PinResolution {
  if (!pinnedTabId) return { status: 'none' }
  const ids = openTabIds instanceof Set ? openTabIds : new Set(openTabIds)
  if (ids.has(pinnedTabId)) return { status: 'live', tabId: pinnedTabId }
  return { status: 'stale', tabId: pinnedTabId, label: pinnedLabel }
}

/**
 * First send pins the active terminal. Follow-ups keep the existing pin
 * (including a stale one) — never silently switch to whatever Tab is visible.
 */
export function shouldPinOnSend(
  pinnedTabId: string | undefined,
  activeTabId: string | null | undefined
): string | null {
  if (pinnedTabId) return pinnedTabId
  return activeTabId ?? null
}

/** Bare @terminal with no live pin must open the picker instead of sending. */
export function needsTerminalPicker(prompt: string, pin: PinResolution): boolean {
  if (!TERMINAL_MENTION.test(prompt)) return false
  return pin.status !== 'live'
}

/** Terminal whose scrollback/cwd should ride along on this turn. */
export function terminalContextTabId(
  pin: PinResolution,
  activeTabId: string | null | undefined
): string | undefined {
  if (pin.status === 'live') return pin.tabId
  if (pin.status === 'stale') return undefined
  return activeTabId ?? undefined
}

export function snapshotTabMarkers(
  tabId: string,
  activeTabId: string | null | undefined,
  pinnedTabId: string | undefined
): string {
  const parts: string[] = []
  if (pinnedTabId && tabId === pinnedTabId) parts.push('pinned')
  if (activeTabId && tabId === activeTabId) parts.push('active')
  return parts.length > 0 ? ` | ${parts.join(' | ')}` : ''
}

/** Fill a missing tab_id from the pinned terminal. Explicit ids are left alone. */
export function applyPinnedTabId(
  toolName: string,
  args: Record<string, unknown>,
  pinnedTabId: string | undefined
): Record<string, unknown> {
  if (!pinnedTabId || !PIN_DEFAULT_TOOLS.has(toolName)) return args
  const existing = typeof args.tab_id === 'string' ? args.tab_id.trim() : ''
  if (existing) return args
  return { ...args, tab_id: pinnedTabId }
}

export function replaceAtMention(
  value: string,
  caret: number
): { next: string; caret: number } {
  const before = value.slice(0, caret).replace(/@(\w*)$/, '@terminal ')
  const after = value.slice(caret)
  return { next: before + after, caret: before.length }
}
