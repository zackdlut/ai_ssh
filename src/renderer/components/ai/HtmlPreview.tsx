import { useCallback, useRef, useState } from 'react'

interface Props {
  html: string
}

const BASE_STYLE = `<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; }
  body {
    padding: 12px;
    background: #05070d;
    color: #e7ebf6;
    font-family: 'Sora', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    word-break: break-word;
  }
  a { color: #5be9d0; }
  img, video, table { max-width: 100%; }
  pre, code { font-family: 'JetBrains Mono', monospace; }
</style>`

/** Wrap a fragment in a minimal document; pass full documents through as-is. */
function buildSrcDoc(html: string): string {
  const isFullDoc = /<!doctype|<html[\s>]/i.test(html)
  if (isFullDoc) return html
  return `<!doctype html><html><head><meta charset="utf-8">${BASE_STYLE}</head><body>${html}</body></html>`
}

export default function HtmlPreview({ html }: Props): JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [copied, setCopied] = useState(false)

  // Sandbox without allow-scripts means scripts never run; allow-same-origin
  // lets us read the document height for auto-sizing.
  const resize = useCallback((): void => {
    const frame = frameRef.current
    const doc = frame?.contentDocument
    if (!frame || !doc) return
    const h = Math.min(900, Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0))
    frame.style.height = `${h + 2}px`
  }, [])

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(html)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="preview-block">
      <div className="preview-toolbar">
        <span className="preview-label">HTML</span>
        <button className="preview-btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <iframe
        ref={frameRef}
        className="html-frame"
        title="HTML preview"
        sandbox="allow-same-origin"
        srcDoc={buildSrcDoc(html)}
        onLoad={resize}
      />
    </div>
  )
}
