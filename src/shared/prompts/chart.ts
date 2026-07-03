/**
 * All chart/diagram related prompts and intent detection.
 *
 * The chart pipeline is two-phase: the copilot first emits a short free-text
 * chart description inside a ```chart fence (nudged by CHART_TURN_NUDGE), then a
 * separate constrained call turns that description into a strict ChartSpec JSON
 * object (CHART_SPEC_SYSTEM_PROMPT). CHART_INTENT / MERMAID_INTENT decide which
 * turns need the extra authoring rules injected.
 */

/**
 * Phase-2 system prompt: turn a free-text chart description into a STRICT
 * ChartSpec JSON object. Used with the provider's structured-output mode
 * (json_schema preferred, json_object fallback), so the response is JSON only —
 * the model must emit the object and nothing else.
 */
export const CHART_SPEC_SYSTEM_PROMPT = `You convert a short description of a desired chart (plus an optional sample of recent terminal output) into a ChartSpec JSON object that drives an ECharts renderer over streaming/buffered terminal text.

Output rules:
- Output ONLY the JSON object — no prose, no markdown, no code fences. The whole response is a single JSON value.
- Shape: { "title"?: string, "type": "line"|"bar"|"pie"|"scatter", "mode": "live"|"static", "x": "time"|"index"|string, "maxPoints": number, "series": [ ... ] } with at least one series.
- "mode": "live" subscribes to the bound terminal's real-time stream (best for vmstat/top/ping/iostat/free streaming); "static" parses the current terminal buffer once (best for one-shot output like du/df).
- "x": "time" (timestamp per point, best for live), "index" (running point index), or a label string.
- "maxPoints": rolling-window cap on retained points (default 60; use ~30 for pies/bars).
- Each series extracts ONE numeric value per matching output line and MUST contain a "name" plus EXACTLY ONE extractor — either "column" OR "regex". Never emit a series with only a name.
  - PREFERRED for tabular tools (vmstat, top, free, iostat, df, sar, mpstat, netstat): use "column". Data rows are whitespace-separated positional columns and the label appears ONLY in a header row, so an inline-label regex will never match a data row. Set "column" to the header label (e.g. "id" for vmstat CPU idle, "free" for free memory) — the renderer resolves the header's column index automatically — or to a 0-based field index (number).
  - Use "regex" (a JavaScript regex source, "group" = capture group index, default 1) ONLY when the value is inline-labeled on each line (e.g. ping "time=12.3 ms" → "regex": "time=([0-9.]+)").
- DERIVED metrics: do NOT invent an extra series for a computed value — every series MUST have a real "column" or "regex". To plot a value derived from one column, add a "transform": a simple arithmetic expression of x (the extracted value), using only digits, x, + - * / % and parentheses. Example: CPU usage from vmstat idle = { "name": "usage", "column": "id", "transform": "100 - x" }. Emit exactly ONE such series, never a second column-less series.
- vmstat: \`vmstat 1\` columns are "r b swpd free buff cache si so bi bo in cs us sy id wa st"; CPU idle is the "id" column. For CPU idle use { "name": "idle", "column": "id" }; for CPU usage use { "name": "usage", "column": "id", "transform": "100 - x" }.
- BREAKDOWN charts (pie / category bar of a distribution, e.g. disk usage by directory): each output line becomes its own slice/bar. Emit exactly ONE breakdown series that captures BOTH a value AND a per-line label.
  - PREFERRED: positional columns. Set "column" to the 0-based field index of the numeric value and "labelColumn" to the 0-based field index where the label starts (taken through end of line, so paths with spaces stay intact). Sizes like "3.0M"/"1.2G"/"73%" are parsed automatically. For \`du -h\` (lines "SIZE<TAB>PATH"): { "name": "size", "column": 0, "labelColumn": 1 }.
  - Else use "regex" with TWO groups: "group" for the value and "labelGroup" for the label.
- JSON escaping for regex: a single backslash must be written as \\\\ (e.g. \\\\d, \\\\s).
- For fields you do not use, set them to null (do not invent values).`

/** Phase-2 user message: the free-text chart description to convert into JSON. */
export function buildChartSpecUserMessage(description: string): string {
  return `Produce the ChartSpec JSON for this chart description:\n${description}`
}

/**
 * Live-chart intent. `chart` requests are special-cased in the chat loop: with
 * function-calling enabled, small local models overwhelmingly prefer running the
 * collection command as a tool/bash over emitting the ```chart fence, so the
 * two-phase renderer never starts.
 */
export const CHART_INTENT =
  /折线图|柱状图|饼图|散点图|条形图|曲线图?|图表|实时图|可视化|画(个|成|张|一)?图|chart|plot|graph|visuali[sz]e/i

/**
 * Mermaid diagram intent. Used to decide whether to inject the (long) mermaid
 * authoring rules into the system prompt for a turn; unlike charts it needs no
 * @terminal binding and may be produced on any turn (e.g. after investigating).
 */
export const MERMAID_INTENT =
  /流程图|时序图|顺序图|架构图|关系图|状态图|类图|甘特图|泳道|拓扑图|mermaid|flowchart|sequence\s*diagram|diagram|\bUML\b/i

/**
 * First-turn-only instruction that forces the chart-block format when the user
 * asked to visualize terminal output. Appended as the trailing user message
 * with tools disabled; empirically this makes even a small local model reliably
 * emit the ```chart fence instead of running the command directly. The explicit
 * template matters — a plain instruction loses to the large tool-oriented
 * system prompt that pushes bare bash blocks.
 */
export const CHART_TURN_NUDGE = `[CHART MODE — overrides the general output rules for THIS reply]
The user asked to VISUALIZE terminal output. Do NOT just print a bash command as the answer. Your reply MUST contain a fenced block tagged EXACTLY \`chart\` FIRST, then a separate \`bash\` block.
The \`chart\` block body is ONE short sentence describing: chart type (line/bar/pie/scatter), live or static, the source command, and per series the column header/field index (or inline value) to plot, plus any transform (e.g. CPU usage = 100 - id).

The \`bash\` block MUST be a SINGLE simple command whose plain text output the app parses line by line — the columns it prints MUST match what the chart block references.
FORBIDDEN in the command: \`watch\`, \`while\`/\`for\` loops, \`awk\`/\`sed\`/\`cut\` post-processing, subshells, and full-screen/interactive tools (\`top\` without \`-b\`, \`htop\`). Emit the raw tool so its native columns stream through unmodified.
Use these canonical commands unless the user clearly needs another tool:
- CPU: \`vmstat 1\` (idle = the "id" column; CPU usage = 100 - id).
- Memory: \`free -m -s 1\` (parse the "Mem:" row; "used" is field index 2, "total" is 1, "available" is 6).
- Disk latency / IO: \`iostat -x 1\`.
- Ping latency: \`ping <host>\` (regex time=([0-9.]+)).
- Disk usage breakdown (static pie/bar): \`du -h --max-depth=1 <path> | sort -rh | head -15\`.

Template — fill in and adapt, keep the fences:
\`\`\`chart
<实时/静态><折线/柱状/饼/散点>图：<指标>，数据来自 <命令> 的 <列名/字段>，<变换如 使用率 = 100 - id>，x 轴按时间，保留最近 60 个点。
\`\`\`
\`\`\`bash
<the collection command>
\`\`\`
A reply without a \`chart\` block, or whose \`bash\` command uses watch/loops/awk, is WRONG.`
