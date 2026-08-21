/**
 * Mermaid optionally loads KaTeX for $$math$$ in diagrams. Electron asar does
 * not gzip JS, so the real package is ~480 kB on disk for a rarely used path.
 * Diagrams without math are unchanged; math labels fall back to the raw TeX.
 */
export function renderToString(tex: string): string {
  return tex
}

export function render(): void {
  /* no-op */
}

const katex = { renderToString, render }
export default katex
