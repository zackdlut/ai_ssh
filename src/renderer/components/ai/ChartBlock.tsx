import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { parseChartSpec, type ChartSpec } from '../../lib/chartSpec'
import { createLineSplitter, extractValue, stripAnsi } from '../../lib/streamParse'
import { readTerminalOutput } from '../../lib/terminalRegistry'
import { useThemeStore } from '../../store/themeStore'

interface Props {
  /** Raw JSON body of the ```chart fence. */
  spec: string
  /** SSH session id bound via @terminal (for live mode). */
  boundSessionId?: string
  /** Tab id bound via @terminal (for reading the buffer in static mode). */
  boundTabId?: string
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
}

const LIVE_FLUSH_MS = 200

function compileSeries(spec: ChartSpec): CompiledSeries[] {
  return spec.series.map((s) => {
    const compiled: CompiledSeries = {
      name: s.name,
      regex: s.regex ? new RegExp(s.regex) : undefined,
      group: s.group ?? 1
    }
    if (typeof s.column === 'number') compiled.columnIndex = s.column
    else if (typeof s.column === 'string') compiled.columnName = s.column.toLowerCase()
    return compiled
  })
}

/** Build an ECharts option from the spec and current per-series points. */
function buildOption(spec: ChartSpec, series: CompiledSeries[], data: Point[][]): echarts.EChartsOption {
  const useTime = spec.x === 'time'
  const axisName = spec.x === 'time' || spec.x === 'index' ? undefined : spec.x

  if (spec.type === 'pie') {
    return {
      title: spec.title ? { text: spec.title, left: 'center', textStyle: { fontSize: 13 } } : undefined,
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, type: 'scroll' },
      series: [
        {
          type: 'pie',
          radius: ['35%', '68%'],
          center: ['50%', '46%'],
          data: series.map((s, i) => ({
            name: s.name,
            value: data[i]?.length ? data[i][data[i].length - 1][1] : 0
          }))
        }
      ]
    }
  }

  const cartesianType = spec.type === 'bar' ? 'bar' : spec.type === 'scatter' ? 'scatter' : 'line'
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
      data: data[i] ?? []
    }))
  }
}

/** Render a live/static chart of terminal output, with a source fallback on error. */
export default function ChartBlock({ spec, boundSessionId, boundTabId }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const appTheme = useThemeStore((s) => s.theme)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const parsed = useMemo<{ spec?: ChartSpec; series?: CompiledSeries[]; err?: string }>(() => {
    try {
      const s = parseChartSpec(spec)
      return { spec: s, series: compileSeries(s) }
    } catch (e) {
      return { err: e instanceof Error ? e.message : String(e) }
    }
  }, [spec])

  useEffect(() => {
    setError(parsed.err ?? null)
  }, [parsed.err])

  useEffect(() => {
    if (!parsed.spec || !parsed.series || !containerRef.current) return
    const chartSpec = parsed.spec
    const series = parsed.series

    const chart = echarts.init(containerRef.current, appTheme === 'dawn' ? undefined : 'dark', {
      renderer: 'canvas'
    })
    chartRef.current = chart

    // Per-series rolling points and a running index for non-time x axes.
    const data: Point[][] = series.map(() => [])
    let index = 0
    let dirty = false
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const render = (): void => {
      chart.setOption(buildOption(chartSpec, series, data), { notMerge: true })
    }

    const scheduleFlush = (): void => {
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        if (dirty) {
          dirty = false
          render()
        }
      }, LIVE_FLUSH_MS)
    }

    const ingestLine = (line: string): void => {
      const clean = stripAnsi(line)
      if (!clean.trim()) return
      const tokens = clean.trim().split(/\s+/)

      // Resolve column indices for label-based series whenever a header row
      // containing the label token appears (e.g. vmstat's "… us sy id wa st").
      let isHeader = false
      for (const s of series) {
        if (!s.columnName) continue
        const idx = tokens.findIndex((t) => t.toLowerCase() === s.columnName)
        if (idx !== -1) {
          s.columnIndex = idx
          isHeader = true
        }
      }
      if (isHeader) return // header row carries no data point

      const x = chartSpec.x === 'time' ? Date.now() : index
      let matchedAny = false
      series.forEach((s, i) => {
        let v: number | null = null
        if (s.columnIndex != null) {
          const raw = tokens[s.columnIndex]
          const n = raw === undefined ? NaN : Number(raw)
          v = Number.isFinite(n) ? n : null
        } else if (s.regex) {
          v = extractValue(clean, s.regex, s.group)
        }
        if (v === null) return
        matchedAny = true
        const arr = data[i]
        arr.push([x, v])
        if (arr.length > chartSpec.maxPoints) arr.splice(0, arr.length - chartSpec.maxPoints)
      })
      if (matchedAny) {
        if (chartSpec.x !== 'time') index++
        dirty = true
      }
    }

    render()

    let unsub: (() => void) | undefined
    if (chartSpec.mode === 'static') {
      // Parse the current terminal buffer once.
      const snapshot = readTerminalOutput(boundTabId, 2000)
      for (const line of snapshot.split('\n')) ingestLine(line)
      if (dirty) {
        dirty = false
        render()
      }
    } else if (boundSessionId) {
      const splitter = createLineSplitter()
      unsub = window.api.ssh.onData((e) => {
        if (e.sessionId !== boundSessionId) return
        splitter.push(e.data, ingestLine)
        scheduleFlush()
      })
    }

    const resizeObserver = new ResizeObserver(() => chart.resize())
    resizeObserver.observe(containerRef.current)

    return () => {
      if (flushTimer) clearTimeout(flushTimer)
      unsub?.()
      resizeObserver.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [parsed.spec, parsed.series, appTheme, boundSessionId, boundTabId])

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(spec)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const isLive = parsed.spec?.mode === 'live'
  const waitingForBinding = isLive && !boundSessionId

  return (
    <div className={`preview-block ${error ? 'has-error' : ''}`}>
      <div className="preview-toolbar">
        <span className="preview-label">
          Chart{parsed.spec ? ` · ${parsed.spec.mode === 'live' ? '实时' : '快照'}` : ''}
        </span>
        <button className="preview-btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {error ? (
        <div className="preview-error">
          <div className="preview-error-msg">无法渲染该图表配置：{error}</div>
          <pre>{spec}</pre>
        </div>
      ) : (
        <>
          {waitingForBinding && (
            <div className="chart-hint">
              未绑定终端。请在输入中使用 @terminal 引用当前终端，再让图表订阅其实时输出。
            </div>
          )}
          <div className="chart-canvas" ref={containerRef} />
          {isLive && boundSessionId && (
            <div className="chart-hint">实时图表：在绑定的终端中运行采集命令即可持续刷新。</div>
          )}
        </>
      )}
    </div>
  )
}
