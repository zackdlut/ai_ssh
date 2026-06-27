import { lazy, Suspense, useState } from 'react'
import CommandCard from './CommandCard'
import Markdown from './Markdown'
import HtmlPreview from './HtmlPreview'
import ThinkingBlock from './ThinkingBlock'
import { parseJsonLoose } from '../../lib/chartSpec'
import { useAIStore, type ChatMessage as ChatMessageType } from '../../store/aiStore'
import type { ChartSnapshot } from '../../../shared/types'
import { useT } from '../../lib/i18n'

const MermaidBlock = lazy(() => import('./MermaidBlock'))
const ChartBlock = lazy(() => import('./ChartBlock'))

function PreviewFallback(): JSX.Element {
  return <div className="preview-block preview-loading">…</div>
}

interface Props {
  message: ChatMessageType
}

interface Segment {
  type: 'text' | 'command' | 'mermaid' | 'html' | 'chart'
  content: string
  /** For chart segments: the paired collection command (adjacent bash block). */
  command?: string
  /** For command segments: true when consumed by an adjacent chart (not rendered as a card). */
  consumed?: boolean
}

// These fenced blocks get special treatment. `json` is included so that a chart
// spec the model mistakenly tagged as ```json (instead of ```chart) still
// renders as a chart; non-chart json stays in the markdown text stream.
const SPECIAL_FENCE = /```(bash|sh|shell|zsh|mermaid|html|chart|json)[^\n]*\n([\s\S]*?)```/g

const CHART_TYPES = ['line', 'bar', 'pie', 'scatter']

/**
 * Some models emit their chain-of-thought inline as `<think>…</think>` in the
 * answer body instead of via a separate reasoning field. Pull that out so it
 * can join the dedicated thinking block. Handles a still-open `<think>` during
 * streaming (no closing tag yet) by treating the rest as reasoning.
 */
function extractThinkTags(content: string): { reasoning: string; body: string } {
  if (!content.includes('<think>')) return { reasoning: '', body: content }
  const parts: string[] = []
  let body = ''
  let rest = content
  let idx: number
  while ((idx = rest.indexOf('<think>')) !== -1) {
    body += rest.slice(0, idx)
    const after = rest.slice(idx + '<think>'.length)
    const close = after.indexOf('</think>')
    if (close === -1) {
      parts.push(after)
      rest = ''
      break
    }
    parts.push(after.slice(0, close))
    rest = after.slice(close + '</think>'.length)
  }
  body += rest
  return { reasoning: parts.join('\n').trim(), body }
}

/**
 * Heuristic: does this JSON body look like a chart spec? Conservative so that
 * ordinary json snippets are not hijacked — requires a known chart `type` and a
 * non-empty `series` array.
 */
function looksLikeChartSpec(body: string): boolean {
  try {
    const obj = parseJsonLoose(body) as Record<string, unknown>
    return (
      !!obj &&
      typeof obj === 'object' &&
      typeof obj.type === 'string' &&
      CHART_TYPES.includes(obj.type) &&
      Array.isArray(obj.series) &&
      obj.series.length > 0
    )
  } catch {
    return false
  }
}

/** Split assistant content into markdown prose and special preview blocks. */
function splitSegments(content: string): Segment[] {
  const segments: Segment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  SPECIAL_FENCE.lastIndex = 0
  while ((match = SPECIAL_FENCE.exec(content)) !== null) {
    const lang = match[1]
    const body = match[2].trim()

    // A json fence is only special when it actually carries a chart spec;
    // otherwise leave the whole fenced block in the text stream for Markdown.
    if (lang === 'json' && !looksLikeChartSpec(body)) continue

    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, match.index) })
    }
    if (body) {
      const type: Segment['type'] =
        lang === 'mermaid'
          ? 'mermaid'
          : lang === 'html'
            ? 'html'
            : lang === 'chart' || lang === 'json'
              ? 'chart'
              : 'command'
      segments.push({ type, content: body })
    }
    lastIndex = SPECIAL_FENCE.lastIndex
  }
  if (lastIndex < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIndex) })
  }
  pairChartCommands(segments)
  return segments
}

/**
 * Pair each chart segment with its adjacent command segment (per prompt, the
 * collection bash block follows the chart block). The paired command is attached
 * to the chart so ChartBlock can auto-run it, and the command segment is marked
 * consumed so it is not also rendered as a standalone command card. Prefers the
 * nearest following command, falling back to the nearest preceding one.
 */
