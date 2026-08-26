/**
 * Composer @path mentions. Only `@/` `@./` `@~/` count as files so `@nginx`
 * keeps meaning a host.
 */
import type { PinResolution } from './pinnedTerminal'

export interface FileMentionSpan {
  start: number
  end: number
  path: string
}

const FILE_MENTION_RE = /@(?:\/|\.\/|~\/)[^\s,;:!?]+/g

export function isFilePathMentionQuery(query: string): boolean {
  return query.startsWith('/') || query.startsWith('./') || query.startsWith('~/')
}

export function findFileMentionSpans(text: string): FileMentionSpan[] {
  const spans: FileMentionSpan[] = []
  const re = new RegExp(FILE_MENTION_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      path: match[0].slice(1)
    })
  }
  return spans
}

export function extractFileMentionPaths(text: string): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const span of findFileMentionSpans(text)) {
    if (seen.has(span.path)) continue
    seen.add(span.path)
    paths.push(span.path)
  }
  return paths
}

/** Expand `~/` using the SSH username when we have one. */
export function expandMentionPath(path: string, username?: string): string {
  if (!path.startsWith('~/')) return path
  if (!username) return path
  const home = username === 'root' ? '/root' : `/home/${username}`
  return home + path.slice(1)
}

/** @path with no live pin needs the same terminal picker as @terminal. */
export function needsFileMentionPicker(prompt: string, pin: PinResolution): boolean {
  if (pin.status === 'live') return false
  return extractFileMentionPaths(prompt).length > 0
}
