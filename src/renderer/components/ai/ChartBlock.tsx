import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ECharts } from 'echarts'
import { parseChartSpec, type ChartSpec } from '../../lib/chartSpec'
import { createIngestor, type IngestStats } from '../../lib/chartIngest'
import { matchChartTemplate } from '../../lib/chartTemplates'
import { createLineSplitter } from '../../lib/streamParse'
import { COPILOT_TERMINAL_MENTION_MAX_LINES, readTerminalOutput } from '../../lib/terminalRegistry'
import { isDangerous } from '../../lib/commands'
import { useThemeStore } from '../../store/themeStore'
import { useTabsStore } from '../../store/tabsStore'
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
   * strict ChartSpec JSON. If the body already is valid spec JSON, or the
   * paired command matches a known template, no extra request is made.
   */
  spec: string
  /**
   * The collection command paired with this chart (the adjacent bash block).
   * When present and bound to a terminal, the chart runs it on a private
   * sampler channel to capture data in real time.
   */
  command?: string
  /** SSH/WSL session id bound via @terminal (for running the sampler). */
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

const LIVE_FLUSH_MS = 200
/** Static capture: parse once the sampler output has been idle this long. */
const CAPTURE_IDLE_MS = 600
/** Static capture: hard cap so a never-quiet stream still parses what it has. */
const CAPTURE_TIMEOUT_MS = 15000
/** Cap on how long phase-2 chart-spec generation may run before erroring.
 *  Generous because it may include a corrective retry against a slow local model. */
const CHART_GEN_TIMEOUT_MS = 90000

/** Return the text unchanged when it parses as a ChartSpec, else null. */
function specJsonOrNull(text: string | undefined): string | null {
  if (!text?.trim()) return null
  try {
    parseChartSpec(text)
    return text
  } catch {
    return null
  }
}

/** Human-readable summary of what each series extracts, for the no-match hint. */
function describeExtractors(spec: ChartSpec): string {
  return spec.series
    .map((s) => {
      const how =
        s.column != null
          ? `column ${JSON.stringify(s.column)}`
          : s.regex
            ? `/${s.regex}/`
            : '—'
      return `${s.name} ← ${how}${s.transform ? ` (${s.transform})` : ''}`
    })
    .join(' · ')
}

