/**
 * Schema + parser for the ```chart fenced blocks emitted by the AI copilot.
 * A chart spec describes how to turn terminal output lines into chart data:
 * each series carries a regex whose capture group yields one numeric value per
 * matching line.
 */

export type ChartType = 'line' | 'bar' | 'pie' | 'scatter'
export type ChartMode = 'live' | 'static'
/** X axis kind: timestamps, the running point index, or a category capture. */
export type ChartXKind = 'time' | 'index'

export interface ChartSeriesSpec {
  name: string
  /** Regex source (without delimiters) applied per line. Use for inline-labeled values. */
  regex?: string
  /** Capture group index to read the numeric value from (default 1). */
  group?: number
  /**
   * Positional column extraction for tabular tools (vmstat/top/free/iostat/df…)
   * whose data rows are whitespace-separated columns and whose label only
   * appears in a header row. Either a header label (e.g. "id") whose column
   * index is resolved from the header line, or a 0-based field index.
   */
  column?: string | number
  /**
   * Breakdown mode: turn EACH matching line into its own category (a pie slice
   * or a bar). This regex capture group yields the category label per line
   * (e.g. the directory path from `du`). Combine with `group`/`column` for the
   * value. Mutually informative with `labelColumn`.
   */
  labelGroup?: number
  /**
   * Breakdown mode via columns: the header label or 0-based field index that
   * yields the category label per line (e.g. the mount point from `df`).
   */
  labelColumn?: string | number
  /**
   * Optional arithmetic transform applied to the extracted numeric value `x`,
   * e.g. "100 - x" to turn vmstat's CPU idle ("id" column) into CPU usage.
   * Only digits, x, the operators + - * / %, parentheses and spaces are
   * allowed; anything else is ignored.
   */
  transform?: string
}

export interface ChartSpec {
  title?: string
  type: ChartType
  mode: ChartMode
  /** "time" | "index" | a capture-group name used as the x category. */
  x: ChartXKind | string
  maxPoints: number
  series: ChartSeriesSpec[]
}

const CHART_TYPES: ChartType[] = ['line', 'bar', 'pie', 'scatter']
const DEFAULT_MAX_POINTS = 60

/**
 * Escape lone backslashes that are not part of a valid JSON escape sequence.
 * Weak models frequently emit regexes like "\s+(\d+)" with single backslashes,
 * which is invalid JSON; this repairs them to "\\s+(\\d+)".
 */
function repairJson(text: string): string {
  return text.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
}

/** JSON.parse with a best-effort repair pass for common LLM escaping mistakes. */
export function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Fall through to the repaired attempt; let it throw if still invalid.
  }
  return JSON.parse(repairJson(text))
}

/**
 * Parse and validate a chart spec from raw JSON text. Throws an Error with a
 * human-readable message on malformed input so callers can show a fallback.
 */
export function parseChartSpec(jsonText: string): ChartSpec {
  let raw: unknown
  try {
    raw = parseJsonLoose(jsonText)
  } catch (e) {
    throw new Error(`图表配置不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('图表配置必须是一个 JSON 对象')
  }
  const obj = raw as Record<string, unknown>

  const type = obj.type
  if (typeof type !== 'string' || !CHART_TYPES.includes(type as ChartType)) {
    throw new Error(`type 必须是 ${CHART_TYPES.join(' / ')} 之一`)
  }

  const mode: ChartMode = obj.mode === 'static' ? 'static' : 'live'

  const x = typeof obj.x === 'string' && obj.x.trim() ? obj.x.trim() : 'time'

  let maxPoints = Number(obj.maxPoints)
  if (!Number.isFinite(maxPoints) || maxPoints <= 0) maxPoints = DEFAULT_MAX_POINTS
  maxPoints = Math.min(2000, Math.max(2, Math.round(maxPoints)))

  if (!Array.isArray(obj.series) || obj.series.length === 0) {
    throw new Error('series 至少需要一个序列')
  }
  const series: ChartSeriesSpec[] = obj.series.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`series[${i}] 必须是对象`)
    const so = s as Record<string, unknown>
    const name =
      typeof so.name === 'string' && so.name.trim() ? so.name.trim() : `series ${i + 1}`

    const hasRegex = typeof so.regex === 'string' && so.regex.trim().length > 0
    const hasColumn =
      (typeof so.column === 'string' && so.column.trim().length > 0) ||
      (typeof so.column === 'number' && Number.isFinite(so.column) && so.column >= 0)

    if (!hasRegex && !hasColumn) {
      throw new Error(`series[${i}] 需要提供 regex 或 column`)
    }

    if (hasRegex) {
      // Surface invalid regex early.
      try {
        void new RegExp(so.regex as string)
      } catch (e) {
        throw new Error(`series[${i}].regex 无效：${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // Structured-output specs set unused fields to null; treat null/undefined
    // as "unset" so e.g. a null labelGroup is NOT mistaken for breakdown mode.
    const group =
      so.group != null && Number.isFinite(Number(so.group))
        ? Math.max(0, Math.round(Number(so.group)))
        : 1
    const column = hasColumn
      ? typeof so.column === 'number'
        ? Math.max(0, Math.round(so.column))
        : (so.column as string).trim()
      : undefined

    const labelGroup =
      so.labelGroup != null && Number.isFinite(Number(so.labelGroup)) && Number(so.labelGroup) >= 0
        ? Math.round(Number(so.labelGroup))
        : undefined
    const hasLabelColumn =
      (typeof so.labelColumn === 'string' && so.labelColumn.trim().length > 0) ||
      (typeof so.labelColumn === 'number' && Number.isFinite(so.labelColumn) && so.labelColumn >= 0)
    const labelColumn = hasLabelColumn
      ? typeof so.labelColumn === 'number'
        ? Math.max(0, Math.round(so.labelColumn))
        : (so.labelColumn as string).trim()
      : undefined

    // Keep a transform only if it is a safe arithmetic expression of x.
    const transform =
      typeof so.transform === 'string' && /^[-+*/(). 0-9xX%]+$/.test(so.transform.trim())
        ? so.transform.trim()
        : undefined

    return {
      name,
      regex: hasRegex ? (so.regex as string) : undefined,
      group,
      column,
      labelGroup,
      labelColumn,
      transform
    }
  })

  return {
    title: typeof obj.title === 'string' ? obj.title : undefined,
    type: type as ChartType,
    mode,
    x: x as ChartXKind | string,
    maxPoints,
    series
  }
}
