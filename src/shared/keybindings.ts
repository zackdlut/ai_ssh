export type KeybindingId = 'askCopilot' | 'toggleNlMode' | 'toggleLineNumbers'

export interface KeybindingsSettings {
  askCopilot: string
  toggleNlMode: string
  toggleLineNumbers: string
}

export const KEYBINDING_IDS: KeybindingId[] = [
  'askCopilot',
  'toggleNlMode',
  'toggleLineNumbers'
]

export const DEFAULT_KEYBINDINGS: KeybindingsSettings = {
  askCopilot: 'mod+f',
  toggleNlMode: 'f12',
  toggleLineNumbers: 'f11'
}

const VALID_KEY = /^(f([1-9]|1[0-2])|[a-z0-9])$/

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

  return {
    askCopilot: normalizeKeybinding(input.askCopilot ?? '', base.askCopilot),
    toggleNlMode: normalizeKeybinding(input.toggleNlMode ?? '', base.toggleNlMode),
    toggleLineNumbers: normalizeKeybinding(
      input.toggleLineNumbers ?? '',
      base.toggleLineNumbers
    )
  }
}
