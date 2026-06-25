import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({
  gfm: true,
  breaks: true
})

// Open links in the system browser (the window-open handler in the main
// process forwards them to the OS) instead of navigating the app.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

interface Props {
  text: string
}

/** Render a Markdown string into sanitized, styled HTML. */
export default function Markdown({ text }: Props): JSX.Element {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] })
  }, [text])

  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}
