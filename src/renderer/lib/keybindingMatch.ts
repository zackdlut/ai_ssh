import { normalizeKeybinding, parseKeybinding } from '../../shared/keybindings'

export function matchesKeyEvent(spec: string, e: KeyboardEvent): boolean {
  const { key, mod, shift, alt } = parseKeybinding(normalizeKeybinding(spec, ''))
  if (!key) return false

  const modPressed = e.ctrlKey || e.metaKey
  if (mod !== modPressed) return false
  if (shift !== e.shiftKey) return false
  if (alt !== e.altKey) return false

  return e.key.toLowerCase() === key
}

/** Serialize a keydown into our binding spec, or null if the key should be ignored. */
export function keyEventToBinding(e: KeyboardEvent): string | null {
  if (e.type !== 'keydown') return null
  if (e.isComposing || e.keyCode === 229) return null
  if (['Control', 'Meta', 'Shift', 'Alt', 'OS'].includes(e.key)) return null

  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')

  let keyPart = e.key.toLowerCase()
  if (/^f([1-9]|1[0-2])$/i.test(e.key)) {
    keyPart = e.key.toLowerCase()
  } else if (e.key.length === 1) {
    keyPart = e.key.toLowerCase()
  } else {
    return null
  }

  parts.push(keyPart)
  const normalized = normalizeKeybinding(parts.join('+'), '')
  return normalized || null
}