function pairChartCommands(segments: Segment[]): void {
  const findCommand = (from: number, step: 1 | -1): number => {
    for (let i = from; i >= 0 && i < segments.length; i += step) {
      const seg = segments[i]
      if (seg.type === 'command' && !seg.consumed) return i
      if (seg.type === 'chart') break // don't cross another chart
    }
    return -1
  }
  segments.forEach((seg, i) => {
    if (seg.type !== 'chart') return
    let cmdIdx = findCommand(i + 1, 1)
    if (cmdIdx === -1) cmdIdx = findCommand(i - 1, -1)
    if (cmdIdx !== -1) {
      seg.command = segments[cmdIdx].content
      segments[cmdIdx].consumed = true
    }
  })
}

function renderSegment(
  seg: Segment,
  i: number,
  messageId: string,
  boundSessionId?: string,
  boundTabId?: string,
  streaming?: boolean,
  snapshot?: ChartSnapshot,
  onSnapshot?: (snapshot: ChartSnapshot) => void
): JSX.Element | null {
  switch (seg.type) {
    case 'command':
      // Consumed by an adjacent chart (it auto-runs the command) — don't show a
      // duplicate command card.
      return seg.consumed ? null : <CommandCard key={i} command={seg.content} />
    case 'mermaid':
      return (
        <Suspense key={i} fallback={<PreviewFallback />}>
          <MermaidBlock code={seg.content} />
        </Suspense>
      )
    case 'html':
      return <HtmlPreview key={i} html={seg.content} />
    case 'chart':
      return (
        <Suspense key={i} fallback={<PreviewFallback />}>
          <ChartBlock
            spec={seg.content}
            command={seg.command}
            boundSessionId={boundSessionId}
            boundTabId={boundTabId}
            streaming={streaming}
            snapshot={snapshot}
            onSnapshot={onSnapshot}
          />
        </Suspense>
      )
    default:
      return seg.content.trim() ? <Markdown key={i} text={seg.content} /> : null
  }
}

export default function ChatMessage({ message }: Props): JSX.Element {
  const isUser = message.role === 'user'
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [copied, setCopied] = useState(false)
  const activeChatTabId = useAIStore((s) => s.activeChatTabId)
  const setChartSnapshot = useAIStore((s) => s.setChartSnapshot)
  const t = useT()

  if (isUser) {
    return (
      <div className="chat-msg user">
        <span className="role">You</span>
        <div className="chat-bubble">{message.content}</div>
      </div>
    )
  }

  const { reasoning: tagReasoning, body } = extractThinkTags(message.content)
  const reasoning = [message.reasoning, tagReasoning].filter(Boolean).join('\n').trim()
  const empty = body.trim().length === 0
  // Still reasoning when the answer body hasn't started yet and we're streaming.
  const thinking = !!message.streaming && empty
  const segments = mode === 'preview' ? splitSegments(body) : []

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(body)
    setCopied(true)
  }

  return (
    <div className="chat-msg assistant">
      <div className="msg-head">
        <span className="role">Copilot</span>
        {!empty && (
          <div className="seg mini msg-toolbar">
            <button
              type="button"
              className={`msg-toolbar-btn ${mode === 'preview' ? 'active' : ''}`}
              onClick={() => setMode('preview')}
            >
              {t('chat.preview')}
            </button>
            <button
              type="button"
              className={`msg-toolbar-btn ${mode === 'source' ? 'active' : ''}`}
              onClick={() => setMode('source')}
            >
              {t('chat.source')}
            </button>
            <button
              type="button"
              className={`msg-toolbar-btn copy-btn ${copied ? 'copied' : ''}`}
              onClick={() => void copy()}
              title={copied ? t('cmd.copied') : t('common.copy')}
            >
              {copied ? t('cmd.copied') : t('common.copy')}
            </button>
          </div>
        )}
      </div>
      <div className="chat-bubble">
        {reasoning && (
          <ThinkingBlock reasoning={reasoning} thinking={thinking} durationMs={message.thinkingMs} />
        )}
        {empty && message.streaming ? (
          !reasoning && <span style={{ color: 'var(--text-dim)' }}>…</span>
        ) : mode === 'source' ? (
          <pre className="msg-source">{body}</pre>
        ) : (
          segments.map((seg, i) =>
            renderSegment(
              seg,
              i,
              message.id,
              message.boundSessionId,
              message.boundTabId,
              message.streaming,
              message.chartSnapshots?.[String(i)],
              activeChatTabId
                ? (snapshot) => setChartSnapshot(activeChatTabId, message.id, String(i), snapshot)
                : undefined
            )
          )
        )}
      </div>
    </div>
  )
}
