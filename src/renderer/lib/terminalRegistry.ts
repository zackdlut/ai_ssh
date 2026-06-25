/**
 * Registry that lets non-terminal components (e.g. the AI panel, tab bar)
 * interact with a terminal tab without holding a direct reference to the
 * xterm instance.
 */
type OutputReader = (maxLines?: number) => string
type NlToggle = () => void

const readers = new Map<string, OutputReader>()
const nlToggles = new Map<string, NlToggle>()

export function registerTerminal(tabId: string, reader: OutputReader): void {
  readers.set(tabId, reader)
}

export function unregisterTerminal(tabId: string): void {
  readers.delete(tabId)
  nlToggles.delete(tabId)
}

export function registerNlToggle(tabId: string, toggle: NlToggle): void {
  nlToggles.set(tabId, toggle)
}

export function toggleNlForTab(tabId: string): void {
  nlToggles.get(tabId)?.()
}

export function readTerminalOutput(tabId: string | null | undefined, maxLines = 40): string {
  if (!tabId) return ''
  const reader = readers.get(tabId)
  return reader ? reader(maxLines) : ''
}
