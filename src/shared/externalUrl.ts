/** Protocols handed to the OS default application (browser, mail client, …). */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'ftp:', 'tel:'])

/**
 * Return a canonical URL that is safe to pass to `shell.openExternal`, or
 * `null` when the string is not an allowed absolute URL.
 *
 * Relative paths, `javascript:`, `file:`, and other custom schemes are rejected
 * so a crafted link cannot navigate the app or launch an unexpected handler.
 */
export function sanitizeExternalUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol.toLowerCase())) return null
  return parsed.href
}

const URL_RE = /\b(?:https?|ftp):\/\/[^\s<>"'`]+|\bmailto:[^\s<>"'`]+|\btel:[^\s<>"'`]+/gi
const TRAILING_PUNCT = /[),.;:!?\]}'"]+$/

function stripTrailingPunctuation(url: string): string {
  return url.replace(TRAILING_PUNCT, '')
}

export interface ExternalUrlPart {
  text: string
  href?: string
}

/** Split text so plain `http://…` (and similar) spans can be rendered as links. */
export function splitByExternalUrls(text: string): ExternalUrlPart[] {
  const parts: ExternalUrlPart[] = []
  const re = new RegExp(URL_RE.source, URL_RE.flags)
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const raw = stripTrailingPunctuation(match[0])
    const href = sanitizeExternalUrl(raw)
    if (match.index > last) parts.push({ text: text.slice(last, match.index) })
    if (href) {
      parts.push({ text: raw, href })
      last = match.index + raw.length
      re.lastIndex = last
    } else {
      parts.push({ text: match[0] })
      last = match.index + match[0].length
    }
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  if (parts.length === 0) parts.push({ text })
  return parts
}
