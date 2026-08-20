/**
 * Remote file tools for the agent loop.
 *
 * The copilot used to reach the host through a single `exec_command`, which
 * made every file change a blind `sed -i` / heredoc: nothing could be read back
 * reliably (shell capture clamps output), nothing could be previewed, and
 * nothing could be rolled back. These tools give the loop the missing half of
 * the "read -> edit -> verify" cycle.
 *
 * Reads and writes go over SFTP rather than the interactive shell, so they do
 * not fight the user for the terminal, are not clamped by the capture buffer,
 * and cannot be corrupted by shell quoting. Search still shells out (there is
 * no SFTP equivalent of grep) but returns structured results.
 */
import { useTabsStore, type TerminalTab } from '../store/tabsStore'
import { runAgentCommand } from './agentExec'
import { toolResultCharBudget } from './toolBudget'
import { computeTextDiff, formatDiffStat } from '../../shared/textDiff'
import { applyUniqueEdit, type EditOutcome } from '../../shared/textEdit'

export interface ToolResult {
  ok: boolean
  result?: string
  error?: string
}

/** Largest file `read_file` will page through in one call. */
const READ_WINDOW_BYTES = 512 * 1024
/** Default number of lines returned by read_file. */
const READ_DEFAULT_LINES = 800
/** Hard cap on lines returned in a single read_file call. */
const READ_MAX_LINES = 3000
/**
 * Ceiling on the characters one read_file result may return, whatever the
 * context window allows. Lines vary in width by orders of magnitude — 1000
 * lines of a dnf log is ~120k characters, several times a small model's whole
 * window — so a line count alone bounds nothing.
 */
const READ_MAX_RESULT_CHARS = 64 * 1024
/** Room left for the result header when budgeting lines. */
const READ_HEADER_RESERVE_CHARS = 400
/** Characters the line-number prefix adds per line. */
const LINE_PREFIX_CHARS = 8
/**
 * edit_file must load the whole file to guarantee `old_string` uniqueness, so
 * it refuses anything larger and tells the model to use a stream editor.
 */
const EDIT_MAX_BYTES = 512 * 1024
/** Files above this size skip the pre-write backup copy. */
const BACKUP_MAX_BYTES = 2 * 1024 * 1024
/** Default cap on grep/glob matches returned to the model. */
const SEARCH_DEFAULT_MAX = 100
const SEARCH_HARD_MAX = 500

interface ResolvedTab {
  tab: TerminalTab
  sessionId: string
}

/**
 * Resolve a tab_id to a live SFTP-capable session. WSL tabs are local pseudo
 * terminals with no SFTP channel, so they are rejected with a pointer to the
 * tool that does work there.
 */
function resolveSftpTab(tabId: string | undefined): ResolvedTab | { error: string } {
  if (!tabId) return { error: 'tab_id is required.' }
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId)
  if (!tab) return { error: `No open tab with id "${tabId}".` }
  if (tab.kind === 'wsl') {
    return {
      error: `Tab "${tabId}" is a local WSL terminal, which has no SFTP channel. Use exec_command (cat/sed/tee) for file work on this tab.`
    }
  }
  if (tab.status !== 'connected' || !tab.sessionId) {
    return { error: `Tab "${tabId}" is not connected (status: ${tab.status}).` }
  }
  return { tab, sessionId: tab.sessionId }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** Like `str` but preserves leading/trailing whitespace (file contents). */
function rawStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** Single-quote a value for safe interpolation into a POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Read a whole file, or fail when it exceeds `maxBytes`. */
async function readWholeFile(
  sessionId: string,
  path: string,
  maxBytes: number
): Promise<{ text: string } | { error: string }> {
  const res = await window.api.sftp.readText(sessionId, path, { maxBytes })
  if (res.error || !res.read) return { error: res.error ?? 'Failed to read the file.' }
  if (res.read.truncated) {
    return {
      error: `"${path}" is ${res.read.size} bytes, larger than the ${maxBytes}-byte limit for this tool. Use read_file with offset/limit to inspect it, or exec_command with sed/awk to modify it in place.`
    }
  }
  return { text: res.read.text }
}

/**
 * Copy a file to `<path>.bak.<timestamp>` before it is overwritten. Failures
 * are non-fatal and reported to the model as a note: losing a backup is worth
 * surfacing, but it should not block an edit the user already approved.
 */
async function backupRemoteFile(
  sessionId: string,
  path: string,
  content: string
): Promise<string | undefined> {
  if (content.length > BACKUP_MAX_BYTES) {
    return `backup skipped (file exceeds ${BACKUP_MAX_BYTES} bytes)`
  }
  const backupPath = `${path}.bak.${Date.now()}`
  const res = await window.api.sftp.writeText(sessionId, backupPath, content)
  if (res.error) return `backup failed: ${res.error}`
  return `backup: ${backupPath}`
}

