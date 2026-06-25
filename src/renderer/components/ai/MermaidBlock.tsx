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
    // Must include a CJK-capable family or Chinese labels render as tofu boxes.
    fontFamily:
      "'Sora', 'Noto Sans SC', 'Noto Sans CJK SC', system-ui, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
  })
}

let seq = 0

// Characters that mermaid treats as syntax inside a node label and therefore
// require the label to be quoted.
const NEEDS_QUOTE = /[()<>{}:;#=&|/]/

/**
 * Best-effort repair of the most common invalid mermaid produced by LLMs:
 * node labels in [...] / {...} that contain special characters but are not
 * quoted. Conservative — leaves [[...]], [(...)] and already-quoted labels
 * alone. The caller only uses the result if it actually renders.
 */
function repairMermaid(code: string): string {
  const quote = (open: string, close: string, raw: string): string => {
    const label = raw.trim()
    if (!label || /^".*"$/.test(label)) return `${open}${raw}${close}`
    if (!NEEDS_QUOTE.test(label)) return `${open}${raw}${close}`
    return `${open}"${label.replace(/"/g, '&quot;')}"${close}`
  }
  let out = code
  // Square-bracket labels, but not [[subroutine]] or [(cylinder)].
  out = out.replace(/(^|[^[(\\])\[([^[\]\n][^\]\n]*?)\]/g, (_m, pre, body) =>
    `${pre}${quote('[', ']', body)}`
  )
  // Curly-brace (decision) labels.
  out = out.replace(/\{([^{}\n]+)\}/g, (_m, body) => quote('{', '}', body))
  return out
}

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

    const renderOnce = (src: string): Promise<string> =>
      mermaid.render(`mermaid-${Date.now()}-${seq++}`, src).then((r) => r.svg)

    // Try the original source; on failure attempt a repaired version, and only
    // surface an error if both fail.
    renderOnce(code)
      .catch((firstErr: unknown) => {
        const repaired = repairMermaid(code)
        if (repaired === code) throw firstErr
        return renderOnce(repaired)
      })
      .then((svg) => {
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
          <div className="preview-error-msg">
            无法渲染该 mermaid 图（常见原因：节点标签中含未加引号的特殊字符，如
            <code>{' A[a (b)] '}</code>
            应写成 <code>{' A["a (b)"] '}</code>）：{error}
          </div>
          <pre>{code}</pre>
        </div>
      ) : (
        <div className="mermaid-canvas" ref={ref} />
      )}
    </div>
  )
}
