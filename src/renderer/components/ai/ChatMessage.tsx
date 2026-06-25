import { useState } from 'react'
import CommandCard from './CommandCard'
import Markdown from './Markdown'
import MermaidBlock from './MermaidBlock'
import HtmlPreview from './HtmlPreview'
import type { ChatMessage as ChatMessageType } from '../../store/aiStore'

interface Props {
  message: ChatMessageType
}

interface Segment {
  type: 'text' | 'command' | 'mermaid' | 'html'
  content: string
}

// Only these fenced blocks get special treatment; every other fence (json, js,
// yaml, …) stays in the text stream and is rendered by the Markdown component.
const SPECIAL_FENCE = /```(bash|sh|shell|zsh|mermaid|html)[^\n]*\n([\s\S]*?)```/g

function langToType(lang: string): Segment['type'] {
  if (lang === 'mermaid') return 'mermaid'
  if (lang === 'html') return 'html'
  return 'command'
}

/** Split assistant content into markdown prose and special preview blocks. */
function splitSegments(content: string): Segment[] {
  const segments: Segment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  SPECIAL_FENCE.lastIndex = 0
  while ((match = SPECIAL_FENCE.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, match.index) })
    }
    const body = match[2].trim()
    if (body) segments.push({ type: langToType(match[1]), content: body })
    lastIndex = SPECIAL_FENCE.lastIndex
  }
  if (lastIndex < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIndex) })
  }
  return segments
}

function renderSegment(seg: Segment, i: number): JSX.Element | null {
  switch (seg.type) {
    case 'command':
      return <CommandCard key={i} command={seg.content} />
    case 'mermaid':
      return <MermaidBlock key={i} code={seg.content} />
    case 'html':
      return <HtmlPreview key={i} html={seg.content} />
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
          segments.map(renderSegment)
        )}
      </div>
    </div>
  )
}
