import type { SftpEntryType } from '../../../shared/types'

export function parentDir(path: string): string {
  if (path === '/' || !path) return '/'
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

export function joinPath(dir: string, name: string): string {
  return `${dir.endsWith('/') ? dir.slice(0, -1) : dir}/${name}`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface FileEntry {
  name: string
  path: string
  type: SftpEntryType
  size: number
  mtime: number
}

export type SortColumn = 'name' | 'size' | 'mtime'
export type SortDirection = 'asc' | 'desc'

export function sortEntries(
  entries: FileEntry[],
  column: SortColumn,
  direction: SortDirection
): FileEntry[] {
  const mul = direction === 'asc' ? 1 : -1
  const dirFirst = (a: FileEntry, b: FileEntry): number => {
    const ad = a.type === 'dir' ? 0 : 1
    const bd = b.type === 'dir' ? 0 : 1
    return ad - bd
  }

  return [...entries].sort((a, b) => {
    if (column === 'name') {
      const dw = dirFirst(a, b)
      if (dw !== 0) return dw * mul
      return mul * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    }
    if (column === 'size') {
      const dw = dirFirst(a, b)
      if (dw !== 0) return dw
      return mul * (a.size - b.size)
    }
    return mul * (a.mtime - b.mtime)
  })
}

export function toggleSelection(
  selected: Set<string>,
  path: string,
  paths: string[],
  opts: { shift: boolean; toggle: boolean }
): Set<string> {
  const next = new Set(selected)
  if (opts.shift && paths.length > 0) {
    const anchor = paths.find((p) => selected.has(p)) ?? path
    const start = paths.indexOf(anchor)
    const end = paths.indexOf(path)
    if (start >= 0 && end >= 0) {
      const [lo, hi] = start < end ? [start, end] : [end, start]
      for (let i = lo; i <= hi; i++) next.add(paths[i])
      return next
    }
  }
  if (opts.toggle) {
    if (next.has(path)) next.delete(path)
    else next.add(path)
  } else {
    next.clear()
    next.add(path)
  }
  return next
}
