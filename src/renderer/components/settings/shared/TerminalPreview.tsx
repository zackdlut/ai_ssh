import type { ITheme } from '@xterm/xterm'
import { xtermFontWeight, type TerminalFontWeight } from '../../../../shared/terminalSettings'

export function ColorSwatch({ colors }: { colors: string[] }): JSX.Element {
  return (
    <span className="terminal-scheme-swatch" aria-hidden>
      {colors.map((c, i) => (
        <span key={i} className="terminal-scheme-swatch-cell" style={{ background: c }} />
      ))}
    </span>
  )
}

export default function TerminalPreview({
  theme,
  fontFamily,
  fontSize,
  lineHeight,
  fontWeight,
  compact = false
}: {
  theme: ITheme
  fontFamily: string
  fontSize: number
  lineHeight: number
  fontWeight: TerminalFontWeight
  /** Tighter padding + shorter sample lines for embedding in narrow surfaces. */
  compact?: boolean
}): JSX.Element {
  const fg = theme.foreground ?? '#ccc'
  const style = {
    background: theme.background ?? '#000',
    color: fg,
    fontFamily,
    fontSize: `${fontSize}px`,
    lineHeight,
    fontWeight: xtermFontWeight(fontWeight)
  } as const

  if (compact) {
    return (
      <div className="terminal-preview terminal-preview--compact" style={style}>
        <div>
          <span style={{ color: theme.blue }}>user</span>
          <span style={{ color: fg }}>$ </span>
          <span style={{ color: fg }}>ls -la</span>
        </div>
        <div>
          <span style={{ color: theme.green }}>drwxr-xr-x</span>
          <span style={{ color: fg }}> </span>
          <span style={{ color: theme.blue }}>projects</span>
        </div>
        <div>
          <span style={{ color: fg }}>grep </span>
          <span style={{ color: theme.yellow }}>&quot;error&quot;</span>
          <span style={{ color: fg }}> log</span>
        </div>
        <div>
          <span style={{ color: theme.red }}>ERROR</span>
          <span style={{ color: fg }}>: refused</span>
        </div>
        <div className="terminal-preview-prompt">
          <span style={{ color: theme.blue }}>user</span>
          <span style={{ color: fg }}>$ </span>
          <span className="terminal-preview-cursor" style={{ background: theme.cursor }} />
        </div>
      </div>
    )
  }

  return (
    <div className="terminal-preview" style={style}>
      <div>
        <span style={{ color: theme.blue }}>user@host</span>
        <span style={{ color: fg }}>:</span>
        <span style={{ color: theme.cyan }}>~</span>
        <span style={{ color: fg }}>$ </span>
        <span style={{ color: fg }}>ls -la</span>
      </div>
      <div>
        <span style={{ color: theme.green }}>drwxr-xr-x</span>
        <span style={{ color: fg }}>  4 user  staff   128 Jun 27 10:00 </span>
        <span style={{ color: theme.blue }}>projects</span>
      </div>
      <div>
        <span style={{ color: theme.green }}>-rw-r--r--</span>
        <span style={{ color: fg }}>  1 user  staff  2048 Jun 27 09:30 </span>
        <span style={{ color: fg }}>README.md</span>
      </div>
      <div>
        <span style={{ color: fg }}>grep </span>
        <span style={{ color: theme.yellow }}>&quot;error&quot;</span>
        <span style={{ color: fg }}> app.log</span>
      </div>
      <div>
        <span style={{ color: theme.red }}>ERROR</span>
        <span style={{ color: fg }}>: connection refused</span>
      </div>
      <div>
        <span style={{ color: theme.magenta }}>INFO</span>
        <span style={{ color: fg }}>: retry succeeded</span>
      </div>
      <div className="terminal-preview-prompt">
        <span style={{ color: theme.blue }}>user@host</span>
        <span style={{ color: fg }}>:</span>
        <span style={{ color: theme.cyan }}>~</span>
        <span style={{ color: fg }}>$ </span>
        <span className="terminal-preview-cursor" style={{ background: theme.cursor }} />
      </div>
    </div>
  )
}
