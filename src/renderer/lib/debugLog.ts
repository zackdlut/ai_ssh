import type { DebugLogPayload } from '../../shared/debugLog'

/** Fire-and-forget debug log entry to the main-process NDJSON logger. */
export function debugLog(entry: DebugLogPayload): void {
  try {
    window.api?.debug?.log(entry)
  } catch {
    // ignore if preload bridge is unavailable
  }
}
