import type OpenAI from 'openai'

type OpenAIConstructor = typeof import('openai').default
let openaiCtor: OpenAIConstructor | null = null

type HttpsProxyAgentConstructor = typeof import('https-proxy-agent').HttpsProxyAgent
let httpsProxyAgentCtor: HttpsProxyAgentConstructor | null = null

async function loadOpenAI(): Promise<OpenAIConstructor> {
  if (!openaiCtor) {
    const mod = await import('openai')
    openaiCtor = mod.default
  }
  return openaiCtor
}

async function loadHttpsProxyAgent(): Promise<HttpsProxyAgentConstructor> {
  if (!httpsProxyAgentCtor) {
    const mod = await import('https-proxy-agent')
    httpsProxyAgentCtor = mod.HttpsProxyAgent
  }
  return httpsProxyAgentCtor
}
import {
  resolveActiveModel,
  resolveModel,
  resolveBaseURL,
  resolveApiKey,
  resolveHttpProxy
} from '../../shared/aiSettings'
import { AI_TOOLS, buildAITools, toolTierForProfile } from '../../shared/aiTools'
import type {
  AISettings,
  AppLocale,
  ModelProfile,
  AIAgentTurnRequest,
  AIAgentTurnResult,
  AIChatRequest,
  AIChartSpecRequest,
  AITranslateRequest,
  AISummarizeRequest,
  AICompressHistoryRequest,
  InstalledSkill,
  ChatMessageDTO,
  ToolCallDTO,
  AITokenUsage
} from '../../shared/types'
import {
  buildCopilotSystemPrompt,
  CHART_SPEC_SYSTEM_PROMPT,
  buildTranslateSystemPrompt,
  buildSummarizeSystemPrompt,
  buildSummarizeUserMessage,
  buildHistorySummarySystemPrompt,
  buildContextMessage,
  buildChartSpecUserMessage,
  buildHistoryCompressUserMessage,
  buildUserRulesSystemMessage
} from '../../shared/prompts'
import { logDebug } from '../debug/logger'
import { sanitizeForDebug } from '../../shared/debugSanitize'

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

/**
 * Abort a streaming chat if no data arrives for this long — either no first
 * byte (the endpoint accepted the connection but the model wedged during
 * prefill, which some quantized local models do on certain long/complex
 * prompts) or a mid-stream stall. Without this the renderer stays "busy"
 * forever. Generous so a slow local model's first token (model load + prefill)
 * is not cut off; the timer resets on every chunk.
 */
const CHAT_STREAM_STALL_MS = 120000

/** Upper bound for a single HTTP attempt against the model endpoint. */
const REQUEST_TIMEOUT_MS = 120000

export interface StreamCallbacks {
  onChunk: (delta: string) => void
  /** Streamed reasoning/thinking tokens, kept separate from the answer body. */
  onReasoning?: (delta: string) => void
  onDone: (
    content: string,
    toolCalls?: ToolCallDTO[],
    usage?: AITokenUsage,
    /**
     * Why the model stopped. `length` means the answer was CUT, not finished —
     * the loop has to know that, because a cut-off turn carries no tool call and
     * would otherwise read as a considered final answer.
     */
    finishReason?: string
  ) => void
  onError: (error: string) => void
}

/**
 * A 4xx means the server understood us and refused — which is how a backend
 * that does not support `tools` or `stream_options` reports it. Anything else
 * (a connection failure, a 5xx, a timeout) says nothing about the parameters.
 */
function isParameterRejection(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 500
}

/**
 * Turn a request failure into something a user can act on.
 *
 * The OpenAI SDK reports every transport failure as the bare string
 * "Connection error.", which names neither the endpoint nor the reason. The
 * real cause is two levels down (`APIConnectionError.cause` is undici's
 * `TypeError: fetch failed`, whose own `cause` carries the syscall code), so
 * unwrap the chain and put the endpoint back in the message. A proxy rejecting
 * the tunnel looks identical from the outside, so name the proxy when one is in
 * play — that failure needs a completely different fix from an unreachable host.
 */
