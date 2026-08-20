/**
 * Pure parsing core behind the terminal-output charts: compiles a ChartSpec
 * into per-series matchers, turns raw output lines into rolling points (time /
 * index series) or category maps (pie / bar breakdowns), and builds the ECharts
 * option. Deliberately free of React and of the ECharts runtime so the whole
 * extraction path can be unit-tested against real command output.
 */
import type { EChartsOption } from 'echarts'
import type { ChartSpec } from './chartSpec'
import { extractValue, parseHumanNumber, stripAnsi } from './streamParse'

/** One series' rolling points as [x, y]. */
export type Point = [number, number]

export interface CompiledSeries {
  name: string
  regex?: RegExp
  group: number
  /** Lower-cased header label to resolve a column index from a header row. */
  columnName?: string
  /** Resolved/explicit 0-based column index for positional extraction. */
  columnIndex?: number
  /** Regex capture group for the per-line category label (breakdown mode). */
  labelGroup?: number
  /** Lower-cased header label to resolve the label column from a header row. */
  labelColumnName?: string
  /** Resolved/explicit 0-based column index for the category label. */
  labelColumnIndex?: number
  /** True when each matching line becomes its own category (slice/bar). */
  isBreakdown: boolean
  /** Allow the generic value+label fallback (regex/implicit breakdown only). */
  heuristic: boolean
  /** Compiled arithmetic transform applied to the extracted value (e.g. 100 - x). */
  transform?: (x: number) => number
}

/**
 * Compile a series' arithmetic transform (e.g. "100 - x") into a function.
 * The expression is whitelisted to digits, x, + - * / %, parens and spaces, so
 * building a Function from it cannot reach anything else. Returns undefined for
 * an empty/invalid/non-numeric expression (the raw value is then used as-is).
 */
export function compileTransform(expr?: string): ((x: number) => number) | undefined {
  if (!expr) return undefined
  const cleaned = expr.replace(/X/g, 'x').replace(/%/g, '')
  if (!/^[-+*/(). 0-9x]+$/.test(cleaned) || !/x/.test(cleaned)) return undefined
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('x', `"use strict"; return (${cleaned});`) as (x: number) => number
    const probe = fn(1)
    if (typeof probe !== 'number' || !Number.isFinite(probe)) return undefined
    return (x: number) => {
      const r = fn(x)
      return typeof r === 'number' && Number.isFinite(r) ? r : x
    }
  } catch {
    return undefined
  }
}

export function compileSeries(spec: ChartSpec): CompiledSeries[] {
  return spec.series.map((s) => {
    const isBreakdown = s.labelGroup != null || s.labelColumn != null
    const compiled: CompiledSeries = {
      name: s.name,
      regex: s.regex ? new RegExp(s.regex) : undefined,
      group: s.group ?? 1,
      isBreakdown,
      // Only regex/implicit breakdowns get the heuristic fallback; explicit
      // column layouts are trusted to skip non-data lines as intended.
      heuristic: isBreakdown && s.column == null && s.labelColumn == null,
      transform: compileTransform(s.transform)
    }
    if (typeof s.column === 'number') compiled.columnIndex = s.column
    else if (typeof s.column === 'string') compiled.columnName = s.column.toLowerCase()
    if (typeof s.labelGroup === 'number') compiled.labelGroup = s.labelGroup
    if (typeof s.labelColumn === 'number') compiled.labelColumnIndex = s.labelColumn
    else if (typeof s.labelColumn === 'string')
      compiled.labelColumnName = s.labelColumn.toLowerCase()
    return compiled
  })
}

/**
 * Generic breakdown parse for value+label lines like `du`/`df -h` output:
 * the first non-negative numeric token is the value, the tokens AFTER it are
 * the label. Returns null when the line has no usable (value, label) pair —
 * which conveniently skips echoed commands and prompts (their leading tokens
 * are non-numeric, and trailing flags like "-15" are negative/label-less).
 */
export function heuristicBreakdown(tokens: string[]): { value: number; label: string } | null {
  for (let i = 0; i < tokens.length; i++) {
    const v = parseHumanNumber(tokens[i])
    if (v == null || v < 0) continue
    const label = tokens
      .slice(i + 1)
      .join(' ')
      .trim()
    if (label) return { value: v, label }
  }
  return null
}

