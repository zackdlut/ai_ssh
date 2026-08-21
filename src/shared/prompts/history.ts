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

/** Summarize older Copilot chat turns to fit within the context budget. */
export function buildHistorySummarySystemPrompt(locale: AppLocale): string {
  return locale === 'en' ? HISTORY_SUMMARY_EN : HISTORY_SUMMARY_ZH
}

/** User message wrapping the earlier conversation text to be compressed. */
export function buildHistoryCompressUserMessage(
  locale: AppLocale,
  conversationText: string
): string {
  const lead =
    locale === 'en'
      ? 'Compress the following earlier conversation:'
      : '请压缩以下较早的对话记录：'
  return `${lead}\n\n${conversationText}`
}
