/**
 * Registry that lets non-terminal components (e.g. the AI panel) read the
 * recent on-screen output of a given terminal tab without holding a direct
 * reference to the xterm instance.
 */
type OutputReader = (maxLines?: number) => string

const readers = new Map<string, OutputReader>()

export function registerTerminal(tabId: string, reader: OutputReader): void {
  readers.set(tabId, reader)
}

export function unregisterTerminal(tabId: string): void {
  readers.delete(tabId)
}

export function readTerminalOutput(tabId: string | null | undefined, maxLines = 40): string {
  if (!tabId) return ''
  const reader = readers.get(tabId)
  return reader ? reader(maxLines) : ''
}
