import { useEffect, useState } from 'react'
import { formatTokenCount } from '../../../shared/contextBudget'
import type { AITokenUsage } from '../../../shared/types'
import { useT } from '../../lib/i18n'
import {
  completionTokensPerSecond,
  streamingTokensPerSecond
} from '../../lib/turnTokenStats'

interface Props {
  streaming?: boolean
  content: string
  reasoning?: string
  usage?: AITokenUsage
  generationMs?: number
  streamStartedAt?: number
}

function formatRate(rate: number): string {
  if (rate >= 100) return String(Math.round(rate))
  if (rate >= 10) return rate.toFixed(0)
  return rate.toFixed(1)
}

export default function TurnTokenStats({
  streaming,
  content,
  reasoning,
  usage,
  generationMs,
  streamStartedAt
}: Props): JSX.Element | null {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!streaming) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [streaming])

  const rate = streaming
    ? streamingTokensPerSecond(content, reasoning, streamStartedAt, now)
    : completionTokensPerSecond(usage, generationMs)

  const showUsage = !streaming && usage && (usage.prompt > 0 || usage.completion > 0)
  if (!streaming && rate === undefined && !showUsage) return null
  if (streaming && rate === undefined && !content && !reasoning) return null

  const hasRate = rate !== undefined

  return (
    <div className={`turn-token-stats${streaming ? ' is-streaming' : ''}`}>
      {hasRate && (
        <span className="turn-token-chip turn-token-chip--rate">
          <span className="turn-token-chip-label">{t('copilot.turn.rateLabel')}</span>
          <span className="turn-token-chip-value">
            {streaming ? '~' : ''}{formatRate(rate!)}
          </span>
        </span>
      )}
      {showUsage && usage && (
        <>
          <span className="turn-token-chip turn-token-chip--out">
            <span className="turn-token-chip-label">{t('copilot.turn.outLabel')}</span>
            <span className="turn-token-chip-value">{formatTokenCount(usage.completion)}</span>
          </span>
          <span className="turn-token-chip turn-token-chip--in">
            <span className="turn-token-chip-label">{t('copilot.turn.inLabel')}</span>
            <span className="turn-token-chip-value">{formatTokenCount(usage.prompt)}</span>
          </span>
        </>
      )}
    </div>
  )
}