/** Render file contents with 1-based line numbers, as `   12|text`. */
function withLineNumbers(lines: string[], firstLineNo: number): string {
  return lines
    .map((line, i) => `${String(firstLineNo + i).padStart(6, ' ')}|${line}`)
    .join('\n')
}

export async function readFile(args: Record<string, unknown>): Promise<ToolResult> {
  const resolved = resolveSftpTab(str(args.tab_id))
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const path = str(args.path)
  if (!path) return { ok: false, error: 'path is required.' }

  const offset = Math.max(1, num(args.offset) ?? 1)
  const limit = Math.min(READ_MAX_LINES, Math.max(1, num(args.limit) ?? READ_DEFAULT_LINES))

  const res = await window.api.sftp.readText(resolved.sessionId, path, {
    maxBytes: READ_WINDOW_BYTES
  })
  if (res.error || !res.read) return { ok: false, error: res.error ?? 'Failed to read the file.' }

  const allLines = res.read.text.split('\n')
  // A truncated byte window almost always cuts mid-line; drop the partial tail
  // so the model never sees a line that does not exist in the file.
  if (res.read.truncated && allLines.length > 1) allLines.pop()

  const slice = allLines.slice(offset - 1, offset - 1 + limit)
  if (slice.length === 0) {
    return {
      ok: true,
      result: `${path}: no lines at offset ${offset} (window holds ${allLines.length} lines).`
    }
  }

  // Page against the live budget the agent loop publishes. Returning fewer
  // lines with an accurate next offset costs a round trip; returning more than
  // the window holds costs the whole request.
  const resultCap = Math.min(READ_MAX_RESULT_CHARS, toolResultCharBudget())
  const notes: string[] = []
  let charBudget = resultCap - READ_HEADER_RESERVE_CHARS
  let kept = 0
  while (kept < slice.length && charBudget > 0) {
    charBudget -= slice[kept].length + LINE_PREFIX_CHARS
    kept++
  }
  if (kept < slice.length) {
    slice.length = Math.max(1, kept)
    notes.push(`stopped at this turn's ${resultCap}-character budget for one result`)
  }

  const lastLine = offset - 1 + slice.length
  if (lastLine < allLines.length) {
    notes.push(`more lines follow — call read_file again with offset=${lastLine + 1}`)
  }
  if (res.read.truncated) {
    notes.push(
      `file is ${res.read.size} bytes and only the first ${res.read.bytesRead} were read; use grep to locate a region instead of paging blindly`
    )
  }

  const header = `${path} (lines ${offset}-${lastLine}${notes.length ? `; ${notes.join('; ')}` : ''})`
  return { ok: true, result: `${header}\n${withLineNumbers(slice, offset)}` }
}

/**
 * Replace an exact substring in a remote file.
 *
 * `old_string` must match exactly once unless `replace_all` is set. That
 * constraint is the whole point: it turns "the model guessed a sed expression"
 * into a verifiable operation that either applies to the intended spot or fails
 * loudly with an actionable message.
 */
export async function editFile(args: Record<string, unknown>): Promise<ToolResult> {
  const resolved = resolveSftpTab(str(args.tab_id))
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const path = str(args.path)
  if (!path) return { ok: false, error: 'path is required.' }

  const oldString = rawStr(args.old_string)
  const newString = rawStr(args.new_string)
  if (oldString === undefined || newString === undefined) {
    return { ok: false, error: 'old_string and new_string are required.' }
  }

  const read = await readWholeFile(resolved.sessionId, path, EDIT_MAX_BYTES)
  if ('error' in read) return { ok: false, error: read.error }

  const edit = applyUniqueEdit(read.text, oldString, newString, args.replace_all === true)
  if (!edit.ok) return { ok: false, error: editFailureMessage(edit, path) }

  const backupNote = await backupRemoteFile(resolved.sessionId, path, read.text)
  const written = await window.api.sftp.writeText(resolved.sessionId, path, edit.text)
  if (written.error) return { ok: false, error: written.error }

  const diff = computeTextDiff(read.text, edit.text)
  const lines = [
    `edited: ${path}`,
    `replacements: ${edit.replacements}`,
    `diff: ${formatDiffStat(diff)}`
  ]
  if (backupNote) lines.push(backupNote)
  lines.push(
    'note: the file was changed but NOT verified — run an independent check (config test, service reload, re-read the region) before reporting success.'
  )
  return { ok: true, result: lines.join('\n') }
}

/** Turn a rejected edit into a message the model can actually act on. */
function editFailureMessage(edit: Extract<EditOutcome, { ok: false }>, path: string): string {
  switch (edit.reason) {
    case 'empty_old':
      return 'old_string must not be empty. Use write_file to create a new file.'
    case 'identical':
      return 'old_string and new_string are identical — nothing to change.'
    case 'not_found':
      return `old_string was not found in "${path}". Read the file first and copy the exact text (including indentation and line breaks) you want to replace.`
    case 'ambiguous':
      return `old_string matches ${edit.occurrences} times in "${path}". Add surrounding lines to make it unique, or set replace_all=true to change every occurrence.`
  }
}

