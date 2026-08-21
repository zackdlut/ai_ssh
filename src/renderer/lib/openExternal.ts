import { sanitizeExternalUrl } from '../../shared/externalUrl'

/** Ask the main process to open a URL with the OS default application. */
export function openExternalUrl(raw: string): void {
  const url = sanitizeExternalUrl(raw)
  if (!url) return
  void window.api.app.openExternal(url)
}

function hrefFromAnchor(anchor: Element): string | null {
  return anchor.getAttribute('href') || anchor.getAttribute('xlink:href')
}

/**
 * Capture-phase click handler: any `<a href="https://…">` (markdown, mermaid,
 * about dialog, …) opens in the corresponding OS app instead of navigating
 * this window.
 */
export function handleExternalLinkClick(event: Event): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const anchor = target.closest('a')
  if (!anchor) return
  const href = hrefFromAnchor(anchor)
  if (!href || !sanitizeExternalUrl(href)) return
  event.preventDefault()
  event.stopPropagation()
  openExternalUrl(href)
}

export function bindExternalLinkClicks(root: EventTarget = document): () => void {
  root.addEventListener('click', handleExternalLinkClick, true)
  return () => root.removeEventListener('click', handleExternalLinkClick, true)
}
