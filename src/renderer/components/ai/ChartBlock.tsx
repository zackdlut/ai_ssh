import { useEffect, useMemo, useRef, useState } from 'react'
import type { ECharts, EChartsCoreOption, EChartsOption } from 'echarts'
import { parseChartSpec, type ChartSpec } from '../../lib/chartSpec'
import { createLineSplitter, extractValue, parseHumanNumber, stripAnsi } from '../../lib/streamParse'
import { readTerminalOutput } from '../../lib/terminalRegistry'
import { isDangerous } from '../../lib/commands'
import { useThemeStore } from '../../store/themeStore'
import { useT } from '../../lib/i18n'
import type { ChartSnapshot } from '../../../shared/types'

type EchartsApi = typeof import('echarts/core')
let echartsPromise: Promise<EchartsApi> | null = null
async function loadEcharts(): Promise<EchartsApi> {
  if (!echartsPromise) {
    echartsPromise = Promise.all([
      import('echarts/core'),
      import('echarts/charts'),
      import('echarts/components'),
      import('echarts/renderers')
    ]).then(([core, charts, components, renderers]) => {
      core.use([
        charts.LineChart,
        charts.BarChart,
        charts.PieChart,
        charts.ScatterChart,
        components.TitleComponent,
        components.TooltipComponent,
        components.GridComponent,
        components.LegendComponent,
        renderers.CanvasRenderer
      ])
      return core
    })
  }
  return echartsPromise
}

interface Props {
  /**
   * Body of the ```chart fence. In the two-phase design this is normally a
   * free-text DESCRIPTION of the chart; a constrained request turns it into a
   * strict ChartSpec JSON. If the body already is valid spec JSON, it is used
   * directly (fast path) with no extra request.
   */
  spec: string
  /**
   * The collection command paired with this chart (the adjacent bash block).
   * When present and bound to a terminal, the chart auto-runs it to capture
   * data in real time instead of waiting for the user to run it manually.
   */
  command?: string
  /** SSH session id bound via @terminal (for live mode). */
  boundSessionId?: string
  /** Tab id bound via @terminal (for reading the buffer in static mode). */
  boundTabId?: string
  /** True while the assistant message is still streaming (description incomplete). */
  streaming?: boolean
  /** Persisted chart replay data (for archived / restored chats). */
  snapshot?: ChartSnapshot
  /** Called once chart data is captured so it can be replayed later. */
  onSnapshot?: (snapshot: ChartSnapshot) => void
}

/** One series' rolling points as [x, y]. */
type Point = [number, number]

