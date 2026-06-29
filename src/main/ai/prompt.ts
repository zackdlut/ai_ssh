import { COPILOT_SYSTEM_PROMPT } from '../../shared/copilotPrompts'

/**
 * System prompt that turns the model into a terminal copilot.
 * It is asked to explain briefly and to emit any runnable shell commands
 * inside fenced ```bash code blocks so the renderer can extract them into
 * actionable command cards (kubectl-ai style).
 */
export const SYSTEM_PROMPT = COPILOT_SYSTEM_PROMPT

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

/**
 * System prompt for the in-terminal natural-language mode. Unlike the chat
 * copilot, this asks the model to emit ONLY the runnable command(s) with no
 * prose, so the terminal can extract and execute them directly.
 */
export const TRANSLATE_SYSTEM_PROMPT = `You translate a user's natural-language intent into the exact shell command(s) to run on a remote Linux/Unix host over SSH.

Strict output rules:
- Output ONLY runnable shell commands, each inside a fenced code block tagged bash. One command (or one short pipeline) per code block, e.g.:
\`\`\`bash
ss -ltnp 'sport = :8080'
\`\`\`
- Output NO prose, NO explanation, NO comments, NO example output. Code blocks only.
- If multiple steps are needed, emit multiple bash code blocks in execution order.
- Prefer the safest command that satisfies the intent. Do not add destructive flags unless the intent explicitly requires them.
- Assume commands run in the user's current shell on the connected host.
- If the intent is unclear or cannot be turned into a command, output a single bash code block containing only: echo "无法解析该意图，请换种说法"`

/**
 * System prompt for summarizing command execution results back to the user in
 * the in-terminal NL mode. The model receives the original intent plus each
 * executed command and its output, and must judge whether the intent was met.
 */
export const SUMMARIZE_SYSTEM_PROMPT = `你是嵌入 SSH 终端的助手。用户用自然语言提出了请求，系统据此执行了一条或多条 shell 命令并捕获了输出。

请像直接回复提问者那样作答：
- 用简体中文，简明扼要，通常 1-2 句话；只有确有必要时才分点。
- 直接给出结论或关键信息（数字、状态、进程、路径等），不要复述命令或原始输出。
- 不要使用「总结」「执行结果」之类的措辞，也不要使用 Markdown 代码块；就当成在回答用户的问题。
- 若命令失败（退出码非 0）或输出异常，用一句话说明原因并给出简短建议。`

/** Summarize older Copilot chat turns to fit within the context budget. */
export const HISTORY_SUMMARY_SYSTEM_PROMPT = `你是 SSH 终端 Copilot 的对话压缩助手。用户与助手的较早对话即将超出模型的上下文窗口，你需要把这段对话压缩成简短摘要，供后续轮次继续参考。

要求：
- 用简体中文，控制在 500–800 tokens 以内（尽量精炼）。
- 保留：用户的主要目标与意图、已提议或执行的 shell 命令、关键结论与错误信息、尚未解决的问题或待办。
- 不要输出 Markdown 代码块；可用简短列表。
- 不要编造对话中未出现的内容。`

export { buildContextMessage } from '../../shared/terminalContext'