/** Render a live/static chart of terminal output, with a source fallback on error. */
export default function ChartBlock({
  spec: source,
  command,
  boundSessionId,
  boundTabId,
  streaming,
  snapshot,
  onSnapshot
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ECharts | null>(null)
  /** Imperative (re)start of capture for the current chart instance. */
  const startRef = useRef<(() => void) | null>(null)
  /** Imperative stop of capture (live: also kills the sampler process). */
  const stopRef = useRef<(() => void) | null>(null)
  const appTheme = useThemeStore((s) => s.theme)
  const [copied, setCopied] = useState(false)
  /** Whether a live capture is currently streaming (drives Start/Stop UI). */
  const [running, setRunning] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)
  const [stats, setStats] = useState<IngestStats | null>(null)
  const t = useT()

  /**
   * The snapshot callback is recreated on every parent render, so it must never
   * reach an effect's dependency list: doing so tore down and restarted the
   * live capture on every unrelated store update.
   */
  const onSnapshotRef = useRef(onSnapshot)
  useEffect(() => {
    onSnapshotRef.current = onSnapshot
  })

  const cmd = command?.trim()

  /**
   * A spec we can resolve with no network round trip, in priority order: the
   * spec persisted with the message, a body that already is spec JSON, or a
   * template for a known collection command. Templates matter most — they turn
   * the common "plot CPU/memory/latency" requests into a deterministic spec
   * instead of a second model call that small models routinely fumble.
   */
  const localSpecJson = useMemo(() => {
    const persisted = specJsonOrNull(snapshot?.spec)
    if (persisted) return persisted
    const direct = specJsonOrNull(source)
    if (direct) return direct
    // The description and the paired command are both still arriving.
    if (streaming) return null
    return matchChartTemplate(source, cmd)?.json ?? null
  }, [snapshot?.spec, source, cmd, streaming])

  const [generatedJson, setGeneratedJson] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const specJson = localSpecJson ?? generatedJson
  // Derived deterministically from the JSON, so it is stable for as long as the
  // JSON is — which lets effects depend on the string instead of this object.
  const spec = useMemo<ChartSpec | null>(() => {
    if (!specJson) return null
    try {
      return parseChartSpec(specJson)
    } catch {
      return null
    }
  }, [specJson])

  // Phase 2: free-text description → strict spec, only when nothing local
  // resolved it and the description has finished streaming in.
  useEffect(() => {
    if (localSpecJson || streaming) return
    let cancelled = false
    setError(null)
    setGeneratedJson(null)
    const fail = (e: unknown): void => {
      if (!cancelled)
        setError(t('chart.genError', { error: e instanceof Error ? e.message : String(e) }))
    }
    // Guard against an out-of-date preload (e.g. dev HMR reloaded the renderer
    // but not the preload) where the IPC method is missing — surface an error
    // instead of throwing synchronously and hanging on the "generating" hint.
    if (typeof window.api?.ai?.chartSpec !== 'function') {
      fail(new Error('ai.chartSpec unavailable — restart the app to reload preload'))
      return
    }
    const recentOutput = readTerminalOutput(boundTabId, COPILOT_TERMINAL_MENTION_MAX_LINES)
    // Don't spin forever if the request hangs (unreachable endpoint, model
    // never responds): time out and surface a retryable error.
    const timeout = setTimeout(() => fail(new Error(t('chart.genTimeout'))), CHART_GEN_TIMEOUT_MS)
    window.api.ai
      .chartSpec({ description: source, context: recentOutput ? { recentOutput } : undefined })
      .then((res) => {
        if (cancelled) return
        clearTimeout(timeout)
        if (res.error || !res.spec) {
          setError(t('chart.genError', { error: res.error || 'empty response' }))
          return
        }
        try {
          parseChartSpec(res.spec)
          setGeneratedJson(res.spec)
        } catch (e) {
          fail(e)
        }
      })
      .catch((e) => {
        clearTimeout(timeout)
        fail(e)
      })
    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localSpecJson, streaming, source, boundTabId])

  // Persist the resolved spec so an archived chat can rebuild this chart
  // without another generation round trip. Writing it back makes localSpecJson
  // read from the snapshot next render, so the value stays stable.
  useEffect(() => {
    if (!specJson || snapshot?.spec === specJson) return
    onSnapshotRef.current?.({ spec: specJson })
  }, [specJson, snapshot?.spec])

  /**
   * The bound session must still be connected. A chat restored from disk keeps
   * the session id of a terminal that died with the previous app run, and
   * capturing against it would only produce "Session not found".
   */
  const sessionLive = useTabsStore(
    (s) =>
      !!boundSessionId &&
      s.tabs.some((tab) => tab.sessionId === boundSessionId && tab.status === 'connected')
  )
  /** Live capture is possible whenever a spec and a live terminal binding exist. */
  const canCapture = !!spec && sessionLive
  /**
   * Only a chart that can no longer collect anything (archived chat, terminal
   * closed) falls back to replaying its stored option. Previously the mere
   * EXISTENCE of a stored option disabled capture, so the first live data point
   * — which saved that option — permanently froze the chart.
   */
  const replayOnly = !canCapture && !!snapshot?.option
  const canvasVisible = !error && (!!spec || replayOnly)

  /** Bumped once a fresh ECharts instance is ready for the effects below. */
  const [chartEpoch, setChartEpoch] = useState(0)

  // --- Capture ----------------------------------------------------------
  // Declared BEFORE the effect that owns the ECharts instance so that on
  // unmount React runs this cleanup first, while the chart is still alive and
  // its final option can be serialized into the replay snapshot.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !spec || !canCapture || !canvasVisible) return

    const ingestor = createIngestor(spec, { command: cmd })
    const autoRunOk = !!cmd && !!boundSessionId && !isDangerous(cmd) && !streaming
    let dirty = false
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    let snapTimer: ReturnType<typeof setTimeout> | null = null
    let unsubData: (() => void) | undefined
    let unsubEnd: (() => void) | undefined
    /** Sampler currently owned by this effect, if any. */
    let samplerId: string | null = null

    const publishStats = (): void =>
      setStats({ ...ingestor.stats, unmatched: [...ingestor.stats.unmatched] })

    /** True until this effect's chart instance is replaced or disposed. */
    const chartAlive = (): boolean => chartRef.current === chart

    const render = (): void => {
      if (!chartAlive()) return
      chart.setOption(ingestor.buildOption(), { notMerge: true })
      publishStats()
    }

    /**
     * Persist what is on screen. Unlike before, this never runs mid-stream: a
     * store write re-renders the message, and doing that on every flush is what
     * used to restart (and then permanently disable) the live capture.
     */
    const saveSnapshot = (): void => {
      const save = onSnapshotRef.current
      if (!save || !specJson) return
      let option: string | undefined
      if (chartAlive() && ingestor.hasData()) {
        try {
          option = JSON.stringify(chart.getOption())
        } catch {
          option = undefined
        }
      }
      save({ spec: specJson, option })
    }

    const scheduleFlush = (): void => {
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        if (!dirty) return
        dirty = false
        render()
      }, LIVE_FLUSH_MS)
    }

    const clearTimers = (): void => {
      for (const timer of [flushTimer, idleTimer, timeoutTimer, snapTimer]) {
        if (timer) clearTimeout(timer)
      }
      flushTimer = idleTimer = timeoutTimer = snapTimer = null
    }

    const clearSubs = (): void => {
      unsubData?.()
      unsubEnd?.()
      unsubData = unsubEnd = undefined
      clearTimers()
    }

    const stopSampler = (): void => {
      if (!samplerId) return
      window.api.sampler.stop(samplerId)
      samplerId = null
    }

    /**
     * Run the collection command on its own channel. Nothing is written to the
     * user's shell, so there is also nothing to Ctrl-C when we stop.
     */
    const runSampler = (onChunk: (data: string) => void, onEnd?: () => void): boolean => {
      if (!cmd || !boundSessionId) return false
      const id = crypto.randomUUID()
      samplerId = id
      unsubData = window.api.sampler.onData((e) => {
        if (e.samplerId !== id) return
        onChunk(e.data)
      })
      unsubEnd = window.api.sampler.onEnd((e) => {
        if (e.samplerId !== id) return
        if (e.error) setError(t('chart.samplerError', { error: e.error }))
        if (samplerId === id) samplerId = null
        onEnd?.()
      })
      void window.api.sampler.start(boundSessionId, id, cmd).then((res) => {
        if (res.error) setError(t('chart.samplerError', { error: res.error }))
      })
      return true
    }

    const ingest = (line: string): void => {
      if (ingestor.ingestLine(line)) dirty = true
      scheduleFlush()
    }

    // --- Live -------------------------------------------------------------
    const startLive = (send: boolean): void => {
      clearSubs()
      stopSampler()
      ingestor.reset()
      render()
      const splitter = createLineSplitter()
      const feed = (data: string): void => splitter.push(data, ingest)
      if (send && runSampler(feed, () => setRunning(false))) return
      // Passive: no command to run (or auto-run was gated), so just listen to
      // the bound terminal in case the user runs the collector themselves.
      if (!boundSessionId) return
      unsubData = window.api.ssh.onData((e) => {
        if (e.sessionId !== boundSessionId) return
        feed(e.data)
      })
    }

    const stopLive = (): void => {
      clearSubs()
      stopSampler()
      saveSnapshot()
    }

    // --- Static -----------------------------------------------------------
    let captureBuf = ''
    const parseCaptured = (): void => {
      clearSubs()
      stopSampler()
      ingestor.reset()
      ingestor.ingestText(captureBuf)
      dirty = false
      render()
      saveSnapshot()
    }

    /** Capture ONLY this command's output so the chart never picks up unrelated scrollback. */
    const startStaticCapture = (): void => {
      clearSubs()
      stopSampler()
      captureBuf = ''
      ingestor.reset()
      render()
      const started = runSampler(
        (data) => {
          captureBuf += data
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(parseCaptured, CAPTURE_IDLE_MS)
        },
        // A one-shot collector (du/df) exits on its own — parse right away
        // instead of waiting out the idle window.
        () => parseCaptured()
      )
      if (started) timeoutTimer = setTimeout(parseCaptured, CAPTURE_TIMEOUT_MS)
    }

    /** No command to run: parse the terminal buffer and re-parse as it grows. */
    const parseSnapshot = (): void => {
      clearSubs()
      ingestor.reset()
      ingestor.ingestText(readTerminalOutput(boundTabId, 2000))
      dirty = false
      render()
      saveSnapshot()
      if (!boundSessionId) return
      unsubData = window.api.ssh.onData((e) => {
        if (e.sessionId !== boundSessionId) return
        if (snapTimer) clearTimeout(snapTimer)
        snapTimer = setTimeout(() => {
          ingestor.reset()
          ingestor.ingestText(readTerminalOutput(boundTabId, 2000))
          dirty = false
          render()
        }, 500)
      })
    }

    if (spec.mode === 'static') {
      const run = autoRunOk ? startStaticCapture : parseSnapshot
      startRef.current = run
      stopRef.current = () => {
        clearSubs()
        stopSampler()
      }
      run()
      setRunning(false)
    } else {
      // Manual Start runs the command even when auto-run was gated (a
      // destructive command); auto-run on mount only sends safe ones.
      startRef.current = () => {
        startLive(!!cmd)
        setRunning(true)
      }
      stopRef.current = () => {
        stopLive()
        setRunning(false)
      }
      startLive(autoRunOk)
      // A gated command is not running yet, so the button must offer Start
      // rather than Stop. Without a command we are passively listening, which
      // still counts as running.
      setRunning(autoRunOk || !cmd)
    }

    return () => {
      clearSubs()
      stopSampler()
      saveSnapshot()
      startRef.current = null
      stopRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartEpoch, specJson, canCapture, canvasVisible, boundSessionId, boundTabId, cmd, streaming])

  // --- Replay (archived chats) ------------------------------------------
  useEffect(() => {
    const chart = chartRef.current
    if (!replayOnly || !chart || !snapshot?.option) return
    try {
      chart.setOption(JSON.parse(snapshot.option), { notMerge: true })
    } catch {
      setError(t('chart.renderError', { error: 'invalid snapshot' }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartEpoch, replayOnly, snapshot?.option])

  // --- ECharts instance -------------------------------------------------
  // Owning nothing but the instance and its observers keeps the capture effect
  // free to restart without tearing down the canvas, and vice versa.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !canvasVisible) return
    let cancelled = false
    let chart: ECharts | null = null
    let resizeObserver: ResizeObserver | null = null
    let visibilityObserver: IntersectionObserver | null = null

    void (async () => {
      const echarts = await loadEcharts()
      if (cancelled || !containerRef.current) return
      chart = echarts.init(el, appTheme === 'dawn' ? undefined : 'dark', { renderer: 'canvas' })
      chartRef.current = chart

      const resize = (): void => {
        if (el.clientWidth > 0) chart?.resize()
      }
      requestAnimationFrame(resize)
      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(el)
      visibilityObserver = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting) resize()
      })
      visibilityObserver.observe(el)
      setChartEpoch((n) => n + 1)
    })()

    return () => {
      cancelled = true
      visibilityObserver?.disconnect()
      resizeObserver?.disconnect()
      chart?.dispose()
      chartRef.current = null
    }
  }, [appTheme, canvasVisible])

  const copy = useCallback(async (): Promise<void> => {
    await navigator.clipboard.writeText(source)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }, [source])

  const isLive = spec?.mode === 'live'
  const isStatic = spec?.mode === 'static'
  // A live chart with no reachable terminal and nothing to replay has nowhere
  // to get data from.
  const waitingForBinding = isLive && !sessionLive && !replayOnly
  // Spec not ready yet: either still generating, or waiting for the streamed
  // description to finish before generation can start.
  const pending = !error && !spec && !replayOnly
  const autoRunOk = !!cmd && sessionLive && !isDangerous(cmd)
  // A bound live chart whose command is destructive needs an explicit Start.
  const needsManualStart = isLive && sessionLive && !!cmd && !autoRunOk

  const liveHint = !sessionLive
    ? null
    : running
      ? autoRunOk
        ? t('chart.autoRunHint')
        : t('chart.liveHint')
      : needsManualStart
        ? t('chart.manualStartHint')
        : t('chart.stopped')

  const noMatch = !!stats && stats.linesReceived > 0 && stats.pointsPlotted === 0

  return (
    <div className={`preview-block ${error ? 'has-error' : ''}`}>
      <div className="preview-toolbar">
        <span className="preview-label">
          {t('chart.label')}
          {spec ? ` · ${isLive ? t('chart.live') : t('chart.snapshot')}` : ''}
        </span>
        {isLive && sessionLive && !error && (
          <button
            className="preview-btn"
            onClick={() => {
              if (running) {
                stopRef.current?.()
                return
              }
              // Confirm before manually running a destructive command.
              if (
                cmd &&
                isDangerous(cmd) &&
                !window.confirm(t('chart.dangerStart', { command: cmd }))
              )
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
        <button className="preview-btn" onClick={() => void copy()}>
          {copied ? t('cmd.copied') : t('cmd.copy')}
        </button>
      </div>
      {error ? (
        <div className="preview-error">
          <div className="preview-error-msg">{error}</div>
          <pre>{source}</pre>
        </div>
      ) : (
        <>
          {pending && <div className="chart-hint">{t('chart.generating')}</div>}
          {waitingForBinding && <div className="chart-hint">{t('chart.noBinding')}</div>}
          {canvasVisible && <div className="chart-canvas" ref={containerRef} />}
          {isLive && liveHint && <div className="chart-hint">{liveHint}</div>}
          {isStatic && (
            <div className="chart-hint">
              {autoRunOk ? t('chart.staticAutoHint') : t('chart.staticHint')}
            </div>
          )}
          {stats && stats.linesReceived > 0 && (
            <div className={`chart-hint ${noMatch ? 'chart-warn' : ''}`}>
              {t('chart.stats', { lines: stats.linesReceived, points: stats.pointsPlotted })}
              {noMatch && spec && (
                <>
                  {' '}
                  {t('chart.noMatch')}{' '}
                  <button
                    type="button"
                    className="chart-raw-toggle"
                    onClick={() => setRawOpen((o) => !o)}
                  >
                    {t('chart.showRaw')}
                  </button>
                  {rawOpen && (
                    <pre className="chart-raw">
                      {t('chart.matchRule', { rules: describeExtractors(spec) })}
                      {'\n'}
                      {stats.unmatched.join('\n')}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
