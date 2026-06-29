import type OpenAI from 'openai'

type OpenAIConstructor = typeof import('openai').default
let openaiCtor: OpenAIConstructor | null = null

async function loadOpenAI(): Promise<OpenAIConstructor> {
  if (!openaiCtor) {
    const mod = await import('openai')
    openaiCtor = mod.default
  }
  return openaiCtor
}
import { resolveActiveModel, resolveModel } from '../../shared/aiSettings'
import { AI_TOOLS } from '../../shared/aiTools'
import type {
  AISettings,
  AIChatRequest,
  AIChartSpecRequest,
  AITranslateRequest,
  AISummarizeRequest,
  AICompressHistoryRequest,
  ChatMessageDTO,
  ToolCallDTO
} from '../../shared/types'
import {
  SYSTEM_PROMPT,
  CHART_SPEC_SYSTEM_PROMPT,
  TRANSLATE_SYSTEM_PROMPT,
  SUMMARIZE_SYSTEM_PROMPT,
  HISTORY_SUMMARY_SYSTEM_PROMPT,
  buildContextMessage
} from './prompt'

/**
 * JSON Schema for the ChartSpec, used with the provider's strict structured
 * output. Optional fields are nullable (strict mode requires every property to
 * be listed in `required`); the renderer treats null as "unset".
 */
const CHART_SPEC_JSON_SCHEMA = {
  name: 'chart_spec',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'type', 'mode', 'x', 'maxPoints', 'series'],
    properties: {
      title: { type: ['string', 'null'] },
      type: { type: 'string', enum: ['line', 'bar', 'pie', 'scatter'] },
      mode: { type: 'string', enum: ['live', 'static'] },
      x: { type: 'string' },
      maxPoints: { type: 'integer' },
      series: {
        type: 'array',
        // Each series MUST carry an extractor: anyOf forces either a non-null
        // "column" (column branch) or a non-null "regex" (regex branch), so the
        // model cannot leave both null and produce an unrenderable series.
        items: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'column', 'regex', 'group', 'labelColumn', 'labelGroup', 'transform'],
              properties: {
                name: { type: 'string' },
                column: { type: ['string', 'integer'] },
                regex: { type: 'null' },
                group: { type: ['integer', 'null'] },
                labelColumn: { type: ['string', 'integer', 'null'] },
                labelGroup: { type: ['integer', 'null'] },
                transform: { type: ['string', 'null'] }
              }
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'column', 'regex', 'group', 'labelColumn', 'labelGroup', 'transform'],
              properties: {
                name: { type: 'string' },
                column: { type: 'null' },
                regex: { type: 'string' },
                group: { type: ['integer', 'null'] },
                labelColumn: { type: ['string', 'integer', 'null'] },
                labelGroup: { type: ['integer', 'null'] },
                transform: { type: ['string', 'null'] }
              }
            }
          ]
        }
      }
    }
  }
} as const

export interface StreamCallbacks {
  onChunk: (delta: string) => void
  /** Streamed reasoning/thinking tokens, kept separate from the answer body. */
  onReasoning?: (delta: string) => void
  onDone: (content: string, toolCalls?: ToolCallDTO[]) => void
  onError: (error: string) => void
}

/**
 * Map our wire-format chat messages (which may carry tool calls / tool results)
 * to the OpenAI SDK message params. Assistant turns with `tool_calls` and
 * `role:'tool'` results are reconstructed so a multi-turn function-calling
 * conversation can be replayed to the model.
 */
function toSdkMessages(
  history: ChatMessageDTO[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return history.map((m) => {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments }
        }))
      } as OpenAI.Chat.ChatCompletionAssistantMessageParam
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.tool_call_id ?? '',
        content: m.content
      } as OpenAI.Chat.ChatCompletionToolMessageParam
    }
    return { role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam
  })
}

/** Aggregate streamed `delta.tool_calls` fragments (indexed) into whole calls. */
interface ToolCallAccumulator {
  id: string
  name: string
  args: string
}

/** True when the text looks like it is meant to be a JSON object/array. */
function looksLikeJson(text: string): boolean {
  const t = text.trim()
  return t.startsWith('{') || t.startsWith('[')
}

/**
 * Lightweight semantic check (mirrors the renderer's parseChartSpec rules):
 * valid JSON, a non-empty series array, and every series carrying an extractor
 * (a non-null "column" or a non-empty "regex"). Used to decide whether the
 * generated spec needs a corrective retry — NOT to repair the JSON.
 */
