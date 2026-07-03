/**
 * Prompts for compressing older Copilot chat turns so the conversation stays
 * within the model's context budget.
 */

/** Summarize older Copilot chat turns to fit within the context budget. */
export const HISTORY_SUMMARY_SYSTEM_PROMPT = `你是 SSH 终端 Copilot 的对话压缩助手。用户与助手的较早对话即将超出模型的上下文窗口，你需要把这段对话压缩成简短摘要，供后续轮次继续参考。

要求：
- 用简体中文，控制在 500–800 tokens 以内（尽量精炼）。
- 保留：用户的主要目标与意图、已提议或执行的 shell 命令、关键结论与错误信息、尚未解决的问题或待办。
- 不要输出 Markdown 代码块；可用简短列表。
- 不要编造对话中未出现的内容。`

/** User message wrapping the earlier conversation text to be compressed. */
export function buildHistoryCompressUserMessage(conversationText: string): string {
  return `请压缩以下较早的对话记录：\n\n${conversationText}`
}
