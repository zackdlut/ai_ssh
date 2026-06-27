import { useEffect, useRef, useState } from 'react'
import { mermaidThemeFor } from '../../lib/themes'
import { useThemeStore } from '../../store/themeStore'
import { useT } from '../../lib/i18n'

type MermaidApi = typeof import('mermaid').default
let mermaidPromise: Promise<MermaidApi> | null = null
function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then((m) => m.default)
  return mermaidPromise
}

let lastMermaidTheme: 'dark' | 'default' | null = null
function ensureInit(mermaid: MermaidApi, theme: 'dark' | 'default'): void {
  if (lastMermaidTheme === theme) return
  lastMermaidTheme = theme
  mermaid.initialize({
    startOnLoad: false,
    theme,
    securityLevel: 'strict',
    // Must include a CJK-capable family or Chinese labels render as tofu boxes.
    fontFamily:
      "'Sora', 'Noto Sans SC', 'Noto Sans CJK SC', system-ui, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
  })
}

let seq = 0
const nextRenderId = (): string => `mermaid-${Date.now()}-${seq++}`

// Characters that mermaid treats as syntax inside a node label and therefore
// require the label to be quoted.
const NEEDS_QUOTE = /[()<>{}:;#=&|/]/

// Keywords that may legally start a mermaid diagram. Used to locate where the
// actual diagram begins so leading prose can be dropped.
const DIAGRAM_KEYWORDS = [
  'graph',
  'flowchart',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram-v2',
  'stateDiagram',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'mindmap',
  'timeline',
  'gitGraph',
  'quadrantChart',
  'xychart-beta',
  'requirementDiagram',
  'sankey-beta',
  'block-beta',
  'C4Context',
  'C4Container',
  'C4Component',
  'C4Dynamic'
]
const HEADER_RE = new RegExp(`^(?:${DIAGRAM_KEYWORDS.join('|')})\\b`)

// A full-line markdown table row / separator (LLMs sometimes paste these into
// the fenced block). Edge labels like A -->|yes| B never start with a pipe.
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/

const quoteLabel = (open: string, close: string, raw: string): string => {
  const label = raw.trim()
  if (!label || /^".*"$/.test(label)) return `${open}${raw}${close}`
  if (!NEEDS_QUOTE.test(label)) return `${open}${raw}${close}`
  return `${open}"${label.replace(/"/g, '&quot;')}"${close}`
}

/**
 * Drop everything before the first recognizable diagram declaration so that
 * leading prose ("用 Mermaid 创建...") the model accidentally put inside the
 * fenced block does not break parsing. Any %%{init}%% directive that preceded
 * the header is preserved. If no header is found the input is returned as-is.
 */
function stripProse(code: string): string {
  const lines = code.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || t.startsWith('%%')) continue
    if (HEADER_RE.test(t)) {
      start = i
      break
    }
  }
  if (start === -1) return code
  const directives = lines.slice(0, start).filter((l) => /^\s*%%\{/.test(l))
  return [...directives, ...lines.slice(start)].join('\n')
}

/**
 * Best-effort repair of the most common invalid mermaid produced by LLMs:
 * leading prose / markdown tables inside the block, literal "\n" used as a line
 * break, and node labels in [...] / {...} / (...) that contain special
 * characters but are not quoted. Conservative — leaves [[...]], [(...)],
 * (([...])) and already-quoted labels alone. The caller only uses the result
 * if it actually parses.
 */
function sanitizeMermaid(code: string): string {
  let out = stripProse(code)
  out = out
    .split('\n')
    .filter((line) => !TABLE_ROW_RE.test(line))
    .join('\n')
  // Literal backslash-n is never valid mermaid; treat it as a label line break.
  out = out.replace(/\\n/g, '<br/>')
  // Square-bracket labels, but not [[subroutine]] or [(cylinder)].
  out = out.replace(/(^|[^[(\\])\[([^[\]\n][^\]\n]*?)\]/g, (_m, pre, body) =>
    `${pre}${quoteLabel('[', ']', body)}`
  )
  // Curly-brace (decision) labels.
  out = out.replace(/\{([^{}\n]+)\}/g, (_m, body) => quoteLabel('{', '}', body))
  // Rounded-node labels A(label); guard against (( circle )), ([ stadium ]),
  // [( cylinder )] and escaped parens by excluding bracket/brace chars.
  out = out.replace(/(^|[^([{\\])\(([^()[\]{}\n]+)\)/g, (_m, pre, body) =>
    `${pre}${quoteLabel('(', ')', body)}`
  )
  return out
}

/**
 * Strip cosmetic-only directives (style / classDef / class / linkStyle and
 * inline :::class attachments). Used as a last-resort degradation: a diagram
 * whose styling references an undeclared class still renders structurally once
 * the styling is removed.
 */
function stripStyling(code: string): string {
  return code
    .split('\n')
    .filter((line) => !/^\s*(style|classDef|class|linkStyle)\b/.test(line))
    .join('\n')
    .replace(/:::[A-Za-z0-9_]+/g, '')
}

interface Props {
  code: string
}

/** Render a mermaid diagram, falling back to source on parse/render errors. */
export default function MermaidBlock({ code }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const appTheme = useThemeStore((s) => s.theme)
  const t = useT()

  useEffect(() => {
    let cancelled = false

    const renderInto = async (mermaid: MermaidApi, src: string): Promise<void> => {
      const { svg } = await mermaid.render(nextRenderId(), src)
      if (cancelled) return
      setError(null)
      if (ref.current) ref.current.innerHTML = svg
    }

    void (async () => {
      const mermaid = await loadMermaid()
      if (cancelled) return
      ensureInit(mermaid, mermaidThemeFor(appTheme))

      // Try increasingly-aggressive repairs and render the first candidate that
      // actually parses; only surface an error if none of them do.
      const sanitized = sanitizeMermaid(code)
      const candidates = [code, sanitized, stripStyling(sanitized)].filter(
        (c, i, arr) => arr.indexOf(c) === i
      )
      let chosen: string | null = null
      for (const src of candidates) {
        try {
          if (await mermaid.parse(src, { suppressErrors: true })) {
            chosen = src
            break
          }
        } catch {
          // try the next candidate
        }
        if (cancelled) return
      }
      try {
        // Fall back to the original source so the error message is meaningful.
        await renderInto(mermaid, chosen ?? code)
      } catch (e: unknown) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        if (ref.current) ref.current.innerHTML = ''
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code, appTheme])

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
          {copied ? t('cmd.copied') : t('cmd.copy')}
        </button>
      </div>
      {error ? (
        <div className="preview-error">
          <div className="preview-error-msg">
            {t('mermaid.renderError', {
              bad: t('mermaid.badExample'),
              good: t('mermaid.goodExample'),
              error
            })}
          </div>
          <pre>{code}</pre>
        </div>
      ) : (
        <div className="mermaid-canvas" ref={ref} />
      )}
    </div>
  )
}