function isCompleteChartSpec(text: string): boolean {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return false
  }
  if (!obj || typeof obj !== 'object') return false
  const series = (obj as { series?: unknown }).series
  if (!Array.isArray(series) || series.length === 0) return false
  return series.every((s) => {
    if (!s || typeof s !== 'object') return false
    const col = (s as { column?: unknown }).column
    const rgx = (s as { regex?: unknown }).regex
    const hasColumn =
      (typeof col === 'string' && col.trim().length > 0) ||
      (typeof col === 'number' && Number.isFinite(col) && col >= 0)
    const hasRegex = typeof rgx === 'string' && rgx.trim().length > 0
    return hasColumn || hasRegex
  })
}

function ollamaDirectAnswerBody(
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  maxTokens?: number
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  return {
    model,
    messages,
    stream: false,
    ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
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

/**
 * Split a streamed chunk into answer body (`content`) and reasoning tokens
 * (`reasoning`/`reasoning_content`, emitted by reasoning models like Qwen3).
 * Keeping them apart lets the renderer show a Cursor-style "thinking" block
 * without polluting the answer or the conversation history.
 */
function splitStreamDelta(part: OpenAI.Chat.ChatCompletionChunk): {
  content: string
  reasoning: string
} {
  const delta = part.choices[0]?.delta
  if (!delta) return { content: '', reasoning: '' }
  const extra = delta as { reasoning?: string; reasoning_content?: string }
  return {
    content: delta.content ?? '',
    reasoning: extra.reasoning ?? extra.reasoning_content ?? ''
  }
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

  private async createClient(): Promise<OpenAI> {
    const settings = this.getSettings()
    const OpenAIClient = await loadOpenAI()
    return new OpenAIClient({
      apiKey: settings.apiKey,
      baseURL: normalizeBaseURL(settings.baseURL)
    })
  }

  async chat(req: AIChatRequest, cb: StreamCallbacks): Promise<void> {
    const settings = this.getSettings()
    if (!settings.apiKey) {
      cb.onError('AI is not configured. Set the API key in Settings.')
      return
    }

    const client = await this.createClient()

    const controller = new AbortController()
    this.controllers.set(req.requestId, controller)

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT }
    ]
    const contextMessage = buildContextMessage(req.context)
    if (contextMessage) {
      messages.push({ role: 'system', content: contextMessage })
    }
    messages.push(...toSdkMessages(req.messages))

    const model = resolveActiveModel(settings)
    const baseBody = { model, messages, stream: true as const }
    const toolBody = {
      ...baseBody,
      tools: AI_TOOLS as unknown as OpenAI.Chat.ChatCompletionTool[],
      tool_choice: 'auto' as const
    }

    let full = ''
    const toolAcc = new Map<number, ToolCallAccumulator>()
    try {
      // Some OpenAI-compatible backends (older Ollama models, etc.) reject the
      // `tools` parameter; fall back to a plain streaming request so the chat
      // still works (it just won't be able to call functions).
      let stream: Awaited<ReturnType<typeof client.chat.completions.create>>
      try {
        stream = await client.chat.completions.create(
          req.enableTools ? toolBody : baseBody,
          { signal: controller.signal }
        )
      } catch (e) {
        if (req.enableTools && !controller.signal.aborted) {
          stream = await client.chat.completions.create(baseBody, {
            signal: controller.signal
          })
        } else {
          throw e
        }
      }

      for await (const part of stream as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>) {
        const { content, reasoning } = splitStreamDelta(part)
        // Reasoning is streamed to a separate channel and intentionally NOT
        // added to `full`, so it never leaks into the answer or the history.
        if (reasoning) cb.onReasoning?.(reasoning)
        if (content) {
          full += content
          cb.onChunk(content)
        }
        const deltaCalls = part.choices[0]?.delta?.tool_calls
        if (deltaCalls) {
          for (const tc of deltaCalls) {
            const idx = tc.index ?? 0
            const acc = toolAcc.get(idx) ?? { id: '', name: '', args: '' }
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            if (tc.function?.arguments) acc.args += tc.function.arguments
            toolAcc.set(idx, acc)
          }
        }
      }
      const toolCalls: ToolCallDTO[] = [...toolAcc.values()]
        .filter((t) => t.name)
        .map((t) => ({
          id: t.id || `call_${Math.random().toString(36).slice(2)}`,
          name: t.name,
          arguments: t.args || '{}'
        }))
      cb.onDone(full, toolCalls.length > 0 ? toolCalls : undefined)
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
   * Phase-2 of chart rendering: turn the copilot's free-text chart description
   * into a STRICT ChartSpec JSON string. Uses structured output to guarantee
   * valid JSON: json_schema (strongest — also enforces the schema) first, then
   * json_object (broad compatibility), then a plain request as a last resort.
   * Returns the raw JSON text for the renderer to validate.
   */
  async chartSpec(req: AIChartSpecRequest): Promise<string> {
    const settings = this.getSettings()
    if (!settings.apiKey) {
      throw new Error('AI is not configured. Set the API key in Settings.')
    }

    const client = await this.createClient()

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: CHART_SPEC_SYSTEM_PROMPT }
    ]
    const contextMessage = buildContextMessage(req.context)
    if (contextMessage) {
      messages.push({ role: 'system', content: contextMessage })
    }
    messages.push({
      role: 'user',
      content: `Produce the ChartSpec JSON for this chart description:\n${req.description}`
    })

    const model = resolveActiveModel(settings)
    // `reasoning_effort: 'none'` suppresses the chain-of-thought preamble that
    // reasoning models (Qwen3, etc. via Ollama) otherwise prepend to `content`
    // — without it the response is "Thinking …" prose, not the JSON object.
    const base = {
      model,
      messages,
      stream: false as const,
      ...({ reasoning_effort: 'none' } as Record<string, unknown>)
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming

    // Try the strongest constraint first, downgrading on any provider error
    // (e.g. the endpoint rejecting an unsupported response_format).
    const attempts: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming[] = [
      {
        ...base,
        response_format: {
          type: 'json_schema',
          json_schema: CHART_SPEC_JSON_SCHEMA
        }
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      { ...base, response_format: { type: 'json_object' } },
      base
    ]

    const run = async (
      body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
    ): Promise<string> => {
      const completion = await client.chat.completions.create(body)
      return extractMessageText(completion.choices[0]?.message).trim()
    }

    let lastError: unknown
    for (const body of attempts) {
      try {
        const text = await run(body)
        if (!text) continue
        // Complete spec → done. JSON-valid but missing an extractor → ask the
        // model to fix it once (the json_object fallback does not enforce the
        // schema, and weak models routinely drop "column"). This keeps the spec
        // model-generated rather than patched client-side.
        if (isCompleteChartSpec(text)) return text
        if (looksLikeJson(text)) {
          const fixed = await this.correctChartSpec(client, base, messages, text).catch(() => null)
          return fixed ?? text
        }
        return text
      } catch (e) {
        lastError = e
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to generate chart spec')
  }

  /**
   * Single corrective pass: feed the invalid spec back to the model with the
   * concrete validation error and ask for a corrected ChartSpec JSON.
   */
  private async correctChartSpec(
    client: OpenAI,
    base: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    bad: string
  ): Promise<string> {
    const fixMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...messages,
      { role: 'assistant', content: bad },
      {
        role: 'user',
        content:
          'That ChartSpec is invalid: at least one series has neither "column" nor "regex", so it cannot extract any data. Every series MUST include a non-null "column" (a header label like "id", or a 0-based field index) OR a non-null "regex". For vmstat CPU idle use {"name":"idle","column":"id"}. Return ONLY the corrected ChartSpec JSON object.'
      }
    ]
    const completion = await client.chat.completions.create({
      ...base,
      messages: fixMessages,
      response_format: { type: 'json_object' }
    })
    return extractMessageText(completion.choices[0]?.message).trim()
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

    const client = await this.createClient()

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT }
    ]
    const contextMessage = buildContextMessage(req.context)
    if (contextMessage) {
      messages.push({ role: 'system', content: contextMessage })
    }
    messages.push({ role: 'user', content: req.prompt })

    const completion = await client.chat.completions.create(
      ollamaDirectAnswerBody(resolveModel(settings, settings.nlModelProfile), messages)
    )
    return extractMessageText(completion.choices[0]?.message)
  }

  async summarize(req: AISummarizeRequest, cb: StreamCallbacks): Promise<void> {
    const settings = this.getSettings()
    if (!settings.apiKey) {
      cb.onError('AI is not configured. Set the API key in Settings.')
      return
    }

    const client = await this.createClient()

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
        ollamaDirectAnswerStreamBody(resolveModel(settings, settings.nlModelProfile), messages, 256),
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

  /** Compress older Copilot turns into a short summary (non-streaming). */
  async compressHistory(req: AICompressHistoryRequest): Promise<string> {
    const settings = this.getSettings()
    if (!settings.apiKey) {
      throw new Error('AI is not configured. Set the API key in Settings.')
    }
    if (req.messages.length === 0) {
      throw new Error('No messages to compress.')
    }

    const client = await this.createClient()

    const convText = req.messages
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: HISTORY_SUMMARY_SYSTEM_PROMPT }
    ]
    const contextMessage = buildContextMessage(req.context)
    if (contextMessage) {
      messages.push({ role: 'system', content: contextMessage })
    }
    messages.push({
      role: 'user',
      content: `请压缩以下较早的对话记录：\n\n${convText}`
    })

    const completion = await client.chat.completions.create(
      ollamaDirectAnswerBody(resolveActiveModel(settings), messages, 1024)
    )
    const summary = extractMessageText(completion.choices[0]?.message).trim()
    if (!summary) {
      throw new Error('Empty summary from model.')
    }
    return summary
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
