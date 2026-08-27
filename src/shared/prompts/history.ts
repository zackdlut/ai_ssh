/**
 * Prompts for compressing older Copilot chat turns so the conversation stays
 * within the model's context budget.
 *
 * Locale matters more here than it looks: the summary is written back into the
 * conversation as an assistant message and replayed on every later turn, so a
 * summary in the wrong language keeps steering the model's replies to that
 * language for the rest of the task.
 */
import type { AppLocale } from '../types'

const HISTORY_SUMMARY_ZH = `你是 SSH 终端 Copilot 的对话压缩助手。用户与助手的较早对话即将超出模型的上下文窗口，你需要把这段对话压缩成简短摘要，供后续轮次继续参考。

要求：
- 用简体中文，控制在 500–800 tokens 以内（尽量精炼）。
- 保留：用户的主要目标与意图、已提议或执行的 shell 命令、关键结论与错误信息、尚未解决的问题或待办。
- 不要输出 Markdown 代码块；可用简短列表。
- 不要编造对话中未出现的内容。`

const HISTORY_SUMMARY_EN = `You compress conversations for an SSH terminal Copilot. The earlier turns between the user and the assistant are about to exceed the model's context window, so you must condense them into a short summary that later turns can keep referring to.

Requirements:
- Write in English, within 500-800 tokens (be as concise as you can).
- Keep: the user's main goal and intent, shell commands proposed or executed, key conclusions and error messages, and anything still unresolved or outstanding.
- Do not emit Markdown code blocks; short lists are fine.
- Do not invent anything that did not appear in the conversation.`

/**
 * Compressing the AGENT LOOP is a different job from compressing a chat.
 *
 * A chat summary may lose detail, because the user is still there to re-supply
 * it. A loop summary replaces the steps the agent will otherwise re-derive: if
 * it drops the exit code, the agent re-runs the command; if it drops the path
 * it edited, the agent edits the wrong file or the same one twice; if it
 * paraphrases the error, the agent diagnoses the paraphrase. So this prompt
 * asks for a record, not a narrative, and names the fields that must survive
 * verbatim.
 */
const LOOP_SUMMARY_ZH = `你在压缩一个 SSH 运维 Agent 的执行记录。后续轮次会把你的摘要当作"这些步骤已经做过"的唯一依据，因此摘要的作用是**避免重复劳动和重复犯错**，不是复述对话。

必须原样保留（宁可冗长，也不要丢）：
- 执行过的每条 shell 命令，及其 exit code（例如 \`systemctl restart nginx\` → exit 0）。
- 读取或修改过的文件绝对路径，以及备份路径。
- 错误信息与报错原文的关键片段，不要改写措辞。
- 已经确认成立的事实（版本号、端口、服务状态、配置项当前值）。
- 尚未完成的部分，以及下一步打算做什么。

可以丢弃：寒暄、推理过程、命令的完整输出（只留结论性的几行）。

格式：简短列表，中文，不要 Markdown 代码块，不要编造未出现过的内容。`

const LOOP_SUMMARY_EN = `You are compressing the execution record of an SSH operations agent. Later turns will treat your summary as the only evidence of what has already been done, so its job is to **prevent repeated work and repeated mistakes**, not to retell a conversation.

Preserve verbatim (err on the side of too much, never too little):
- Every shell command that ran, with its exit code (e.g. \`systemctl restart nginx\` → exit 0).
- Absolute paths of every file read or modified, and any backup paths.
- Error messages and the key fragments of error output, in their original wording.
- Facts already established (version numbers, ports, service states, current config values).
- What is still unfinished, and what the next step was going to be.

Drop: pleasantries, reasoning, and full command output (keep only the few conclusive lines).

Format: a short list, in English, no Markdown code blocks, and nothing that did not appear in the record.`

export type HistorySummaryMode = 'chat' | 'loop'

/** Summarize older Copilot turns to fit within the context budget. */
export function buildHistorySummarySystemPrompt(
  locale: AppLocale,
  mode: HistorySummaryMode = 'chat'
): string {
  if (mode === 'loop') return locale === 'en' ? LOOP_SUMMARY_EN : LOOP_SUMMARY_ZH
  return locale === 'en' ? HISTORY_SUMMARY_EN : HISTORY_SUMMARY_ZH
}

/** User message wrapping the earlier conversation text to be compressed. */
export function buildHistoryCompressUserMessage(
  locale: AppLocale,
  conversationText: string,
  mode: HistorySummaryMode = 'chat'
): string {
  const lead =
    mode === 'loop'
      ? locale === 'en'
        ? 'Compress the following execution record:'
        : '请压缩以下执行记录：'
      : locale === 'en'
        ? 'Compress the following earlier conversation:'
        : '请压缩以下较早的对话记录：'
  return `${lead}\n\n${conversationText}`
}
