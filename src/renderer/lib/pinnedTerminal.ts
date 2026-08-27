/** Matches the generic @terminal keyword (picker alias / examples). */
export const TERMINAL_MENTION = /@terminal\b/i

/** Host-facing tools that may omit tab_id and fall back to the pinned terminal. */
export const PIN_DEFAULT_TOOLS = new Set([
  'exec_command',
  'run_in_terminal',
  'read_file',
  'edit_file',
  'apply_patch',
  'write_file',
  'grep',
  'glob',
  'git_read',
  'git_commit'
])

export type PinResolution =
  | { status: 'none' }
  | { status: 'live'; tabId: string }
  | { status: 'stale'; tabId: string; label?: string }

export interface MentionableTab {
  id?: string
  host?: string
  username?: string
  customTitle?: string
  title?: string
  wslDistro?: string
  kind?: string
}

export function formatTerminalLabel(tab: {
  customTitle?: string
  username: string
  host: string
  title?: string
  wslDistro?: string
  kind?: string
}): string {
  const custom = tab.customTitle?.trim()
  if (custom) return custom
  if (tab.kind === 'wsl') return tab.wslDistro || tab.title || 'WSL'
  if (tab.username && tab.host) return `${tab.username}@${tab.host}`
  return tab.host || tab.title || 'host'
}

/** Token inserted after @, Cursor-style: the host (or WSL distro) name. */
export function mentionTokenFor(tab: MentionableTab): string {
  const raw =
    tab.kind === 'wsl'
      ? tab.customTitle || tab.wslDistro || tab.title || 'wsl'
      : tab.host || tab.customTitle || tab.title || 'host'
  return sanitizeMentionToken(raw)
}