/** Ordered union of category labels across the breakdown series. */
function unionLabels(series: CompiledSeries[], cats: Map<string, number>[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  series.forEach((s, i) => {
    if (!s.isBreakdown) return
    for (const label of cats[i].keys()) {
      if (!seen.has(label)) {
        seen.add(label)
        out.push(label)
      }
    }
  })
  return out
}

/**
 * Build an ECharts option from the spec and current state. Time/index series
 * accumulate `points` ([x, y]); breakdown series accumulate `cats` (label →
 * value), one category per matching line.
 */
export function buildChartOption(
  spec: ChartSpec,
  series: CompiledSeries[],
  points: Point[][],
  cats: Map<string, number>[]
): EChartsOption {
  const useTime = spec.x === 'time'
  const axisName = spec.x === 'time' || spec.x === 'index' ? undefined : spec.x
  const hasBreakdown = series.some((s) => s.isBreakdown)

  if (spec.type === 'pie') {
    // Breakdown: every matching line is its own slice. Otherwise fall back to
    // the legacy "one slice per series, latest value" behaviour.
    const data = hasBreakdown
      ? series.flatMap((s, i) =>
          s.isBreakdown ? [...cats[i]].map(([name, value]) => ({ name, value })) : []
        )
      : series.map((s, i) => ({
          name: s.name,
          value: points[i]?.length ? points[i][points[i].length - 1][1] : 0
        }))
    return {
      title: spec.title
        ? { text: spec.title, left: 'center', textStyle: { fontSize: 13 } }
        : undefined,
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, type: 'scroll' },
      series: [
        {
          type: 'pie',
          radius: ['35%', '68%'],
          center: ['50%', '46%'],
          data
        }
      ]
    }
  }

  const cartesianType = spec.type === 'bar' ? 'bar' : spec.type === 'scatter' ? 'scatter' : 'line'

  // Breakdown bar/line/scatter: categorical x axis, one value per label.
  if (hasBreakdown) {
    const labels = unionLabels(series, cats)
    const breakdownSeries = series.filter((s) => s.isBreakdown)
    return {
      title: spec.title
        ? { text: spec.title, left: 'center', textStyle: { fontSize: 13 } }
        : undefined,
      tooltip: { trigger: 'axis' },
      legend: breakdownSeries.length > 1 ? { bottom: 0, type: 'scroll' } : undefined,
      grid: {
        left: 48,
        right: 16,
        top: spec.title ? 36 : 16,
        bottom: breakdownSeries.length > 1 ? 36 : 28
      },
      xAxis: { type: 'category', data: labels, name: axisName },
      yAxis: { type: 'value', scale: true },
      series: series.flatMap((s, i) =>
        s.isBreakdown
          ? [
              {
                name: s.name,
                type: cartesianType,
                data: labels.map((l) => cats[i].get(l) ?? null)
              }
            ]
          : []
      )
    }
  }

  return {
    title: spec.title ? { text: spec.title, left: 'center', textStyle: { fontSize: 13 } } : undefined,
    tooltip: { trigger: 'axis' },
    legend: series.length > 1 ? { bottom: 0, type: 'scroll' } : undefined,
    grid: { left: 48, right: 16, top: spec.title ? 36 : 16, bottom: series.length > 1 ? 36 : 28 },
    xAxis: {
      type: useTime ? 'time' : 'value',
      name: axisName,
      scale: !useTime
    },
    yAxis: { type: 'value', scale: true },
    series: series.map((s, i) => ({
      name: s.name,
      type: cartesianType,
      showSymbol: cartesianType !== 'line',
      smooth: cartesianType === 'line',
      data: points[i] ?? []
    }))
  }
}

/**
 * vmstat/iostat print a cumulative-since-boot first sample that dwarfs the
 * real-time deltas, so a column-based live time series drops that first row.
 */
export function shouldSkipFirstDataRow(spec: ChartSpec, series: CompiledSeries[]): boolean {
  return (
    spec.mode === 'live' &&
    spec.x === 'time' &&
    (spec.type === 'line' || spec.type === 'scatter') &&
    !series.some((s) => s.isBreakdown) &&
    series.some((s) => s.columnIndex != null || s.columnName != null)
  )
}

/** How many unmatched sample lines are retained for the diagnostics panel. */
export const MAX_UNMATCHED_SAMPLES = 6

export interface IngestStats {
  /** Non-empty lines fed to the ingestor. */
  linesReceived: number
  /** Lines recognised as header rows (used to resolve column indices). */
  headerLines: number
  /** Data points actually appended across all series. */
  pointsPlotted: number
  /** A few lines that yielded no value, for diagnosing a wrong column/regex. */
  unmatched: string[]
}

export interface IngestorOptions {
  /**
   * The collection command. Its echo in the captured stream is not a data row,
   * so a line equal to it is skipped outright.
   */
  command?: string
}

export interface Ingestor {
  readonly spec: ChartSpec
  readonly series: CompiledSeries[]
  readonly points: Point[][]
  readonly cats: Map<string, number>[]
  readonly stats: IngestStats
  /** Feed one raw line. Returns true when it produced chartable data. */
  ingestLine(line: string): boolean
  /** Feed a whole blob, splitting on newlines. Returns true if anything matched. */
  ingestText(text: string): boolean
  buildOption(): EChartsOption
  hasData(): boolean
  reset(): void
}

/**
 * Create a stateful line ingestor for one chart spec. Column indices declared
 * by header label are resolved lazily from the first header row that contains
 * the label, so tools whose layout varies by version (vmstat, df, iostat) still
 * line up.
 */