function describeRequestError(e: unknown, url: string, proxyUrl = ''): string {
  const message = e instanceof Error ? e.message : String(e)
  if (!/connection error/i.test(message)) return message

  const codes: string[] = []
  let lastMessage = ''
  const seen = new Set<unknown>()
  let cursor: unknown = (e as { cause?: unknown } | null)?.cause
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const node = cursor as { code?: unknown; message?: unknown; errors?: unknown; cause?: unknown }
    if (typeof node.code === 'string') codes.push(node.code)
    if (typeof node.message === 'string' && node.message) lastMessage = node.message
    // Happy Eyeballs surfaces one AggregateError holding one error per address.
    if (Array.isArray(node.errors)) {
      for (const inner of node.errors as { code?: unknown }[]) {
        if (typeof inner?.code === 'string') codes.push(inner.code)
      }
    }
    cursor = node.cause
  }

  // Proxy agents reject tunnels with a plain message and no syscall code, so
  // fall back to that text rather than dropping the only available detail.
  const detail = codes.length > 0 ? [...new Set(codes)].join(', ') : lastMessage
  const suffix = detail ? ` (${detail})` : ''
  if (proxyUrl) {
    return `Cannot reach the model endpoint ${url} through proxy ${proxyUrl}${suffix}. If the endpoint is on your LAN, add its host to NO_PROXY or clear the proxy in Settings.`
  }
  return `Cannot reach the model endpoint ${url}${suffix}. Check that the service is running and reachable from this machine, and that the Base URL / proxy in Settings are correct.`
}

/** Flatten an error's `cause` chain for the debug log. */
function causeChain(e: unknown): string[] {
  const chain: string[] = []
  const seen = new Set<unknown>()
  let cursor: unknown = e
  while (cursor && !seen.has(cursor) && chain.length < 6) {
    seen.add(cursor)
    const node = cursor as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown }
    chain.push(
      [node.name, node.code, node.message].filter((v) => typeof v === 'string').join(': ') ||
        String(cursor)
    )
    cursor = node.cause
  }
  return chain
}

/**
 * Read the usage block a provider appends to the final stream chunk. Requires
 * `stream_options.include_usage`; providers that ignore it simply never send
 * one, so the caller falls back to its own estimate.
 */