function sanitizeMentionToken(raw: string): string {
  const token = raw.trim().replace(/\s+/g, '-').replace(/^@+/, '')
  return token || 'host'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Query after a trailing @ in the composer (Cursor-style mention). */
export function parseAtQuery(beforeCaret: string): string | null {
  const m = /@([^\s]*)$/.exec(beforeCaret)
  return m ? m[1] : null
}

export function filterTabsForMention<T extends MentionableTab>(tabs: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q || 'terminal'.startsWith(q)) return tabs
  return tabs.filter((tab) => {
    const hay = [
      mentionTokenFor(tab),
      formatTerminalLabel({
        customTitle: tab.customTitle,
        username: tab.username ?? '',
        host: tab.host ?? '',
        title: tab.title,
        wslDistro: tab.wslDistro,
        kind: tab.kind
      }),
      tab.host,
      tab.username,
      tab.customTitle,
      tab.title,
      tab.wslDistro
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
}

/** Host names contain dots, so `.` is not a mention terminator. */
function mentionPattern(token: string): RegExp {
  return new RegExp(`@${escapeRegExp(token)}(?=$|\\s|[,;:!?])`, 'i')
}

export function hasTerminalMention(prompt: string, tabs: readonly MentionableTab[] = []): boolean {
  if (TERMINAL_MENTION.test(prompt)) return true
  return tabs.some((tab) => mentionPattern(mentionTokenFor(tab)).test(prompt))
}

export function matchTabByMention<T extends MentionableTab>(
  prompt: string,
  tabs: readonly T[]
): T | undefined {
  const hits = tabs.filter((tab) => mentionPattern(mentionTokenFor(tab)).test(prompt))
  if (hits.length === 0) return undefined
  return [...hits].sort((a, b) => mentionTokenFor(b).length - mentionTokenFor(a).length)[0]
}

export function rewriteTerminalMentions(text: string, token: string): string {
  return text.replace(/@terminal\b/gi, `@${token}`)
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
  activeSessionId: string | null | undefined
): string | null {
  if (pinnedTabId) return pinnedTabId
  return activeSessionId ?? null
}

/** Bare @terminal / unmatched host mention with no live pin must open the picker. */
export function needsTerminalPicker(prompt: string, pin: PinResolution): boolean {
  if (pin.status === 'live') return false
  return TERMINAL_MENTION.test(prompt)
}

/** Terminal whose scrollback/cwd should ride along on this turn. */
export function terminalContextTabId(
  pin: PinResolution,
  activeSessionId: string | null | undefined
): string | undefined {
  if (pin.status === 'live') return pin.tabId
  if (pin.status === 'stale') return undefined
  return activeSessionId ?? undefined
}

export function snapshotTabMarkers(
  tabId: string,
  activeSessionId: string | null | undefined,
  pinnedTabId: string | undefined
): string {
  const parts: string[] = []
  if (pinnedTabId && tabId === pinnedTabId) parts.push('pinned')
  if (activeSessionId && tabId === activeSessionId) parts.push('active')
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
  caret: number,
  token: string
): { next: string; caret: number } {
  const before = value.slice(0, caret).replace(/@([^\s]*)$/, `@${token} `)
  const after = value.slice(caret)
  return { next: before + after, caret: before.length }
}

export interface MentionSpan {
  start: number
  end: number
  token: string
}

/** Trailing @query at the caret — still being typed, not yet a chip. */
export function liveMentionRange(text: string, caret: number): { start: number; end: number } | null {
  const query = parseAtQuery(text.slice(0, caret))
  if (query === null) return null
  const after = text[caret]
  // Caret sitting at the end of a committed @host (next char is space/punct).
  if (after !== undefined && /[\s,;:!?]/.test(after)) return null
  return { start: caret - query.length - 1, end: caret }
}

/**
 * Committed @host tokens (Cursor-style chips). A mention is committed only when
 * followed by whitespace or punctuation — not at end-of-string, where the user
 * may still be typing.
 */
export function findMentionSpans(text: string, tabs: readonly MentionableTab[]): MentionSpan[] {
  const tokens = [...new Set(['terminal', ...tabs.map((tab) => mentionTokenFor(tab))])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  const spans: MentionSpan[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '@') {
      i += 1
      continue
    }
    if (i > 0 && /[A-Za-z0-9._-]/.test(text[i - 1] ?? '')) {
      i += 1
      continue
    }
    let hit: MentionSpan | null = null
    for (const token of tokens) {
      const raw = `@${token}`
      if (text.slice(i, i + raw.length).toLowerCase() !== raw.toLowerCase()) continue
      const after = text[i + raw.length]
      if (after !== undefined && /[\s,;:!?]/.test(after)) {
        hit = { start: i, end: i + raw.length, token }
        break
      }
    }
    if (hit) {
      spans.push(hit)
      i = hit.end
    } else {
      i += 1
    }
  }
  return spans
}

export function caretOnMentionChip(
  text: string,
  caret: number,
  tabs: readonly MentionableTab[]
): boolean {
  return findMentionSpans(text, tabs).some((s) => caret >= s.start && caret <= s.end)
}

export function snapSelectionToMentions(
  spans: readonly MentionSpan[],
  start: number,
  end: number
): { start: number; end: number } | null {
  if (start === end) {
    const span = spans.find((s) => s.start < start && start < s.end)
    return span ? { start: span.start, end: span.end } : null
  }
  let a = Math.min(start, end)
  let b = Math.max(start, end)
  let changed = false
  for (const span of spans) {
    if (span.start < b && span.end > a) {
      if (span.start < a) {
        a = span.start
        changed = true
      }
      if (span.end > b) {
        b = span.end
        changed = true
      }
    }
  }
  return changed ? { start: a, end: b } : null
}

export type MentionKeyResult =
  | { type: 'edit'; text: string; caret: number }
  | { type: 'select'; start: number; end: number }

function deleteRange(text: string, start: number, end: number): MentionKeyResult {
  return { type: 'edit', text: text.slice(0, start) + text.slice(end), caret: start }
}

/** Backspace/Delete/arrows treat a committed @host chip as one unit. */
export function applyMentionHotkey(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  key: string,
  tabs: readonly MentionableTab[]
): MentionKeyResult | null {
  const caret = selectionStart
  const collapsed = selectionStart === selectionEnd
  const live = liveMentionRange(text, Math.max(selectionStart, selectionEnd))
  const spans = findMentionSpans(text, tabs).filter((s) => {
    if (!live) return true
    return s.end <= live.start || s.start >= live.end
  })

  const inLive = (pos: number, mode: 'backspace' | 'delete' | 'left' | 'right'): boolean => {
    if (!live) return false
    if (mode === 'backspace') return pos > live.start && pos <= live.end
    if (mode === 'left') return pos > live.start && pos <= live.end
    return pos >= live.start && pos < live.end
  }

  if (key === 'Backspace') {
    if (!collapsed) {
      const snapped = snapSelectionToMentions(spans, selectionStart, selectionEnd)
      if (!snapped) return null
      return deleteRange(text, snapped.start, snapped.end)
    }
    if (inLive(caret, 'backspace')) return null
    const span = spans.find((s) => s.start < caret && caret <= s.end)
    return span ? deleteRange(text, span.start, span.end) : null
  }

  if (key === 'Delete') {
    if (!collapsed) {
      const snapped = snapSelectionToMentions(spans, selectionStart, selectionEnd)
      if (!snapped) return null
      return deleteRange(text, snapped.start, snapped.end)
    }
    if (inLive(caret, 'delete')) return null
    const span = spans.find((s) => s.start <= caret && caret < s.end)
    return span ? deleteRange(text, span.start, span.end) : null
  }

  if (key === 'ArrowLeft' && collapsed) {
    if (inLive(caret, 'left')) return null
    const span = spans.find((s) => s.start < caret && caret <= s.end)
    return span ? { type: 'select', start: span.start, end: span.start } : null
  }

  if (key === 'ArrowRight' && collapsed) {
    if (inLive(caret, 'right')) return null
    const span = spans.find((s) => s.start <= caret && caret < s.end)
    return span ? { type: 'select', start: span.end, end: span.end } : null
  }

  if (key.length === 1 && collapsed) {
    if (inLive(caret, 'delete')) return null
    const span = spans.find((s) => s.start < caret && caret < s.end)
    if (!span) return null
    const next = text.slice(0, span.start) + key + text.slice(span.end)
    return { type: 'edit', text: next, caret: span.start + key.length }
  }

  return null
}