export function createIngestor(spec: ChartSpec, opts: IngestorOptions = {}): Ingestor {
  const series = compileSeries(spec)
  const points: Point[][] = series.map(() => [])
  const cats: Map<string, number>[] = series.map(() => new Map())
  const skipFirst = shouldSkipFirstDataRow(spec, series)
  const cmd = opts.command?.trim()

  const stats: IngestStats = {
    linesReceived: 0,
    headerLines: 0,
    pointsPlotted: 0,
    unmatched: []
  }
  let index = 0
  let dataRows = 0

  const noteUnmatched = (line: string): void => {
    if (stats.unmatched.length >= MAX_UNMATCHED_SAMPLES) return
    stats.unmatched.push(line)
  }

  const ingestLine = (line: string): boolean => {
    const clean = stripAnsi(line)
    if (!clean.trim()) return false
    stats.linesReceived++
    // Skip the echoed collection command (it is not a data row).
    if (cmd && clean.trim() === cmd) return false
    const tokens = clean.trim().split(/\s+/)

    // Resolve column indices for label-based series whenever a header row
    // containing the label token appears (e.g. vmstat's "… us sy id wa st",
    // or df's "Filesystem Size Used Avail Use% Mounted on").
    let isHeader = false
    for (const s of series) {
      if (s.columnName) {
        const idx = tokens.findIndex((t) => t.toLowerCase() === s.columnName)
        if (idx !== -1) {
          s.columnIndex = idx
          isHeader = true
        }
      }
      if (s.labelColumnName) {
        const idx = tokens.findIndex((t) => t.toLowerCase() === s.labelColumnName)
        if (idx !== -1) {
          s.labelColumnIndex = idx
          isHeader = true
        }
      }
    }
    if (isHeader) {
      stats.headerLines++
      return false // header row carries no data point
    }

    // Breakdown (pie / category bar): every matching line is its own slice.
    if (series.some((s) => s.isBreakdown)) {
      let matchedAny = false
      series.forEach((s, i) => {
        if (!s.isBreakdown) return
        let value: number | null = null
        let label: string | null = null
        if (s.columnIndex != null) {
          value = parseHumanNumber(tokens[s.columnIndex])
          if (s.labelColumnIndex != null) {
            // The label is usually the trailing free-text field (a path, mount
            // point, process name…), so join from that column to the end of the
            // line — keeping paths/names with spaces intact.
            label =
              s.labelColumnIndex < tokens.length ? tokens.slice(s.labelColumnIndex).join(' ') : null
          }
        } else if (s.regex) {
          value = extractValue(clean, s.regex, s.group)
          if (s.labelGroup != null) label = s.regex.exec(clean)?.[s.labelGroup] ?? null
        }
        // Resilience net: a regex/implicit breakdown spec that fails to yield a
        // clean (value, label) — e.g. a model-emitted regex with no capture
        // groups — falls back to "first numeric token is the value, the rest of
        // the line is the label", which covers `du`/`df -h` style output.
        if (s.heuristic && (value == null || !label)) {
          const h = heuristicBreakdown(tokens)
          if (h) {
            value = h.value
            label = h.label
          }
        }
        if (value == null || !label) return
        // Drop the `du --max-depth` grand-total ("." / "./"): it equals the sum
        // of the other slices and would double the pie.
        const trimmedLabel = label.trim()
        if (trimmedLabel === '.' || trimmedLabel === './') return
        if (s.transform) value = s.transform(value)
        const map = cats[i]
        map.delete(trimmedLabel) // re-insert so the newest entries stay at the tail
        map.set(trimmedLabel, value)
        while (map.size > spec.maxPoints) map.delete(map.keys().next().value as string)
        stats.pointsPlotted++
        matchedAny = true
      })
      if (!matchedAny) noteUnmatched(clean)
      return matchedAny
    }

    // Time/index series: one point per data row across all series.
    const x = spec.x === 'time' ? Date.now() : index
    const values = series.map((s) => {
      let v: number | null = null
      if (s.columnIndex != null) v = parseHumanNumber(tokens[s.columnIndex])
      else if (s.regex) v = extractValue(clean, s.regex, s.group)
      if (v === null) return null
      return s.transform ? s.transform(v) : v
    })
    if (!values.some((v) => v !== null)) {
      noteUnmatched(clean)
      return false
    }
    dataRows++
    // Drop vmstat/iostat's cumulative first sample.
    if (skipFirst && dataRows === 1) return false
    values.forEach((v, i) => {
      if (v === null) return
      const arr = points[i]
      arr.push([x, v])
      if (arr.length > spec.maxPoints) arr.splice(0, arr.length - spec.maxPoints)
      stats.pointsPlotted++
    })
    if (spec.x !== 'time') index++
    return true
  }

  return {
    spec,
    series,
    points,
    cats,
    stats,
    ingestLine,
    ingestText(text: string): boolean {
      let matched = false
      for (const line of stripAnsi(text).split('\n')) {
        if (ingestLine(line)) matched = true
      }
      return matched
    },
    buildOption: () => buildChartOption(spec, series, points, cats),
    hasData: () =>
      points.some((p) => p.length > 0) || cats.some((c) => c.size > 0),
    reset(): void {
      for (const arr of points) arr.length = 0
      for (const m of cats) m.clear()
      index = 0
      dataRows = 0
      stats.linesReceived = 0
      stats.headerLines = 0
      stats.pointsPlotted = 0
      stats.unmatched.length = 0
    }
  }
}
