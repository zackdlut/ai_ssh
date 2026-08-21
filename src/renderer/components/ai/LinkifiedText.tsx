import { splitByExternalUrls } from '../../../shared/externalUrl'

interface Props {
  text: string
}

/** Render plain text with http(s)/mailto/… spans turned into clickable links. */
export default function LinkifiedText({ text }: Props): JSX.Element {
  const parts = splitByExternalUrls(text)
  if (parts.length === 1 && !parts[0].href) return <>{text}</>
  return (
    <>
      {parts.map((part, i) =>
        part.href ? (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  )
}
