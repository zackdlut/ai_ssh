import { shell } from 'electron'
import { sanitizeExternalUrl } from '../shared/externalUrl'
import type { OpenExternalResult } from '../shared/types'

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Open an http(s)/mailto/… URL with the OS default application.
 * Invalid or disallowed schemes are ignored instead of navigating the app.
 */
export async function openExternalUrl(raw: unknown): Promise<OpenExternalResult> {
  if (typeof raw !== 'string') return { error: 'Invalid URL' }
  const url = sanitizeExternalUrl(raw)
  if (!url) return { error: 'URL is not allowed' }
  try {
    await shell.openExternal(url)
    return { ok: true }
  } catch (err) {
    return { error: errMessage(err) }
  }
}