function readUsage(part: OpenAI.Chat.ChatCompletionChunk): AITokenUsage | undefined {
  const usage = part.usage
  if (!usage) return undefined
  return {
    prompt: usage.prompt_tokens ?? 0,
    completion: usage.completion_tokens ?? 0,
    total: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
  }
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

/**
 * Last-resort user turn, injected when a payload would otherwise carry none.
 *
 * A chat template that scans backwards for the last real user message — Qwen3's
 * does — refuses the whole request when it finds only system and tool turns,
 * and the refusal arrives as a 500 that names nothing the caller can act on.
 * The renderer no longer builds such a payload, but it is not the only caller
 * and the server also produces this shape ON ITS OWN by truncating a long
 * prompt from the front. One cheap turn here is the difference between a
 * degraded request and no answer at all.
 */
const USER_TURN_FALLBACK = 'Continue with the task described above.'

function isNonEmptyUserTurn(m: OpenAI.Chat.ChatCompletionMessageParam): boolean {
  if (m.role !== 'user') return false
  if (typeof m.content === 'string') return m.content.trim().length > 0
  return Array.isArray(m.content) && m.content.length > 0
}

/** Guarantee the payload carries a user turn, and say so in the log when it did not. */
function ensureUserTurn(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  traceId: string
): void {
  if (messages.some(isNonEmptyUserTurn)) return
  messages.push({ role: 'user', content: USER_TURN_FALLBACK })
  logLlmRequest(traceId, 'userTurn.injected', {
    reason: 'payload carried no non-empty user message',
    roles: messages.map((m) => m.role)
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

function llmBaseUrl(settings: AISettings, profile: ModelProfile): string {
  return normalizeBaseURL(resolveBaseURL(settings, profile)) ?? ''
}

function logLlmRequest(traceId: string, message: string, data: unknown): void {
  logDebug({ category: 'llm.request', traceId, message, data: sanitizeForDebug(data) })
}

function logLlmResponse(
  traceId: string,
  message: string,
  data: unknown,
  durationMs: number
): void {
  logDebug({
    category: 'llm.response',
    traceId,
    message,
    data: sanitizeForDebug(data),
    durationMs
  })
}

function logLlmError(
  traceId: string,
  message: string,
  data: unknown,
  durationMs?: number
): void {
  logDebug({
    category: 'llm.error',
    traceId,
    message,
    data: sanitizeForDebug(data),
    ...(durationMs != null ? { durationMs } : {})
  })
}

/**
 * Thin wrapper around an OpenAI-compatible Chat Completions endpoint with
 * streaming support and per-request cancellation.
 */
export class AIProvider {
  private controllers = new Map<string, AbortController>()
  private proxyAgent: InstanceType<HttpsProxyAgentConstructor> | undefined
  private proxyAgentUrl = ''

  /**
   * `getLocale` is injected rather than carried on each request so the language
   * of a model-authored answer can never drift from the app's UI language.
   * `getSkills` decides whether the skill tool is worth its schema, and is read
   * from the same store the renderer builds the skills catalog from, so the two
   * cannot disagree about whether skills exist.
   */
  constructor(
    private getSettings: () => AISettings,
    private getLocale: () => AppLocale,
    private getSkills: () => InstalledSkill[]
  ) {}

  private async getProxyAgent(
    url: string
  ): Promise<InstanceType<HttpsProxyAgentConstructor>> {
    if (!this.proxyAgent || this.proxyAgentUrl !== url) {
      const HttpsProxyAgent = await loadHttpsProxyAgent()
      this.proxyAgent = new HttpsProxyAgent(url)
      this.proxyAgentUrl = url
    }
    return this.proxyAgent
  }

  private async createClient(profile: ModelProfile): Promise<OpenAI> {
    const settings = this.getSettings()
    const OpenAIClient = await loadOpenAI()
    const baseURL = normalizeBaseURL(resolveBaseURL(settings, profile))
    const proxyUrl = resolveHttpProxy(settings, baseURL)
    const proxyAgent = proxyUrl ? await this.getProxyAgent(proxyUrl) : undefined
    return new OpenAIClient({
      apiKey: resolveApiKey(settings, profile),
      baseURL,
      // The SDK's default is 10 minutes per attempt, so an endpoint that
      // black-holes packets (a wrong host, a firewall that drops instead of
      // refusing) leaves the panel spinning far past the point the user has
      // given up. Bound it to the same budget as the stream watchdog.
      timeout: REQUEST_TIMEOUT_MS,
      ...(proxyAgent ? { httpAgent: proxyAgent } : {})
    })
  }

  async chat(req: AIChatRequest, cb: StreamCallbacks): Promise<void> {
    const settings = this.getSettings()
    const profile = settings.copilotModelProfile
    if (!resolveApiKey(settings, profile)) {
      cb.onError('AI is not configured. Set the API key in Settings.')
      return
    }

    const client = await this.createClient(profile)
    const started = Date.now()

    const controller = new AbortController()
    this.controllers.set(req.requestId, controller)

    const tier = toolTierForProfile(profile)
    const tools = buildAITools(tier, {
      hasSkills: this.getSkills().some((s) => s.enabled),
      aiSettingsIntent: req.aiSettingsIntent,
      planMode: req.planMode,
      executeMode: req.executeMode
    })
    // Scope the prompt to what this request actually carries. Main owns the
    // decision, so the prompt cannot advertise tools the request omits — a turn
    // with function calling off (the chart turn) gets no tool rules at all,
    // instead of a Tool rules section the trailing nudge then has to fight.
    const toolNames = req.enableTools ? tools.map((t) => t.function.name) : []
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: buildCopilotSystemPrompt({ ...(req.promptSections ?? {}), toolNames })
      }
    ]
    const userRulesMessage = buildUserRulesSystemMessage(req.userRules ?? '')
    if (userRulesMessage) {
      messages.push({ role: 'system', content: userRulesMessage })
    }
    const contextMessage = buildContextMessage(req.context)
    if (contextMessage) {
      messages.push({ role: 'system', content: contextMessage })
    }
    messages.push(...toSdkMessages(req.messages))
    ensureUserTurn(messages, req.requestId)

    const model = resolveActiveModel(settings)
    const baseBody = {
      model,
      messages,
      stream: true as const,
      // Ask for real token counts on the final chunk; the loop's budget guard
      // otherwise runs on a character-ratio estimate that drifts badly on CJK
      // text and on prompts the provider caches.
      stream_options: { include_usage: true }
    }
    const toolBody = {
      ...baseBody,
      tools: tools as unknown as OpenAI.Chat.ChatCompletionTool[],
      tool_choice: 'auto' as const
    }

    logLlmRequest(req.requestId, 'chat.completions.create', {
      method: 'chat.completions.create',
      model,
      baseURL: llmBaseUrl(settings, profile),
      stream: true,
      enableTools: req.enableTools,
      messages
    })

    let full = ''
    let reasoningFull = ''
    let chunkCount = 0
    // Idle-stall watchdog: abort the request when no data has arrived for
    // CHAT_STREAM_STALL_MS. `timedOut` distinguishes this from a user cancel so
    // the catch reports a clear timeout error instead of a silent completion.
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    let timedOut = false
    const armStall = (): void => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, CHAT_STREAM_STALL_MS)
    }
    const toolAcc = new Map<number, ToolCallAccumulator>()
    try {
      armStall()
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
        // Retry bare ONLY when the server actively rejected the request, which
        // is how a backend that does not understand `tools` / `stream_options`
        // answers. A connection failure must NOT be retried here: the SDK has
        // already retried it internally, and doing it again only doubles how
        // long the user waits before seeing an error that never changes.
        if (!isParameterRejection(e) || controller.signal.aborted) throw e
        stream = await client.chat.completions.create(
          { model, messages, stream: true },
          { signal: controller.signal }
        )
      }

      let usage: AITokenUsage | undefined
      let finishReason: string | undefined
      for await (const part of stream as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>) {
        armStall()
        chunkCount++
        usage = readUsage(part) ?? usage
        finishReason = part.choices[0]?.finish_reason ?? finishReason
        const { content, reasoning } = splitStreamDelta(part)
        // Reasoning is streamed to a separate channel and intentionally NOT
        // added to `full`, so it never leaks into the answer or the history.
        if (reasoning) {
          reasoningFull += reasoning
          cb.onReasoning?.(reasoning)
        }
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
      logLlmResponse(req.requestId, 'chat.done', {
        content: full,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        reasoning: reasoningFull || undefined,
        chunkCount,
        totalChars: full.length,
        finishReason,
        usage
      }, Date.now() - started)
      cb.onDone(full, toolCalls.length > 0 ? toolCalls : undefined, usage, finishReason)
    } catch (e) {
      if (timedOut) {
        // Watchdog fired: the model produced nothing for CHAT_STREAM_STALL_MS.
        // Surface a clear error (and clear busy) rather than hanging forever.
        logLlmError(req.requestId, 'chat.timeout', {
          content: full,
          chunkCount,
          stallMs: CHAT_STREAM_STALL_MS
        }, Date.now() - started)
        cb.onError(
          `Model response timed out (no output for ${Math.round(
            CHAT_STREAM_STALL_MS / 1000
          )}s). The endpoint or model may be stalled — try again, simplify the request, or start a new chat.`
        )
      } else if (controller.signal.aborted) {
        logLlmResponse(req.requestId, 'chat.aborted', {
          content: full,
          reasoning: reasoningFull || undefined,
          chunkCount,
          aborted: true
        }, Date.now() - started)
        cb.onDone(full)
      } else {
        const endpoint = llmBaseUrl(settings, profile)
        const proxyUrl = resolveHttpProxy(settings, endpoint)
        const described = describeRequestError(e, endpoint, proxyUrl)
        logLlmError(req.requestId, 'chat.error', {
          error: described,
          rawError: e instanceof Error ? e.message : String(e),
          causeChain: causeChain(e),
          proxyUrl: proxyUrl || undefined,
          content: full,
          chunkCount
        }, Date.now() - started)
        cb.onError(described)
      }
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
      this.controllers.delete(req.requestId)
    }
  }

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort()
    this.controllers.delete(requestId)
  }

  /**
   * One non-streaming function-calling turn with a caller-supplied prompt and
   * tool list, for the delegated host sub-agent.
   *
   * Non-streaming on purpose: nothing renders a sub-agent's tokens, and the
   * whole point of the delegation is that only its final report crosses back
   * into the parent conversation. It shares `controllers`, so the parent's Stop
   * cancels an in-flight sub-agent turn like any other request.
   */
  async agentTurn(req: AIAgentTurnRequest): Promise<AIAgentTurnResult> {
    const settings = this.getSettings()
    const profile = settings.copilotModelProfile
    if (!resolveApiKey(settings, profile)) {
      return { error: 'AI is not configured. Set the API key in Settings.' }
    }

    const client = await this.createClient(profile)
    const started = Date.now()
    const controller = new AbortController()
    this.controllers.set(req.requestId, controller)

    const wanted = new Set(req.toolNames ?? [])
    const tools = AI_TOOLS.filter((t) => wanted.has(t.function.name))
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: req.systemPrompt },
      ...toSdkMessages(req.messages)
    ]
    ensureUserTurn(messages, req.requestId)
    const model = resolveActiveModel(settings)
    const base = {
      model,
      messages,
      stream: false as const
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
    const withTools = {
      ...base,
      tools: tools as unknown as OpenAI.Chat.ChatCompletionTool[],
      tool_choice: 'auto' as const
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming

    logLlmRequest(req.requestId, 'agentTurn.completions.create', {
      method: 'chat.completions.create',
      model,
      baseURL: llmBaseUrl(settings, profile),
      stream: false,
      toolNames: [...wanted],
      messages
    })

    try {
      let completion: OpenAI.Chat.ChatCompletion
      try {
        completion = await client.chat.completions.create(tools.length > 0 ? withTools : base, {
          signal: controller.signal
        })
      } catch (e) {
        // Same reasoning as `chat`: a 4xx is how a backend that does not
        // understand `tools` refuses, and the sub-agent can still write its
        // report without them. Anything else is a real failure.
        if (!isParameterRejection(e) || controller.signal.aborted) throw e
        completion = await client.chat.completions.create(base, { signal: controller.signal })
      }

      const message = completion.choices[0]?.message
      const toolCalls: ToolCallDTO[] = (message?.tool_calls ?? []).flatMap((tc) => {
        const fn = (tc as { function?: { name?: string; arguments?: string } }).function
        if (!fn?.name) return []
        return [{ id: tc.id, name: fn.name, arguments: fn.arguments || '{}' }]
      })
      const content = extractMessageText(message)
      const usage = completion.usage
        ? {
            prompt: completion.usage.prompt_tokens ?? 0,
            completion: completion.usage.completion_tokens ?? 0,
            total:
              completion.usage.total_tokens ??
              (completion.usage.prompt_tokens ?? 0) + (completion.usage.completion_tokens ?? 0)
          }
        : undefined
      logLlmResponse(
        req.requestId,
        'agentTurn.done',
        { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage },
        Date.now() - started
      )
      return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage }
    } catch (e) {
      const endpoint = llmBaseUrl(settings, profile)
      const described = controller.signal.aborted
        ? 'Cancelled.'
        : describeRequestError(e, endpoint, resolveHttpProxy(settings, endpoint))
      logLlmError(req.requestId, 'agentTurn.error', { error: described }, Date.now() - started)
      return { error: described }
    } finally {
      this.controllers.delete(req.requestId)
    }
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
    const profile = settings.copilotModelProfile
    if (!resolveApiKey(settings, profile)) {
      throw new Error('AI is not configured. Set the API key in Settings.')
    }

    const client = await this.createClient(profile)
    const started = Date.now()
    const traceId = `chart-${started}`

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: CHART_SPEC_SYSTEM_PROMPT }
    ]
    const contextMessage = buildContextMessage(req.context)
    if (contextMessage) {
      messages.push({ role: 'system', content: contextMessage })
    }
    messages.push({
      role: 'user',
      content: buildChartSpecUserMessage(req.description)
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

    logLlmRequest(traceId, 'chartSpec.completions.create', {
      method: 'chat.completions.create',
      model,
      baseURL: llmBaseUrl(settings, profile),
      stream: false,
      messages
    })

    let lastError: unknown
    for (const body of attempts) {
      try {
        const text = await run(body)
        if (!text) continue
        // Complete spec → done. JSON-valid but missing an extractor → ask the
        // model to fix it once (the json_object fallback does not enforce the
        // schema, and weak models routinely drop "column"). This keeps the spec
        // model-generated rather than patched client-side.
        if (isCompleteChartSpec(text)) {
          logLlmResponse(traceId, 'chartSpec.done', { content: text }, Date.now() - started)
          return text
        }
        if (looksLikeJson(text)) {
          const fixed = await this.correctChartSpec(client, base, messages, text).catch(() => null)
          const result = fixed ?? text
          logLlmResponse(traceId, 'chartSpec.done', { content: result }, Date.now() - started)
          return result
        }
        logLlmResponse(traceId, 'chartSpec.done', { content: text }, Date.now() - started)
        return text
      } catch (e) {
        lastError = e
      }
    }
    logLlmError(traceId, 'chartSpec.error', {
      error: lastError instanceof Error ? lastError.message : String(lastError)
    }, Date.now() - started)
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
    const profile = settings.nlModelProfile
    if (!resolveApiKey(settings, profile)) {
      throw new Error('AI is not configured. Set the API key in Settings.')
    }

    const client = await this.createClient(profile)
    const started = Date.now()
    const traceId = `translate-${started}`

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: buildTranslateSystemPrompt(this.getLocale()) }
    ]
    const contextMessage = buildContextMessage(req.context)
    if (contextMessage) {
      messages.push({ role: 'system', content: contextMessage })
    }
    messages.push({ role: 'user', content: req.prompt })

    const model = resolveModel(settings, profile)
    logLlmRequest(traceId, 'translate.completions.create', {
      method: 'chat.completions.create',
      model,
      baseURL: llmBaseUrl(settings, profile),
      stream: false,
      messages
    })

    try {
      const completion = await client.chat.completions.create(
        ollamaDirectAnswerBody(model, messages)
      )
      const content = extractMessageText(completion.choices[0]?.message)
      logLlmResponse(traceId, 'translate.done', { content }, Date.now() - started)
      return content
    } catch (e) {
      logLlmError(traceId, 'translate.error', {
        error: e instanceof Error ? e.message : String(e)
      }, Date.now() - started)
      throw e
    }
  }

  async summarize(req: AISummarizeRequest, cb: StreamCallbacks): Promise<void> {
    const settings = this.getSettings()
    const profile = settings.nlModelProfile
    if (!resolveApiKey(settings, profile)) {
      cb.onError('AI is not configured. Set the API key in Settings.')
      return
    }

    const client = await this.createClient(profile)
    const started = Date.now()

    const controller = new AbortController()
    this.controllers.set(req.requestId, controller)

    const locale = this.getLocale()
    const userContent = buildSummarizeUserMessage(locale, req.request, req.runs)

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSummarizeSystemPrompt(locale) }
    ]
    const contextMessage = buildContextMessage(req.context)
    if (contextMessage) {
      messages.push({ role: 'system', content: contextMessage })
    }
    messages.push({ role: 'user', content: userContent })

    const model = resolveModel(settings, profile)
    logLlmRequest(req.requestId, 'summarize.completions.create', {
      method: 'chat.completions.create',
      model,
      baseURL: llmBaseUrl(settings, profile),
      stream: true,
      messages
    })

    let full = ''
    let chunkCount = 0
    try {
      const stream = await client.chat.completions.create(
        ollamaDirectAnswerStreamBody(model, messages, 256),
        { signal: controller.signal }
      )

      for await (const part of stream) {
        chunkCount++
        const delta = extractStreamDelta(part)
        if (delta) {
          full += delta
          cb.onChunk(delta)
        }
      }
      logLlmResponse(req.requestId, 'summarize.done', {
        content: full,
        chunkCount,
        totalChars: full.length
      }, Date.now() - started)
      cb.onDone(full)
    } catch (e) {
      if (controller.signal.aborted) {
        logLlmResponse(req.requestId, 'summarize.aborted', {
          content: full,
          chunkCount,
          aborted: true
        }, Date.now() - started)
        cb.onDone(full)
      } else {
        logLlmError(req.requestId, 'summarize.error', {
          error: e instanceof Error ? e.message : String(e),
          content: full,
          chunkCount
        }, Date.now() - started)
        cb.onError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      this.controllers.delete(req.requestId)
    }
  }

  /** Compress older Copilot turns into a short summary (non-streaming). */
  async compressHistory(req: AICompressHistoryRequest): Promise<string> {
    const settings = this.getSettings()
    const profile = settings.copilotModelProfile
    if (!resolveApiKey(settings, profile)) {
      throw new Error('AI is not configured. Set the API key in Settings.')
    }
    if (req.messages.length === 0) {
      throw new Error('No messages to compress.')
    }

    const client = await this.createClient(profile)
    const started = Date.now()
    const traceId = `compress-${started}`

    const mode = req.mode ?? 'chat'
    const convText = req.messages.map(renderForSummary).join('\n\n')

    const locale = this.getLocale()
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: buildHistorySummarySystemPrompt(locale, mode) }
    ]
    const contextMessage = buildContextMessage(req.context)
    if (contextMessage) {
      messages.push({ role: 'system', content: contextMessage })
    }
    messages.push({
      role: 'user',
      content: buildHistoryCompressUserMessage(locale, convText, mode)
    })

    const model = resolveActiveModel(settings)
    logLlmRequest(traceId, 'compressHistory.completions.create', {
      method: 'chat.completions.create',
      model,
      baseURL: llmBaseUrl(settings, profile),
      stream: false,
      messages
    })

    try {
      const completion = await client.chat.completions.create(
        ollamaDirectAnswerBody(model, messages, 1024)
      )
      const summary = extractMessageText(completion.choices[0]?.message).trim()
      if (!summary) {
        throw new Error('Empty summary from model.')
      }
      logLlmResponse(traceId, 'compressHistory.done', { content: summary }, Date.now() - started)
      return summary
    } catch (e) {
      logLlmError(traceId, 'compressHistory.error', {
        error: e instanceof Error ? e.message : String(e)
      }, Date.now() - started)
      throw e
    }
  }
}

/**
 * Flatten one message for the summarizer.
 *
 * Agent-loop history is mostly tool traffic, and labelling every non-user
 * message "Assistant" erased exactly what a loop summary has to keep: which
 * call produced which result. Naming the tool and echoing its arguments costs
 * a few tokens and is what lets the summary say "ran X, got exit 1" instead of
 * "an error occurred".
 */
function renderForSummary(m: ChatMessageDTO): string {
  if (m.role === 'user') return `User: ${m.content}`
  if (m.role === 'tool') return `Tool result: ${m.content}`
  const calls = (m.tool_calls ?? [])
    .map((c) => `  → called ${c.name}(${c.arguments})`)
    .join('\n')
  const head = m.content ? `Assistant: ${m.content}` : 'Assistant:'
  return calls ? `${head}\n${calls}` : head
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
