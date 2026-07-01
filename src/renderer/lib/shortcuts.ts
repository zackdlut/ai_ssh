/** Platform-aware display labels for context-menu shortcut hints. */
export const SHORTCUT_COPY = 'mod+c'
export const SHORTCUT_CUT = 'mod+x'
export const SHORTCUT_PASTE = 'mod+v'

export { DEFAULT_KEYBINDINGS } from '../../shared/keybindings'

function isMac(): boolean {
  return /Mac|iPhone|iPod|iPad/i.test(navigator.platform) || /\bMac/i.test(navigator.userAgent)
}

/** Turn `mod+c` into `Ctrl+C` (Windows/Linux) or `⌘C` (macOS). */
export function formatShortcut(spec: string): string {
  const mac = isMac()
  const labels: string[] = []
  for (const part of spec.split('+')) {
    const p = part.trim().toLowerCase()
    if (p === 'mod') labels.push(mac ? '⌘' : 'Ctrl')
    else if (p === 'shift') labels.push(mac ? '⇧' : 'Shift')
    else if (p === 'alt') labels.push(mac ? '⌥' : 'Alt')
    else labels.push(p.length === 1 ? p.toUpperCase() : p)
  }
  return mac ? labels.join('') : labels.join('+')
}
