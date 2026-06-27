import { readdir, rename, rm, stat, lstat } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve } from 'path'
import type { LocalEntry, LocalEntryType } from '../../shared/types'

export function localHome(): string {
  return homedir()
}

export function resolveLocal(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return homedir()
  return resolve(trimmed)
}

export async function listLocal(path: string): Promise<{ cwd: string; entries: LocalEntry[] }> {
  const cwd = resolveLocal(path)
  const names = await readdir(cwd)
  const entries: LocalEntry[] = []

  for (const name of names) {
    const fullPath = resolve(cwd, name)
    try {
      const info = await lstat(fullPath)
      let type: LocalEntryType = 'other'
      if (info.isDirectory()) type = 'dir'
      else if (info.isSymbolicLink()) type = 'link'
      else if (info.isFile()) type = 'file'

      let size = info.size
      if (type === 'link') {
        try {
          const target = await stat(fullPath)
          if (target.isFile()) size = target.size
        } catch {
          /* keep link stat size */
        }
      }

      entries.push({
        name,
        path: fullPath,
        type,
        size,
        mtime: info.mtimeMs
      })
    } catch {
      /* skip entries we cannot stat */
    }
  }

  entries.sort((a, b) => {
    const ad = a.type === 'dir' ? 0 : 1
    const bd = b.type === 'dir' ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.name.localeCompare(b.name)
  })

  return { cwd, entries }
}

export async function renameLocal(from: string, to: string): Promise<void> {
  await rename(from, to)
}

export async function deleteLocal(path: string, isDir: boolean): Promise<void> {
  await rm(path, { recursive: isDir, force: true })
}

export async function countLocalTransferFiles(paths: string[]): Promise<number> {
  let total = 0
  for (const path of paths) {
    total += await countLocalPathFiles(path)
  }
  return total
}

async function countLocalPathFiles(path: string): Promise<number> {
  const info = await stat(path)
  if (info.isFile()) return 1
  if (!info.isDirectory()) return 0
  const names = await readdir(path)
  let count = 0
  for (const name of names) {
    count += await countLocalPathFiles(join(path, name))
  }
  return count
}
