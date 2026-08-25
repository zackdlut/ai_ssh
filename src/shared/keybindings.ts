export type KeybindingId =
  | 'askCopilot'
  | 'toggleNlMode'
  | 'toggleLineNumbers'
  | 'splitVertical'
  | 'splitHorizontal'
  | 'closePane'
  | 'zoomPane'
  | 'focusPaneLeft'
  | 'focusPaneRight'
  | 'focusPaneUp'
  | 'focusPaneDown'
  | 'evenPanes'
  | 'toggleSyncInput'
  | 'openPaneDiff'
  | 'paneSearch'

export type KeybindingsSettings = Record<KeybindingId, string>

export const KEYBINDING_IDS: KeybindingId[] = [
  'askCopilot',
  'toggleNlMode',
  'toggleLineNumbers',
  'splitVertical',
  'splitHorizontal',
  'closePane',
  'zoomPane',
  'focusPaneLeft',
  'focusPaneRight',
  'focusPaneUp',
  'focusPaneDown',
  'evenPanes',
  'toggleSyncInput',
  'openPaneDiff',
  'paneSearch'
]

/**
 * Pane bindings all use mod+shift because a bare mod+key would shadow common
 * shell editing keys, and `VALID_KEY` below rules out the punctuation that
 * other terminals use for splits.
 *
 * Letters and arrows only when `shift` is involved: matching compares against
 * `KeyboardEvent.key`, and shift turns a digit into punctuation (`0` arrives as
 * `)`), so a `mod+shift+<digit>` chord could never fire.
 */
export const DEFAULT_KEYBINDINGS: KeybindingsSettings = {
  askCopilot: 'mod+f',
  toggleNlMode: 'f12',
  toggleLineNumbers: 'f11',
  splitVertical: 'mod+shift+e',
  splitHorizontal: 'mod+shift+o',
  closePane: 'mod+shift+w',
  zoomPane: 'mod+shift+z',
  focusPaneLeft: 'mod+shift+arrowleft',
  focusPaneRight: 'mod+shift+arrowright',
  focusPaneUp: 'mod+shift+arrowup',
  focusPaneDown: 'mod+shift+arrowdown',
  evenPanes: 'mod+shift+b',
  toggleSyncInput: 'mod+shift+i',
  openPaneDiff: 'mod+shift+d',
  // mod+f is already "ask Copilot", so in-pane find takes the shifted variant.
  paneSearch: 'mod+shift+f'
}

/**
 * Arrows are spelled out the way `KeyboardEvent.key` reports them, lowercased,
 * so `matchesKeyEvent` can compare without a lookup table.
 */
const VALID_KEY = /^(f([1-9]|1[0-2])|arrow(left|right|up|down)|[a-z0-9])$/

export interface ParsedKeybinding {
  key: string
  mod: boolean
  shift: boolean
  alt: boolean
}

export function parseKeybinding(spec: string): ParsedKeybinding {
  const parts = spec
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)

  let mod = false
  let shift = false
  let alt = false
  let key = ''

  for (const part of parts) {
    if (part === 'mod') mod = true
    else if (part === 'shift') shift = true
    else if (part === 'alt') alt = true
    else key = part
  }

  return { key, mod, shift, alt }
}

export function normalizeKeybinding(
  spec: string,
  fallback: string = DEFAULT_KEYBINDINGS.askCopilot
): string {
  const { key, mod, shift, alt } = parseKeybinding(spec)
  if (!key || !VALID_KEY.test(key)) return fallback

  const parts: string[] = []
  if (mod) parts.push('mod')
  if (shift) parts.push('shift')
  if (alt) parts.push('alt')
  parts.push(key)
  return parts.join('+')
}

export function normalizeKeybindingsSettings(
  input: Partial<KeybindingsSettings> | null | undefined
): KeybindingsSettings {
  const base = DEFAULT_KEYBINDINGS
  if (!input) return { ...base }

  const out = {} as KeybindingsSettings
  for (const id of KEYBINDING_IDS) {
    out[id] = normalizeKeybinding(input[id] ?? '', base[id])
  }
  return out
}
