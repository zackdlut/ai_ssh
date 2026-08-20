/**
 * Deterministic ChartSpec templates for the handful of collection commands that
 * cover almost every "plot my terminal output" request (vmstat, free, iostat,
 * ping, df, du).
 *
 * The general path asks the model a second time to turn the free-text chart
 * description into strict ChartSpec JSON. That round trip is where small local
 * models fail — they drop the extractor, mis-number a column, or never answer
 * within the timeout. When the paired command is one we know, the spec is fully
 * determined by the command plus which metric the description asks for, so we
 * build it locally and skip the request entirely.
 *
 * Every template is emitted as raw JSON and then run through `parseChartSpec`,
 * so a template that drifts out of spec fails exactly like a bad model answer.
 */
import { parseChartSpec, type ChartSpec } from './chartSpec'

export interface ChartTemplateMatch {
  /** Stable id of the matched template, for diagnostics and tests. */
  id: string
  /** Validated spec ready to render. */
  spec: ChartSpec
  /** The spec as JSON, for snapshot persistence. */
  json: string
}

const DEFAULT_MAX_POINTS = 60

const MEMORY = /内存|memory|\bmem\b|\bram\b/i
const IDLE = /空闲|闲置|\bidle\b/i
const AVAILABLE = /可用|available/i
const FREE_MEM = /空余|剩余|\bfree\b/i
const LATENCY = /延迟|时延|latency|\brtt\b/i
const STATIC = /静态|快照|一次性|snapshot|\bstatic\b/i
const PIE = /饼图|饼状|pie|占比|比例/i

/** Leading executable of the collection command, lower-cased. */
function commandName(command: string): string {
  const cleaned = command
    .trim()
    .replace(/^(sudo|env|nice|stdbuf)\s+(-\S+\s+)*/i, '')
    .split(/[|;&]/)[0]
    .trim()
  return (cleaned.split(/\s+/)[0] ?? '').toLowerCase()
}

/** Build and validate a spec, returning null if the template itself is broken. */
function build(id: string, raw: Record<string, unknown>): ChartTemplateMatch | null {
  const json = JSON.stringify(raw)
  try {
    return { id, spec: parseChartSpec(json), json }
  } catch {
    return null
  }
}

/**
 * `vmstat 1` columns are "r b swpd free buff cache si so bi bo in cs us sy id
 * wa st". Everything useful is a header-labelled column, so the extractor is a
 * column name and the renderer resolves its index from the header row.
 */
function vmstatTemplate(description: string): ChartTemplateMatch | null {
  const base = { type: 'line', mode: 'live', x: 'time', maxPoints: DEFAULT_MAX_POINTS }
  if (MEMORY.test(description)) {
    return build('vmstat.memory-free', {
      ...base,
      series: [{ name: 'free', column: 'free' }]
    })
  }
  // "CPU 空闲率" plots the idle column as-is; anything else (usage, load,
  // utilisation) is the complement of idle.
  if (IDLE.test(description)) {
    return build('vmstat.cpu-idle', {
      ...base,
      series: [{ name: 'idle', column: 'id' }]
    })
  }
  return build('vmstat.cpu-usage', {
    ...base,
    series: [{ name: 'usage', column: 'id', transform: '100 - x' }]
  })
}

/**
 * `free -m -s 1` repeats a header plus a "Mem:" and a "Swap:" row. A positional
 * column would pick up the Swap row too, so the extractor is anchored to the
 * Mem line by regex.
 */
function freeTemplate(description: string): ChartTemplateMatch | null {
  const base = { type: 'line', mode: 'live', x: 'time', maxPoints: DEFAULT_MAX_POINTS }
  // Mem: total used free shared buff/cache available
  if (AVAILABLE.test(description)) {
    return build('free.available', {
      ...base,
      series: [
        { name: 'available', regex: '^Mem:\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+(\\S+)' }
      ]
    })
  }
  if (FREE_MEM.test(description)) {
    return build('free.free', {
      ...base,
      series: [{ name: 'free', regex: '^Mem:\\s+\\S+\\s+\\S+\\s+(\\S+)' }]
    })
  }
  return build('free.used', {
    ...base,
    series: [{ name: 'used', regex: '^Mem:\\s+\\S+\\s+(\\S+)' }]
  })
}

/** `iostat -x 1` device rows carry a "%util" header column. */
function iostatTemplate(): ChartTemplateMatch | null {
  return build('iostat.util', {
    type: 'line',
    mode: 'live',
    x: 'time',
    maxPoints: DEFAULT_MAX_POINTS,
    series: [{ name: '%util', column: '%util' }]
  })
}

/** `ping host` prints an inline-labelled "time=12.3 ms" per reply. */
function pingTemplate(): ChartTemplateMatch | null {
  return build('ping.latency', {
    type: 'line',
    mode: 'live',
    x: 'time',
    maxPoints: DEFAULT_MAX_POINTS,
    series: [{ name: 'rtt', regex: 'time=([0-9.]+)' }]
  })
}

/**
 * `df -h` rows are "Filesystem Size Used Avail Use% Mounted-on", so the usage
 * percentage is field 4 and the mount point field 5 (taken through end of line
 * so mounts with spaces survive).
 */
function dfTemplate(description: string): ChartTemplateMatch | null {
  return build('df.usage', {
    type: PIE.test(description) ? 'pie' : 'bar',
    mode: 'static',
    x: 'mount',
    maxPoints: 30,
    series: [{ name: 'use%', column: 4, labelColumn: 5 }]
  })
}

/** `du -h --max-depth=1` prints "SIZE<TAB>PATH" — one slice per line. */
function duTemplate(description: string): ChartTemplateMatch | null {
  return build('du.breakdown', {
    type: PIE.test(description) ? 'pie' : 'bar',
    mode: 'static',
    x: 'path',
    maxPoints: 30,
    series: [{ name: 'size', column: 0, labelColumn: 1 }]
  })
}

/**
 * Resolve a chart description plus its paired collection command into a spec
 * without asking the model. Returns null when the command is not one of the
 * known collectors, or when the description explicitly asks for a mode the
 * template does not provide — the caller then falls back to model generation.
 */
export function matchChartTemplate(
  description: string,
  command: string | undefined
): ChartTemplateMatch | null {
  if (!command?.trim()) return null
  const desc = description ?? ''
  const name = commandName(command)

  switch (name) {
    case 'vmstat':
      // A one-shot `vmstat` (no interval) has nothing to stream.
      return /\d/.test(command) ? vmstatTemplate(desc) : null
    case 'free':
      return /-s\s*\d/.test(command) ? freeTemplate(desc) : null
    case 'iostat':
      return /\d/.test(command) ? iostatTemplate() : null
    case 'ping':
      return LATENCY.test(desc) || !STATIC.test(desc) ? pingTemplate() : null
    case 'df':
      return dfTemplate(desc)
    case 'du':
      return duTemplate(desc)
    default:
      return null
  }
}
