import OpenAI from 'openai'
import type {
  AISettings,
  AIChatRequest,
  AITranslateRequest,
  AISummarizeRequest
} from '../../shared/types'
import {
  SYSTEM_PROMPT,
  TRANSLATE_SYSTEM_PROMPT,
  SUMMARIZE_SYSTEM_PROMPT,
  buildContextMessage
} from './prompt'

export interface StreamCallbacks {
  onChunk: (delta: string) => void
  onDone: (content: string) => void
  onError: (error: string) => void
}

function ollamaDirectAnswerBody(
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  return {
    model,
    messages,
    stream: false,
    // Ollama reasoning models (Qwen3, etc.) otherwise return empty `content`.
    ...({ reasoning_effort: 'none' } as Record<string, unknown>)
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
}

function ollamaDirectAnswerStreamBody(
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  maxTokens: number
): OpenAI.Chat.ChatCompletionCreateParamsStreaming {
  return {
    model,
    messages,
    stream: true,
    max_tokens: maxTokens,
    ...({ reasoning_effort: 'none' } as Record<string, unknown>)
  } as OpenAI.Chat.ChatCompletionCreateParamsStreaming
}

/** Read streamed text from OpenAI-compatible chunks (incl. Ollama `delta.reasoning`). */
function extractStreamDelta(part: OpenAI.Chat.ChatCompletionChunk): string {
  const delta = part.choices[0]?.delta
  if (!delta) return ''
  if (delta.content) return delta.content
  const extra = delta as { reasoning?: string; reasoning_content?: string }
  return extra.reasoning ?? extra.reasoning_content ?? ''
}

function extractMessageText(
  message: OpenAI.Chat.ChatCompletionMessage | undefined
): string {
  if (!message) return ''
  if (message.content) return message.content
  const extra = message as { reasoning?: string; reasoning_content?: string }
  return extra.reasoning ?? extra.reasoning_content ?? ''
}

/**
 * Thin wrapper around an OpenAI-compatible Chat Completions endpoint with
 * streaming support and per-request cancellation.
 */
export class AIProvider {
  private controllers = new Map<string, AbortController>()

  constructor(private getSettings: () => AISettings) {}

  async chat(req: AIChatRequest, cb: StreamCallbacks): Promise<void> {
    const settings = this.getSettings()
    if (!settings.apiKey) {
      cb.onError('AI is not configured. Set the API key in Settings.')
      return
    }

    const client = new OpenAI({
      apiKey: settings.apiKey,
      baseURL: normalizeBaseURL(settings.baseURL)
    })

    const controller = new AbortController()
    this.controllers.set(req.requestId, controller)

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT }
    ]
    const contextMessage = buildContextMessage(req.context)
    if (contextMessage) {
      messages.push({ role: 'system', content: contextMessage })
    }
    for (const m of req.messages) {
      messages.push({ role: m.role, content: m.content })
    }

    let full = ''
    try {
      const stream = await client.chat.completions.create(
        {
          model: settings.model || 'gpt-4o-mini',
          messages,
          stream: true
        },
        { signal: controller.signal }
      )

      for await (const part of stream) {
        const delta = extractStreamDelta(part)
        if (delta) {
          full += delta
          cb.onChunk(delta)
        }
      }
      cb.onDone(full)
    } catch (e) {
      if (controller.signal.aborted) {
        cb.onDone(full)
      } else {
        cb.onError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      this.controllers.delete(req.requestId)
    }
  }

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort()
    this.controllers.delete(requestId)
  }

  /**
   * One-shot, non-streaming translation of a natural-language intent into
   * shell command(s) for the in-terminal NL mode. Returns the raw model
   * content (bash code blocks) for the renderer to parse.
   */
  async translate(req: AITranslateRequest): Promise<string> {
    const settings = this.getSettings()
    if (!settings.apiKey) {
      throw new Error('AI is not configured. Set the API key in Settings.')
    }

    const client = new OpenAI({
      apiKey: settings.apiKey,
      baseURL: normalizeBaseURL(settings.baseURL)
    })

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT }
    ]
    const contextMessage = buildContextMessage(req.context)
    if (contextMessage) {
      messages.push({ role: 'system', content: contextMessage })
    }
    messages.push({ role: 'user', content: req.prompt })

    const completion = await client.chat.completions.create(
      ollamaDirectAnswerBody(settings.model || 'gpt-4o-mini', messages)
    )
    return extractMessageText(completion.choices[0]?.message)
  }

  /**
   * Stream a summary of command execution results back to the user in natural
   * language. Uses streaming so the terminal can render tokens as they arrive.
   */
  async summarize(req: AISummarizeRequest, cb: StreamCallbacks): Promise<void> {
    const settings = this.getSettings()
    if (!settings.apiKey) {
      cb.onError('AI is not configured. Set the API key in Settings.')
      return
    }

    const client = new OpenAI({
      apiKey: settings.apiKey,
      baseURL: normalizeBaseURL(settings.baseURL)
    })

    const controller = new AbortController()
    this.controllers.set(req.requestId, controller)

    const runsText = req.runs
      .map((r, i) => {
        const code = r.code === null ? '未知' : String(r.code)
        const output = (r.output || '(无输出)').slice(0, 1500)
        return `# 命令 ${i + 1}（退出码 ${code}）\n$ ${r.command}\n输出:\n${output}`
      })
      .join('\n\n')

    const userContent = `用户的原始请求：\n${req.request}\n\n执行情况：\n${runsText}`

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT }
    ]
    const contextMessage = buildContextMessage(req.context)
    if (contextMessage) {
      messages.push({ role: 'system', content: contextMessage })
    }
    messages.push({ role: 'user', content: userContent })

    let full = ''
    try {
      const stream = await client.chat.completions.create(
        ollamaDirectAnswerStreamBody(settings.model || 'gpt-4o-mini', messages, 256),
        { signal: controller.signal }
      )

      for await (const part of stream) {
        const delta = extractStreamDelta(part)
        if (delta) {
          full += delta
          cb.onChunk(delta)
        }
      }
      cb.onDone(full)
    } catch (e) {
      if (controller.signal.aborted) {
        cb.onDone(full)
      } else {
        cb.onError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      this.controllers.delete(req.requestId)
    }
  }
}

/**
 * The OpenAI SDK requests `${baseURL}/chat/completions`, and OpenAI-compatible
 * servers (OpenAI, DeepSeek, Ollama, vLLM, ...) expose that under a `/v1`
 * prefix. Append `/v1` when the configured URL omits a version segment so the
 * app works whether or not the user typed it.
 */
function normalizeBaseURL(raw: string): string | undefined {
  const url = (raw || '').trim().replace(/\/+$/, '')
  if (!url) return undefined
  if (/\/v\d+$/.test(url)) return url
  return `${url}/v1`
}
