/**
 * Prompts for the in-terminal natural-language mode. Unlike the chat copilot,
 * the translate step emits ONLY runnable command(s) with no prose so the
 * terminal can extract and execute them directly, and the summarize step turns
 * their captured output into a short answer for the user.
 *
 * Both steps are locale-aware: the answer the user reads (and the fallback the
 * terminal echoes) has to be in the app's language, or an English user gets a
 * Chinese reply from their own terminal.
 */
import type { AppLocale, CommandRun } from '../types'

/** Fallback echoed when the intent cannot be turned into a command at all. */
const TRANSLATE_FALLBACK: Record<AppLocale, string> = {
  zh: '无法解析该意图，请换种说法',
  en: 'Could not turn that into a command — try rephrasing'
}

/**
 * System prompt for the in-terminal natural-language mode: translate intent to
 * the exact runnable command(s), no prose.
 */
export function buildTranslateSystemPrompt(locale: AppLocale): string {
  return `You translate a user's natural-language intent into the exact shell command(s) to run on a remote Linux/Unix host over SSH.

Strict output rules:
- Output ONLY runnable shell commands, each inside a fenced code block tagged bash. One command (or one short pipeline) per code block, e.g.:
\`\`\`bash
ss -ltnp 'sport = :8080'
\`\`\`
- Output NO prose, NO explanation, NO comments, NO example output. Code blocks only.
- If multiple steps are needed, emit multiple bash code blocks in execution order.
- Prefer the safest command that satisfies the intent. Do not add destructive flags unless the intent explicitly requires them.
- Assume commands run in the user's current shell on the connected host. When the context includes a working directory, treat it as the shell cwd and prefer paths relative to it; do not assume the home directory.
- If the intent is unclear or cannot be turned into a command, output a single bash code block containing only: echo "${TRANSLATE_FALLBACK[locale]}"`
}

const SUMMARIZE_ZH = `你是嵌入 SSH 终端的助手。用户用自然语言提出了请求，系统据此执行了一条或多条 shell 命令并捕获了输出。

请像直接回复提问者那样作答：
- 用简体中文，简明扼要，通常 1-2 句话；只有确有必要时才分点。
- 直接给出结论或关键信息（数字、状态、进程、路径等），不要复述命令或原始输出。
- 不要使用「总结」「执行结果」之类的措辞，也不要使用 Markdown 代码块；就当成在回答用户的问题。
- 若命令失败（退出码非 0）或输出异常，用一句话说明原因并给出简短建议。`

const SUMMARIZE_EN = `You are an assistant embedded in an SSH terminal. The user made a request in natural language, and the app ran one or more shell commands on their behalf and captured the output.

Answer as if replying directly to the person who asked:
- Write in English, brief and to the point — usually 1-2 sentences. Use a list only when it genuinely helps.
- Lead with the conclusion or the key facts (numbers, status, processes, paths). Do not restate the command or echo the raw output.
- Do not use framing like "Summary" or "Execution result", and do not use Markdown code blocks; just answer the question.
- If a command failed (non-zero exit code) or the output looks wrong, say why in one sentence and give a short suggestion.`

/**
 * System prompt for summarizing command execution results back to the user in
 * the in-terminal NL mode. The model receives the original intent plus each
 * executed command and its output, and must judge whether the intent was met.
 */
export function buildSummarizeSystemPrompt(locale: AppLocale): string {
  return locale === 'en' ? SUMMARIZE_EN : SUMMARIZE_ZH
}

/** Max characters of one command's output included in the summarize prompt. */
const SUMMARIZE_OUTPUT_MAX = 1500

const SUMMARIZE_LABELS: Record<
  AppLocale,
  { command: string; exit: string; unknown: string; noOutput: string; output: string; request: string; runs: string }
> = {
  zh: {
    command: '命令',
    exit: '退出码',
    unknown: '未知',
    noOutput: '(无输出)',
    output: '输出',
    request: '用户的原始请求',
    runs: '执行情况'
  },
  en: {
    command: 'Command',
    exit: 'exit code',
    unknown: 'unknown',
    noOutput: '(no output)',
    output: 'Output',
    request: "User's original request",
    runs: 'What was executed'
  }
}

/**
 * User message for the summarize step: the original intent plus each executed
 * command with its exit code and (clamped) output.
 */
export function buildSummarizeUserMessage(
  locale: AppLocale,
  request: string,
  runs: readonly CommandRun[]
): string {
  const l = SUMMARIZE_LABELS[locale] ?? SUMMARIZE_LABELS.zh
  const runsText = runs
    .map((r, i) => {
      const code = r.code === null ? l.unknown : String(r.code)
      const output = (r.output || l.noOutput).slice(0, SUMMARIZE_OUTPUT_MAX)
      return `# ${l.command} ${i + 1} (${l.exit} ${code})\n$ ${r.command}\n${l.output}:\n${output}`
    })
    .join('\n\n')
  return `${l.request}:\n${request}\n\n${l.runs}:\n${runsText}`
}
