import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'

let initialized = false
function ensureInit(): void {
  if (initialized) return
  initialized = true
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'strict',
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace"
  })
}

let seq = 0

interface Props {
  code: string
}

/** Render a mermaid diagram, falling back to source on parse/render errors. */
export default function MermaidBlock({ code }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    ensureInit()
    let cancelled = false
    const id = `mermaid-${Date.now()}-${seq++}`

    mermaid
      .render(id, code)
      .then(({ svg }) => {
        if (cancelled) return
        setError(null)
        if (ref.current) ref.current.innerHTML = svg
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        if (ref.current) ref.current.innerHTML = ''
      })

    return () => {
      cancelled = true
    }
  }, [code])

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className={`preview-block ${error ? 'has-error' : ''}`}>
      <div className="preview-toolbar">
        <span className="preview-label">Mermaid</span>
        <button className="preview-btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {error ? (
        <div className="preview-error">
          <div className="preview-error-msg">无法渲染该 mermaid 图：{error}</div>
          <pre>{code}</pre>
        </div>
      ) : (
        <div className="mermaid-canvas" ref={ref} />
      )}
    </div>
  )
}
