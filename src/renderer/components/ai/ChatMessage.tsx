import { useState } from 'react'
import CommandCard from './CommandCard'
import Markdown from './Markdown'
import MermaidBlock from './MermaidBlock'
import HtmlPreview from './HtmlPreview'
import ChartBlock from './ChartBlock'
import { parseJsonLoose } from '../../lib/chartSpec'
import type { ChatMessage as ChatMessageType } from '../../store/aiStore'

interface Props {
  message: ChatMessageType
}

interface Segment {
  type: 'text' | 'command' | 'mermaid' | 'html' | 'chart'
  content: string
}

// These fenced blocks get special treatment. `json` is included so that a chart
// spec the model mistakenly tagged as ```json (instead of ```chart) still
// renders as a chart; non-chart json stays in the markdown text stream.
const SPECIAL_FENCE = /```(bash|sh|shell|zsh|mermaid|html|chart|json)[^\n]*\n([\s\S]*?)```/g

const CHART_TYPES = ['line', 'bar', 'pie', 'scatter']

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
  return segments
}

function renderSegment(
  seg: Segment,
  i: number,
  boundSessionId?: string,
  boundTabId?: string
): JSX.Element | null {
  switch (seg.type) {
    case 'command':
      return <CommandCard key={i} command={seg.content} />
    case 'mermaid':
      return <MermaidBlock key={i} code={seg.content} />
    case 'html':
      return <HtmlPreview key={i} html={seg.content} />
    case 'chart':
      return (
        <ChartBlock
          key={i}
          spec={seg.content}
          boundSessionId={boundSessionId}
          boundTabId={boundTabId}
        />
      )
    default:
      return seg.content.trim() ? <Markdown key={i} text={seg.content} /> : null
  }
}

export default function ChatMessage({ message }: Props): JSX.Element {
  const isUser = message.role === 'user'
  const [mode, setMode] = useState<'preview' | 'source'>('preview')

  if (isUser) {
    return (
      <div className="chat-msg user">
        <span className="role">You</span>
        <div className="chat-bubble">{message.content}</div>
      </div>
    )
  }

  const empty = message.content.trim().length === 0
  const segments = mode === 'preview' ? splitSegments(message.content) : []

  return (
    <div className="chat-msg assistant">
      <div className="msg-head">
        <span className="role">Copilot</span>
        {!empty && (
          <div className="seg mini">
            <button
              className={mode === 'preview' ? 'active' : ''}
              onClick={() => setMode('preview')}
            >
              预览
            </button>
            <button className={mode === 'source' ? 'active' : ''} onClick={() => setMode('source')}>
              源码
            </button>
          </div>
        )}
      </div>
      <div className="chat-bubble">
        {empty && message.streaming ? (
          <span style={{ color: 'var(--text-dim)' }}>…</span>
        ) : mode === 'source' ? (
          <pre className="msg-source">{message.content}</pre>
        ) : (
          segments.map((seg, i) =>
            renderSegment(seg, i, message.boundSessionId, message.boundTabId)
          )
        )}
      </div>
    </div>
  )
}