export async function writeFile(args: Record<string, unknown>): Promise<ToolResult> {
  const resolved = resolveSftpTab(str(args.tab_id))
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const path = str(args.path)
  if (!path) return { ok: false, error: 'path is required.' }
  const content = rawStr(args.content)
  if (content === undefined) return { ok: false, error: 'content is required.' }

  // Read the previous contents (when the file exists) so the write can be
  // backed up and summarized as a diff rather than an opaque "wrote N bytes".
  const existing = await window.api.sftp.readText(resolved.sessionId, path, {
    maxBytes: BACKUP_MAX_BYTES
  })
  const previous = existing.read && !existing.read.truncated ? existing.read.text : undefined

  let backupNote: string | undefined
  if (previous !== undefined) {
    backupNote = await backupRemoteFile(resolved.sessionId, path, previous)
  }

  const written = await window.api.sftp.writeText(resolved.sessionId, path, content)
  if (written.error) return { ok: false, error: written.error }

  const lines = [`wrote: ${path}`, `bytes: ${content.length}`]
  if (previous === undefined) lines.push('created: new file')
  else lines.push(`diff: ${formatDiffStat(computeTextDiff(previous, content))}`)
  if (backupNote) lines.push(backupNote)
  return { ok: true, result: lines.join('\n') }
}

/**
 * Search file contents on the host. Shells out because there is no SFTP
 * equivalent, but the command is fully quoted, bounded, and its output is
 * returned as structured `path:line:text` records rather than raw terminal
 * text, so a failed search reports why instead of looking like an empty result.
 */
export async function grepFiles(args: Record<string, unknown>): Promise<ToolResult> {
  const resolved = resolveSftpTab(str(args.tab_id))
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const pattern = rawStr(args.pattern)
  if (!pattern) return { ok: false, error: 'pattern is required.' }

  const path = str(args.path) ?? '.'
  const glob = str(args.glob)
  const max = Math.min(SEARCH_HARD_MAX, Math.max(1, num(args.max_results) ?? SEARCH_DEFAULT_MAX))

  const parts = ['grep', '-rnIE', '--color=never', '--exclude-dir=.git', '--exclude-dir=node_modules']
  if (glob) parts.push(`--include=${shellQuote(glob)}`)
  parts.push('--', shellQuote(pattern), shellQuote(path))
  const command = `${parts.join(' ')} 2>/dev/null | head -n ${max}`

  const cap = await runAgentCommand(resolved.tab, command)
  if (cap.disconnected) {
    return { ok: false, error: `SSH session for tab "${resolved.tab.id}" disconnected during the search.` }
  }

  const matches = cap.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('grep:'))

  if (matches.length === 0) {
    return {
      ok: true,
      result: `No matches for /${pattern}/ under ${path}${glob ? ` (files matching ${glob})` : ''}.`
    }
  }

  const header =
    matches.length >= max
      ? `${matches.length}+ matches (truncated at ${max}) for /${pattern}/ under ${path}:`
      : `${matches.length} match(es) for /${pattern}/ under ${path}:`
  return { ok: true, result: `${header}\n${matches.join('\n')}` }
}

/** List files matching a name/path pattern on the host. */
export async function globFiles(args: Record<string, unknown>): Promise<ToolResult> {
  const resolved = resolveSftpTab(str(args.tab_id))
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const pattern = str(args.pattern)
  if (!pattern) return { ok: false, error: 'pattern is required.' }

  const path = str(args.path) ?? '.'
  const max = Math.min(SEARCH_HARD_MAX, Math.max(1, num(args.max_results) ?? SEARCH_DEFAULT_MAX))
  // A pattern containing a separator is a path shape (`**/conf.d/*.conf`), so
  // it has to be matched against the full path rather than the basename.
  const matcher = pattern.includes('/')
    ? `-path ${shellQuote(pattern.startsWith('/') ? pattern : `*${pattern}`)}`
    : `-name ${shellQuote(pattern)}`
  const command = `find ${shellQuote(path)} -not -path '*/.git/*' -not -path '*/node_modules/*' ${matcher} 2>/dev/null | head -n ${max}`

  const cap = await runAgentCommand(resolved.tab, command)
  if (cap.disconnected) {
    return { ok: false, error: `SSH session for tab "${resolved.tab.id}" disconnected during the search.` }
  }

  const found = cap.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('find:'))

  if (found.length === 0) {
    return { ok: true, result: `No files matching "${pattern}" under ${path}.` }
  }
  const header =
    found.length >= max
      ? `${found.length}+ files (truncated at ${max}) matching "${pattern}" under ${path}:`
      : `${found.length} file(s) matching "${pattern}" under ${path}:`
  return { ok: true, result: `${header}\n${found.join('\n')}` }
}
