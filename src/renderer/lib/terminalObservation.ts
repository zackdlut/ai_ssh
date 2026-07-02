/**
 * Per-tab observed shell environment for the agent's Observe phase.
 *
 * Populated as a side effect of `exec_command` (which parses cwd + exit code
 * from the sentinel marker), this lets each turn's snapshot report the current
 * working directory, last command and its exit code WITHOUT re-running `pwd` —
 * structured state the model previously had to guess from raw buffer text.
 */
export interface TabObservation {
  cwd?: string
  lastCommand?: string
  /** Exit code of the last captured command, or null when unknown. */
  lastExitCode?: number | null
  /** Timestamp (ms) of the last observation. */
  at?: number
}

/** In-memory per-tab observations; not persisted (mirrors the loop's lifetime). */
const observations = new Map<string, TabObservation>()

export function setTabObservation(tabId: string, obs: TabObservation): void {
  const prev = observations.get(tabId) ?? {}
  observations.set(tabId, { ...prev, ...obs })
}

export function getTabObservation(tabId: string): TabObservation | undefined {
  return observations.get(tabId)
}

export function clearTabObservation(tabId: string): void {
  observations.delete(tabId)
}
