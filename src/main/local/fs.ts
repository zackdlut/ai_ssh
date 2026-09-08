import { createReadStream } from 'fs'
import { chmod, mkdir, readdir, readlink, rename, rm, stat, lstat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, isAbsolute, join, resolve, sep } from 'path'
import type {
  LocalEntry,
  LocalEntryType,
  SftpReadText,
  SftpStat
} from '../../shared/types'

/** Default cap for a single `readTextLocal` window. Matches the SFTP one. */
const READ_MAX_BYTES = 512 * 1024

/** Directories never worth walking into during a search. */
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules'])

export function localHome(): string {
  return homedir()
}

/**
 * Turn a user- or agent-supplied path into an absolute one.
 *
 * `base` is the directory a relative path is relative *to*. The file browser
 * has no such notion and omits it, but an agent working in a local tab says
 * `.` or `src/` meaning the shell's working directory, not the directory the
 * app happened to be launched from — resolving those against `process.cwd()`
 * would silently search the wrong tree.
 *
 * A leading `~` is expanded here rather than left to the shell, because these
 * calls do not go through one. Host memory asks for `~/AGENTS.md` on every
 * transport, and without this it would resolve to a literal `~` directory.
 */
export function resolveLocal(path: string, base?: string): string {
  let trimmed = path.trim()
  if (!trimmed) return base || homedir()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    trimmed = join(homedir(), trimmed.slice(2))
  }
  if (base && !isAbsolute(trimmed)) return resolve(base, trimmed)
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
        mtime: info.mtimeMs,
        mode: info.mode
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

/** Metadata of a local path, shaped like the SFTP one so callers cannot tell. */
export async function statLocal(path: string): Promise<SftpStat> {
  const full = resolveLocal(path)
  const info = await lstat(full)
  let type: LocalEntryType = 'other'
  if (info.isDirectory()) type = 'dir'
  else if (info.isSymbolicLink()) type = 'link'
  else if (info.isFile()) type = 'file'
  return { size: info.size, mode: info.mode, mtime: info.mtimeMs, type }
}

/**
 * Read a bounded byte window of a local file, decoded as UTF-8.
 *
 * The window, not just the cap, is what the file tools need: `read_file`
 * pages through a large file with `startByte`, and `edit_file` refuses to
 * rewrite anything whose first window came back `truncated`, because it would
 * otherwise write back a prefix and silently delete the rest.
 *
 * A stream rather than `readFile` so a multi-gigabyte log costs one window's
 * worth of memory instead of its whole size.
 */
export async function readTextLocal(
  path: string,
  opts?: { startByte?: number; maxBytes?: number }
): Promise<SftpReadText> {
  const full = resolveLocal(path)
  const info = await stat(full)
  if (info.isDirectory()) {
    throw new Error(`"${path}" is a directory, not a file.`)
  }
  const start = Math.max(0, Math.trunc(opts?.startByte ?? 0))
  const maxBytes = Math.max(1, Math.trunc(opts?.maxBytes ?? READ_MAX_BYTES))
  if (start >= info.size) {
    return { text: '', size: info.size, startByte: start, bytesRead: 0, truncated: false }
  }

  const end = Math.min(info.size - 1, start + maxBytes - 1)
  const chunks: Buffer[] = []
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(full, { start, end })
    stream.on('data', (chunk) => chunks.push(chunk as Buffer))
    stream.on('error', fail)
    stream.on('end', () => done())
  })
  const buffer = Buffer.concat(chunks)

  return {
    text: buffer.toString('utf8'),
    size: info.size,
    startByte: start,
    bytesRead: buffer.length,
    truncated: start + buffer.length < info.size
  }
}

/**
 * Overwrite a local file, keeping the permission bits it already had.
 *
 * Same reason as over SFTP: writing to a file the user made executable, or one
 * under `/etc` with a deliberately narrow mode, must not quietly reset it to
 * whatever the process umask says. A file that does not exist yet has no mode
 * to preserve, so it gets the default.
 */
export async function writeTextLocal(path: string, content: string): Promise<void> {
  const full = resolveLocal(path)
  const previousMode = await stat(full)
    .then((s) => s.mode & 0o7777)
    .catch(() => null)
  await writeFile(full, content, 'utf8')
  if (previousMode !== null) {
    try {
      await chmod(full, previousMode)
    } catch {
      // Windows only honours the read-only bit; failing to restore a POSIX
      // mode there is expected and not worth failing the write over.
    }
  }
}

export async function mkdirLocal(path: string): Promise<void> {
  await mkdir(resolveLocal(path), { recursive: true })
}

