import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { AppTheme } from '../../shared/types'

/** Page background per theme, mirroring --ink-900 in renderer/styles/global.css. */
const WINDOW_BACKGROUND: Record<AppTheme, string> = {
  aurora: '#0c0f18',
  dawn: '#f4f5f8'
}

/**
 * Window background for the persisted theme, read straight from the JSON file
 * that electron-store writes.
 *
 * `./store` is deliberately not used here: requiring `conf` costs ~150ms, which
 * would land on the critical path before the first window is created. Parsing
 * the file costs well under a millisecond. The value only decides which colour
 * the window paints before the renderer applies the theme itself, so a missing
 * or malformed file can safely fall back to the store's own default.
 */
export function readBootWindowBackground(): string {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'config.json'), 'utf8')
    const theme = (JSON.parse(raw) as { theme?: unknown }).theme
    return WINDOW_BACKGROUND[theme === 'aurora' ? 'aurora' : 'dawn']
  } catch {
    return WINDOW_BACKGROUND.dawn
  }
}
