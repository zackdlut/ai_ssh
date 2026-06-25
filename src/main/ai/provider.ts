import OpenAI from 'openai'
import type { AISettings, AIChatRequest } from '../../shared/types'
import { SYSTEM_PROMPT, buildContextMessage } from './prompt'

export interface StreamCallbacks {
  onChunk: (delta: string) => void
  onDone: (content: string) => void
  onError: (error: string) => void
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
        const delta = part.choices[0]?.delta?.content ?? ''
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