/** Absolute, symlink-resolved path, mirroring `sftpRealpath`. */
export async function realpathLocal(path: string): Promise<string> {
  const full = resolveLocal(path)
  try {
    const info = await lstat(full)
    if (info.isSymbolicLink()) {
      const target = await readlink(full)
      return isAbsolute(target) ? target : resolve(full, '..', target)
    }
  } catch {
    // A path that does not exist yet still has a meaningful absolute form.
  }
  return full
}

export async function deleteLocal(path: string, isDir: boolean): Promise<void> {
  await rm(path, { recursive: isDir, force: true })
}

// --- Search ---------------------------------------------------------------
//
// These replace `grep -rnIE` and `find` rather than shelling out to them.
// Neither exists on a stock Windows shell, and the quoting needed to pass a
// user's pattern through PowerShell or cmd intact differs from POSIX in ways
// that fail silently — an unmatched search looks identical to a search whose
// pattern was mangled. Walking the tree here is also the only way to report
// `truncated` honestly, which the piped `head -n` could only imply.

export interface LocalSearchOptions {
  /** Directory a relative `root` is resolved against. */
  cwd?: string
  /** Stop after this many results. */
  max: number
}

/** Search file contents, returning `path:line:text` records. */
export async function grepLocal(
  root: string,
  pattern: string,
  opts: LocalSearchOptions & { glob?: string }
): Promise<{ lines: string[]; truncated: boolean }> {
  let re: RegExp
  try {
    re = new RegExp(pattern)
  } catch (err) {
    throw new Error(`Invalid pattern: ${err instanceof Error ? err.message : String(err)}`)
  }
  const include = opts.glob ? globToRegExp(opts.glob) : null
  const lines: string[] = []
  let truncated = false

  for await (const file of walkFiles(resolveLocal(root, opts.cwd))) {
    // Basename only, matching what `grep --include` does with the same glob.
    if (include && !include.test(basename(file))) continue
    let text: string
    try {
      const read = await readTextLocal(file, { maxBytes: GREP_FILE_MAX_BYTES })
      // `grep -I` skips binaries; a NUL byte is the same heuristic it uses.
      if (read.text.includes('\0')) continue
      text = read.text
    } catch {
      continue
    }
    const fileLines = text.split('\n')
    for (let i = 0; i < fileLines.length; i++) {
      if (!re.test(fileLines[i])) continue
      lines.push(`${file}:${i + 1}:${fileLines[i]}`)
      if (lines.length >= opts.max) return { lines, truncated: true }
    }
  }
  return { lines, truncated }
}

/** List files whose name or path matches a glob. */
export async function globLocal(
  root: string,
  pattern: string,
  opts: LocalSearchOptions
): Promise<{ lines: string[]; truncated: boolean }> {
  const base = resolveLocal(root, opts.cwd)
  // A pattern containing a separator is a path shape (`**/conf.d/*.conf`), so
  // it is matched against the whole path; a bare one against the basename.
  //
  // The prefix a relative path shape gets is `**/`, not `*/`: candidates are
  // absolute, so the pattern has to reach across every directory above the
  // part the user wrote, and a single `*` stops at the first separator.
  const wholePath = pattern.includes('/')
  const re = globToRegExp(wholePath && !pattern.startsWith('/') ? `**/${pattern}` : pattern)
  const lines: string[] = []

  for await (const file of walkFiles(base)) {
    const candidate = wholePath ? file.split(sep).join('/') : basename(file)
    if (!re.test(candidate)) continue
    lines.push(file)
    if (lines.length >= opts.max) return { lines, truncated: true }
  }
  return { lines, truncated: false }
}

/** Largest file `grepLocal` will scan. Beyond this it is data, not source. */
const GREP_FILE_MAX_BYTES = 4 * 1024 * 1024

/**
 * Yield every file under `dir`, skipping the noise directories and anything
 * unreadable. Symlinks are not followed, which is also what keeps a cyclic
 * link from turning the walk into an infinite one.
 */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const full = join(dir, name)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(full)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      if (SEARCH_SKIP_DIRS.has(name)) continue
      yield* walkFiles(full)
    } else if (info.isFile()) {
      yield full
    }
  }
}

/**
 * Compile a glob to an anchored regular expression.
 *
 * `**` crosses directory separators and `*` does not, which is the distinction
 * that makes `**\/*.ts` and `*.ts` mean different things. Everything else is
 * escaped, so a pattern containing regex metacharacters matches them literally
 * the way a shell glob would.
 */
function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        // Swallow the separator after `**` so `**/x` also matches a bare `x`.
        if (glob[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
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
