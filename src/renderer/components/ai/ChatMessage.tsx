import CommandCard from './CommandCard'
import type { ChatMessage as ChatMessageType } from '../../store/aiStore'

interface Props {
  message: ChatMessageType
}

interface Segment {
  type: 'text' | 'command'
  content: string
}

/** Split assistant content into prose segments and runnable command blocks. */
function splitSegments(content: string): Segment[] {
  const segments: Segment[] = []
  const fence = /```(?:bash|sh|shell|zsh)?\n([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, match.index) })
    }
    const body = match[1].trim()
    if (body) segments.push({ type: 'command', content: body })
    lastIndex = fence.lastIndex
  }
  if (lastIndex < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIndex) })
  }
  return segments
}

export default function ChatMessage({ message }: Props): JSX.Element {
  const isUser = message.role === 'user'
  const segments = isUser ? [] : splitSegments(message.content)

  return (
    <div className={`chat-msg ${message.role}`}>
      <span className="role">{isUser ? 'You' : 'Copilot'}</span>
      {isUser ? (
        <div className="chat-bubble">{message.content}</div>
      ) : (
        <div className="chat-bubble">
          {message.content.trim().length === 0 && message.streaming ? (
            <span style={{ color: 'var(--text-dim)' }}>…</span>
          ) : (
            segments.map((seg, i) =>
              seg.type === 'command' ? (
                <CommandCard key={i} command={seg.content} />
              ) : (
                seg.content.trim() && (
                  <span key={i} style={{ whiteSpace: 'pre-wrap' }}>
                    {seg.content.trim()}
                  </span>
                )
              )
            )
          )}
        </div>
      )}
    </div>
  )
}