interface CompiledSeries {
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
function compileTransform(expr?: string): ((x: number) => number) | undefined {
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

const LIVE_FLUSH_MS = 200
/** Static capture: parse once the bound terminal's output has been idle this long. */
const CAPTURE_IDLE_MS = 600
/** Static capture: hard cap so a never-quiet stream still parses what it has. */
const CAPTURE_TIMEOUT_MS = 15000
/** Control char sent to the bound session to stop a long-running live command. */
const INTERRUPT = '\x03'
/** Cap on how long phase-2 chart-spec generation may run before erroring.
 *  Generous because it may include a corrective retry against a slow local model. */
const CHART_GEN_TIMEOUT_MS = 90000

function resolveFromSpecJson(specJson: string): { spec: ChartSpec; series: CompiledSeries[] } | null {
  try {
    const spec = parseChartSpec(specJson)
    return { spec, series: compileSeries(spec) }
  } catch {
    return null
  }
}

function optionHasData(option: EChartsCoreOption): boolean {
  const series = Array.isArray(option.series) ? option.series : option.series ? [option.series] : []
  return series.some((s) => {
    const item = s as { data?: unknown }
    return Array.isArray(item.data) && item.data.length > 0
  })
}

function compileSeries(spec: ChartSpec): CompiledSeries[] {
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
    else if (typeof s.labelColumn === 'string') compiled.labelColumnName = s.labelColumn.toLowerCase()
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
function heuristicBreakdown(tokens: string[]): { value: number; label: string } | null {
  for (let i = 0; i < tokens.length; i++) {
    const v = parseHumanNumber(tokens[i])
    if (v == null || v < 0) continue
    const label = tokens.slice(i + 1).join(' ').trim()
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
function buildOption(
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
      title: spec.title ? { text: spec.title, left: 'center', textStyle: { fontSize: 13 } } : undefined,
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
      title: spec.title ? { text: spec.title, left: 'center', textStyle: { fontSize: 13 } } : undefined,
      tooltip: { trigger: 'axis' },
      legend: breakdownSeries.length > 1 ? { bottom: 0, type: 'scroll' } : undefined,
      grid: { left: 48, right: 16, top: spec.title ? 36 : 16, bottom: breakdownSeries.length > 1 ? 36 : 28 },
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

/** Render a live/static chart of terminal output, with a source fallback on error. */
export default function ChartBlock({
  spec,
  command,
  boundSessionId,
  boundTabId,
  streaming,
  snapshot,
  onSnapshot
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ECharts | null>(null)
  const snapshotSavedRef = useRef(!!snapshot?.option)
  /** Imperative (re)start of capture for the current chart instance. */
  const startRef = useRef<(() => void) | null>(null)
  /** Imperative stop of capture (live: also Ctrl-C the bound session). */
  const stopRef = useRef<(() => void) | null>(null)
  const appTheme = useThemeStore((s) => s.theme)
  const [copied, setCopied] = useState(false)
  /** Whether a live capture is currently streaming (drives Start/Stop UI). */
  const [running, setRunning] = useState(false)
  const t = useT()

  // Fast path: the block body already is a valid ChartSpec JSON. (Kept for
  // backward compatibility and as a no-network shortcut.)
  const direct = useMemo<ChartSpec | null>(() => {
    try {
      return parseChartSpec(spec)
    } catch {
      return null
    }
  }, [spec])

  // The resolved spec actually rendered. Seeded from snapshot / fast path so valid
  // specs render without a "generating" flash on first paint.
  const [resolved, setResolved] = useState<{ spec?: ChartSpec; series?: CompiledSeries[] }>(() => {
    if (snapshot?.spec) {
      const fromSnapshot = resolveFromSpecJson(snapshot.spec)
      if (fromSnapshot) return fromSnapshot
    }
    if (direct) return { spec: direct, series: compileSeries(direct) }
    return {}
  })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Persisted snapshot already has a resolved spec — skip network generation.
    if (snapshot?.spec) {
      const fromSnapshot = resolveFromSpecJson(snapshot.spec)
      if (fromSnapshot) {
        setResolved(fromSnapshot)
        setError(null)
      }
      return
    }
    // Direct JSON → render immediately.
    if (direct) {
      setResolved({ spec: direct, series: compileSeries(direct) })
      setError(null)
      return
    }
    // Free-text description → generate the strict spec via the constrained
    // request, but only once the description has finished streaming in.
    if (streaming) return
    let cancelled = false
    setError(null)
    setResolved({})
    const fail = (e: unknown): void => {
      if (!cancelled) setError(t('chart.genError', { error: e instanceof Error ? e.message : String(e) }))
    }
    // Guard against an out-of-date preload (e.g. dev HMR reloaded the renderer
    // but not the preload) where the IPC method is missing — surface an error
    // instead of throwing synchronously and hanging on the "generating" hint.
    if (typeof window.api?.ai?.chartSpec !== 'function') {
      fail(new Error('ai.chartSpec unavailable — restart the app to reload preload'))
      return
    }
    const recentOutput = readTerminalOutput(boundTabId, 80)
    // Don't spin forever if the request hangs (unreachable endpoint, model
    // never responds): time out and surface a retryable error.
    const timeout = setTimeout(() => fail(new Error(t('chart.genTimeout'))), CHART_GEN_TIMEOUT_MS)
    try {
      window.api.ai
        .chartSpec({ description: spec, context: recentOutput ? { recentOutput } : undefined })
        .then((res) => {
          if (cancelled) return
          clearTimeout(timeout)
          if (res.error || !res.spec) {
            setError(t('chart.genError', { error: res.error || 'empty response' }))
            return
          }
          try {
            const s = parseChartSpec(res.spec)
            setResolved({ spec: s, series: compileSeries(s) })
            onSnapshot?.({ spec: res.spec })
          } catch (e) {
            fail(e)
          }
        })
        .catch((e) => {
          clearTimeout(timeout)
          fail(e)
        })
    } catch (e) {
      clearTimeout(timeout)
      fail(e)
    }
    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direct, streaming, spec, boundTabId, snapshot?.spec])

  // Replay a persisted ECharts option (historical chats without terminal binding).
  useEffect(() => {
    if (!snapshot?.option || !containerRef.current) return
    const fromSnapshot = snapshot.spec ? resolveFromSpecJson(snapshot.spec) : null
    if (fromSnapshot) setResolved(fromSnapshot)

    let cancelled = false
    let chart: ECharts | null = null
    let resizeObserver: ResizeObserver | null = null
    let visibilityObserver: IntersectionObserver | null = null
    const el = containerRef.current

    void (async () => {
      const echarts = await loadEcharts()
      if (cancelled || !containerRef.current) return
      chart = echarts.init(el, appTheme === 'dawn' ? undefined : 'dark', {
        renderer: 'canvas'
      })
      chartRef.current = chart
      try {
        chart.setOption(JSON.parse(snapshot.option!) as EChartsOption, { notMerge: true })
      } catch {
        setError(t('chart.renderError', { error: 'invalid snapshot' }))
      }

      const resize = (): void => {
        if (containerRef.current && containerRef.current.clientWidth > 0) chart?.resize()
      }
      requestAnimationFrame(resize)
      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(el)
      visibilityObserver = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting) resize()
      })
      visibilityObserver.observe(el)
    })()

    return () => {
      cancelled = true
      visibilityObserver?.disconnect()
      resizeObserver?.disconnect()
      chart?.dispose()
      chartRef.current = null
    }
  }, [snapshot?.option, snapshot?.spec, appTheme, t])

  useEffect(() => {
    if (snapshot?.option) return
    if (!resolved.spec || !resolved.series || !containerRef.current) return
    const chartSpec = resolved.spec
    const series = resolved.series
    const cmd = command?.trim()
    const el = containerRef.current
    let cancelled = false
    let chart: ECharts | null = null
    let resizeObserver: ResizeObserver | null = null
    let visibilityObserver: IntersectionObserver | null = null

    void (async () => {
      const echarts = await loadEcharts()
      if (cancelled || !containerRef.current) return

    // Auto-run only a non-destructive collection command into the bound session,
    // and never while the assistant message (and thus the command) is still
    // streaming in.
    const autoRunOk = !!cmd && !!boundSessionId && !isDangerous(cmd) && !streaming
    // vmstat/iostat print a cumulative-since-boot first sample that dwarfs the
    // real-time deltas; for column-based live time series, drop that first row.
    const skipFirstDataRow =
      chartSpec.mode === 'live' &&
      chartSpec.x === 'time' &&
      (chartSpec.type === 'line' || chartSpec.type === 'scatter') &&
      !series.some((s) => s.isBreakdown) &&
      series.some((s) => s.columnIndex != null || s.columnName != null)

    chart = echarts.init(el, appTheme === 'dawn' ? undefined : 'dark', {
      renderer: 'canvas'
    })
    chartRef.current = chart
    const activeChart = chart

    // Per-series rolling points (time/index series) plus ordered category maps
    // (breakdown series: one label→value entry per matching line).
    const points: Point[][] = series.map(() => [])
    const cats: Map<string, number>[] = series.map(() => new Map())
    let index = 0
    let dirty = false
    let liveDataRows = 0
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const render = (): void => {
      activeChart.setOption(buildOption(chartSpec, series, points, cats), { notMerge: true })
    }

    const maybeSaveSnapshot = (): void => {
      if (!onSnapshot || snapshotSavedRef.current) return
      const option = activeChart.getOption() as EChartsCoreOption
      if (!optionHasData(option)) return
      snapshotSavedRef.current = true
      onSnapshot({
        spec: JSON.stringify(chartSpec),
        option: JSON.stringify(option)
      })
    }

    const renderAndMaybeSave = (): void => {
      render()
      maybeSaveSnapshot()
    }

    const resetData = (): void => {
      for (const arr of points) arr.length = 0
      for (const m of cats) m.clear()
      index = 0
      liveDataRows = 0
      dirty = false
    }

    const scheduleFlush = (): void => {
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        if (dirty) {
          dirty = false
          renderAndMaybeSave()
        }
      }, LIVE_FLUSH_MS)
    }

    const ingestLine = (line: string): void => {
      const clean = stripAnsi(line)
      if (!clean.trim()) return
      // Skip the echoed collection command (it is not a data row).
      if (cmd && clean.trim() === cmd) return
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
      if (isHeader) return // header row carries no data point

      // Breakdown (pie / category bar): every matching line is its own slice.
      const hasBreakdown = series.some((s) => s.isBreakdown)
      if (hasBreakdown) {
        let matchedAny = false
        series.forEach((s, i) => {
          if (!s.isBreakdown) return
          let value: number | null = null
          let label: string | null = null
          if (s.columnIndex != null) {
            value = parseHumanNumber(tokens[s.columnIndex])
            if (s.labelColumnIndex != null) {
              // The label is usually the trailing free-text field (a path,
              // mount point, process name…), so join from that column to the
              // end of the line — keeping paths/names with spaces intact.
              label =
                s.labelColumnIndex < tokens.length
                  ? tokens.slice(s.labelColumnIndex).join(' ')
                  : null
            }
          } else if (s.regex) {
            value = extractValue(clean, s.regex, s.group)
            if (s.labelGroup != null) label = s.regex.exec(clean)?.[s.labelGroup] ?? null
          }
          // Resilience net: a regex/implicit breakdown spec that fails to yield a
          // clean (value, label) — e.g. a model-emitted regex with no capture
          // groups — falls back to "first numeric token is the value, the rest
          // of the line is the label", which covers `du`/`df -h` style output.
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
          while (map.size > chartSpec.maxPoints) map.delete(map.keys().next().value as string)
          matchedAny = true
        })
        if (matchedAny) dirty = true
        return
      }

      // Time/index series: one point per data row across all series.
      const x = chartSpec.x === 'time' ? Date.now() : index
      const values = series.map((s) => {
        let v: number | null = null
        if (s.columnIndex != null) v = parseHumanNumber(tokens[s.columnIndex])
        else if (s.regex) v = extractValue(clean, s.regex, s.group)
        if (v === null) return null
        return s.transform ? s.transform(v) : v
      })
      const isDataRow = values.some((v) => v !== null)
      if (!isDataRow) return
      liveDataRows++
      // Drop vmstat/iostat's cumulative first sample.
      if (skipFirstDataRow && liveDataRows === 1) return
      values.forEach((v, i) => {
        if (v === null) return
        const arr = points[i]
        arr.push([x, v])
        if (arr.length > chartSpec.maxPoints) arr.splice(0, arr.length - chartSpec.maxPoints)
      })
      if (chartSpec.x !== 'time') index++
      dirty = true
    }

    render()

    // --- Capture controller ----------------------------------------------
    let unsub: (() => void) | undefined
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    let snapTimer: ReturnType<typeof setTimeout> | null = null
    // True when we issued a long-running live command we may need to Ctrl-C.
    let liveStarted = false

    const clearSubs = (): void => {
      unsub?.()
      unsub = undefined
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      if (snapTimer) {
        clearTimeout(snapTimer)
        snapTimer = null
      }
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
    }

    const sendCmd = (): void => {
      if (cmd && boundSessionId) window.api.ssh.write(boundSessionId, cmd + '\n')
    }

    // Live: subscribe to the stream and parse continuously. When `send` is true
    // the collection command is issued so data flows without a manual "Run";
    // when false we only listen (e.g. the user runs it themselves).
    const startLive = (send: boolean): void => {
      clearSubs()
      if (liveStarted && boundSessionId) window.api.ssh.write(boundSessionId, INTERRUPT)
      liveStarted = false
      resetData()
      render()
      if (!boundSessionId) return
      const splitter = createLineSplitter()
      unsub = window.api.ssh.onData((e) => {
        if (e.sessionId !== boundSessionId) return
        splitter.push(e.data, ingestLine)
        scheduleFlush()
      })
      if (send && cmd) {
        sendCmd()
        liveStarted = true
      }
    }

    const stopLive = (interrupt: boolean): void => {
      clearSubs()
      if (interrupt && liveStarted && boundSessionId) {
        window.api.ssh.write(boundSessionId, INTERRUPT)
      }
      liveStarted = false
    }

    // Static: capture ONLY this command's output (idle-bounded window) and parse
    // that, so the chart never picks up unrelated scrollback history.
    let captureBuf = ''
    const parseCaptured = (): void => {
      clearSubs()
      resetData()
      for (const line of stripAnsi(captureBuf).split('\n')) ingestLine(line)
      dirty = false
      renderAndMaybeSave()
    }
    const startStaticCapture = (): void => {
      clearSubs()
      captureBuf = ''
      resetData()
      render()
      if (!boundSessionId) return
      unsub = window.api.ssh.onData((e) => {
        if (e.sessionId !== boundSessionId) return
        captureBuf += e.data
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(parseCaptured, CAPTURE_IDLE_MS)
      })
      timeoutTimer = setTimeout(parseCaptured, CAPTURE_TIMEOUT_MS)
      sendCmd()
    }
    // Static fallback when there is no command to auto-run: parse the existing
    // buffer and re-parse when the bound terminal prints more (legacy behavior).
    const parseSnapshot = (): void => {
      clearSubs()
      resetData()
      const snapshot = readTerminalOutput(boundTabId, 2000)
      for (const line of snapshot.split('\n')) ingestLine(line)
      dirty = false
      renderAndMaybeSave()
      if (boundSessionId) {
        unsub = window.api.ssh.onData((e) => {
          if (e.sessionId !== boundSessionId) return
          if (snapTimer) clearTimeout(snapTimer)
          snapTimer = setTimeout(() => {
            resetData()
            const snap = readTerminalOutput(boundTabId, 2000)
            for (const line of snap.split('\n')) ingestLine(line)
            dirty = false
            renderAndMaybeSave()
          }, 500)
        })
      }
    }

    if (chartSpec.mode === 'static') {
      const run = autoRunOk ? startStaticCapture : parseSnapshot
      startRef.current = run
      stopRef.current = () => clearSubs()
      run()
      setRunning(false)
    } else {
      // Manual Start runs the command if there is one (user intent), even when
      // auto-run was gated (e.g. a destructive command); auto-run on mount only
      // sends for non-destructive commands.
      startRef.current = () => {
        startLive(!!cmd)
        setRunning(true)
      }
      stopRef.current = () => {
        stopLive(true)
        setRunning(false)
      }
      startLive(autoRunOk)
      setRunning(true)
    }

    const resize = (): void => {
      if (containerRef.current && containerRef.current.clientWidth > 0) chart?.resize()
    }
    requestAnimationFrame(resize)
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(el)
    visibilityObserver = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) resize()
    })
    visibilityObserver.observe(el)
    })()

    return () => {
      cancelled = true
      // Stop a runaway live command and tear everything down.
      stopRef.current?.()
      startRef.current = null
      stopRef.current = null
      visibilityObserver?.disconnect()
      resizeObserver?.disconnect()
      chart?.dispose()
      chartRef.current = null
    }
  }, [resolved.spec, resolved.series, appTheme, boundSessionId, boundTabId, command, streaming, snapshot?.option, onSnapshot])

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(spec)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const isLive = resolved.spec?.mode === 'live'
  const isStatic = resolved.spec?.mode === 'static'
  const waitingForBinding = isLive && !boundSessionId
  // Spec not ready yet: either still generating, or waiting for the streamed
  // description to finish before generation can start.
  const pending = !error && !resolved.spec && !snapshot?.option
  const cmd = command?.trim()
  const autoRunOk = !!cmd && !!boundSessionId && !isDangerous(cmd)
  // A bound live chart whose command is destructive needs an explicit Start.
  const needsManualStart = isLive && !!boundSessionId && !!cmd && !autoRunOk

  // Live hint reflects whether we auto-ran the command or are awaiting a manual
  // start; passive (no command) keeps the legacy "run it yourself" hint.
  const liveHint = !boundSessionId
    ? null
    : running
      ? autoRunOk
        ? t('chart.autoRunHint')
        : t('chart.liveHint')
      : needsManualStart
        ? t('chart.manualStartHint')
        : t('chart.stopped')

  return (
    <div className={`preview-block ${error ? 'has-error' : ''}`}>
      <div className="preview-toolbar">
        <span className="preview-label">
          {t('chart.label')}
          {resolved.spec
            ? ` · ${resolved.spec.mode === 'live' ? t('chart.live') : t('chart.snapshot')}`
            : ''}
        </span>
        {isLive && boundSessionId && !error && (
          <button
            className="preview-btn"
            onClick={() => {
              if (running) {
                stopRef.current?.()
                return
              }
              // Confirm before manually running a destructive command.
              if (cmd && isDangerous(cmd) && !window.confirm(t('chart.dangerStart', { command: cmd })))
                return
              startRef.current?.()
            }}
          >
            {running ? t('chart.stop') : needsManualStart ? t('chart.start') : t('chart.restart')}
          </button>
        )}
        {isStatic && !error && (
          <button className="preview-btn" onClick={() => startRef.current?.()}>
            {autoRunOk ? t('chart.recapture') : t('chart.refresh')}
          </button>
        )}
        <button className="preview-btn" onClick={copy}>
          {copied ? t('cmd.copied') : t('cmd.copy')}
        </button>
      </div>
      {error ? (
        <div className="preview-error">
          <div className="preview-error-msg">{error}</div>
          <pre>{spec}</pre>
        </div>
      ) : (
        <>
          {pending && <div className="chart-hint">{t('chart.generating')}</div>}
          {waitingForBinding && <div className="chart-hint">{t('chart.noBinding')}</div>}
          {!pending && <div className="chart-canvas" ref={containerRef} />}
          {isLive && liveHint && <div className="chart-hint">{liveHint}</div>}
          {isStatic && (
            <div className="chart-hint">
              {autoRunOk ? t('chart.staticAutoHint') : t('chart.staticHint')}
            </div>
          )}
        </>
      )}
    </div>
  )
}
