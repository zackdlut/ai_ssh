/**
 * Unified-diff parsing and application, shared by the `apply_patch` tool and
 * the approval card that previews it.
 *
 * `edit_file` requires one exact, unique `old_string` per change, so a config
 * touched in four places costs four round trips — and each one re-reads a file
 * the previous edit just moved out from under the model. A patch expresses all
 * four in one call, and its context lines make each hunk self-locating rather
 * than globally unique.
 *
 * The line numbers in an `@@` header are treated as a HINT, not a contract.
 * Models miscount them constantly (and every earlier hunk shifts the ones after
 * it), so a hunk is located by matching its context and removed lines, starting
 * the search at the hinted position and walking outward. That is what `patch(1)`
 * does with its offset/fuzz behaviour, and for the same reason: a patch that
 * fails only because a line number drifted is a patch that was correct.
 */
import { applyUniqueEdit } from './textEdit'

export type PatchOp = 'context' | 'remove' | 'add'

export interface PatchLine {
  op: PatchOp
  text: string
}

export interface PatchHunk {
  /** 1-based old-file line from the `@@` header, used only as a search hint. */
  oldStart: number
  /**
   * Old-line count from the `@@` header. Only zero is load-bearing: it marks a
   * pure insertion, whose anchor is AFTER `oldStart` rather than at it.
   */
  oldCount: number
  /** 1-based new-file line from the `@@` header. */
  newStart: number
  lines: PatchLine[]
}

export interface ParsedPatch {
  hunks: PatchHunk[]
  /** Path from the `+++ b/...` header, when the patch carried one. */
  path?: string
}

export type ParseOutcome =
  | { ok: true; patch: ParsedPatch }
  | { ok: false; reason: 'empty' | 'no_hunks' | 'bad_hunk_header' | 'multi_file'; detail: string }

/** How far from the hinted line a hunk's context is searched for. */
const MAX_DRIFT_LINES = 2000

const HUNK_HEADER_RE = /^@@+\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@+/

/** Header lines that carry no content and appear before the first hunk. */
function isFileHeader(line: string): boolean {
  return (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('old mode ') ||
    line.startsWith('new mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('similarity index ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ')
  )
}

/** Strip a `a/` or `b/` prefix that git adds to the paths in its headers. */
function stripGitPrefix(path: string): string {
  const cleaned = path.trim().split('\t')[0]
  return cleaned.replace(/^[ab]\//, '')
}

export function parseUnifiedPatch(raw: string): ParseOutcome {
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!text.trim()) return { ok: false, reason: 'empty', detail: 'The patch is empty.' }

  const lines = text.split('\n')
  const hunks: PatchHunk[] = []
  let path: string | undefined
  let current: PatchHunk | undefined
  let seenPaths = 0

  for (const line of lines) {
    const header = HUNK_HEADER_RE.exec(line)
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        lines: []
      }
      hunks.push(current)
      continue
    }

    if (!current) {
      if (line.startsWith('+++ ')) {
        const candidate = stripGitPrefix(line.slice(4))
        if (candidate && candidate !== '/dev/null') {
          path = candidate
          seenPaths++
        }
        continue
      }
      // Anything before the first hunk that is not a header is prose the model
      // wrapped the patch in; ignore it rather than failing the whole call.
      continue
    }

    // Inside a hunk. A second file header ends this patch — this tool edits one
    // file per call, so a second one is a mistake worth naming.
    if (isFileHeader(line)) {
      if (line.startsWith('+++ ')) {
        const candidate = stripGitPrefix(line.slice(4))
        if (candidate && candidate !== '/dev/null' && candidate !== path) {
          return {
            ok: false,
            reason: 'multi_file',
            detail: `The patch touches more than one file (${path ?? '?'} and ${candidate}). Send one apply_patch call per file.`
          }
        }
      }
      current = undefined
      continue
    }

    // `\ No newline at end of file` annotates the previous line; it carries no
    // content of its own, and the trailing-newline state is preserved by the
    // split/join round trip either way.
    if (line.startsWith('\\')) continue

    if (line.startsWith('+')) current.lines.push({ op: 'add', text: line.slice(1) })
    else if (line.startsWith('-')) current.lines.push({ op: 'remove', text: line.slice(1) })
    else if (line.startsWith(' ')) current.lines.push({ op: 'context', text: line.slice(1) })
    // A blank body line is an empty context line whose single leading space was
    // stripped somewhere between the model and here. Common enough that
    // rejecting it would fail more good patches than it catches bad ones.
    else if (line === '') current.lines.push({ op: 'context', text: '' })
    else {
      // A body line with no recognizable prefix means the hunk ended and this
      // is trailing prose.
      current = undefined
    }
  }

  if (seenPaths > 1) {
    return {
      ok: false,
      reason: 'multi_file',
      detail: 'The patch declares more than one target file. Send one apply_patch call per file.'
    }
  }

  const nonEmpty = hunks.filter((h) => h.lines.length > 0)
  if (nonEmpty.length === 0) {
    return {
      ok: false,
      reason: 'no_hunks',
      detail:
        'No usable hunks found. A hunk starts with a line like `@@ -12,7 +12,8 @@`, followed by context lines prefixed with a space, removals with `-` and additions with `+`.'
    }
  }
  if (nonEmpty.some((h) => h.lines.every((l) => l.op === 'context'))) {
    return {
      ok: false,
      reason: 'no_hunks',
      detail: 'A hunk contains only context lines and would change nothing.'
    }
  }

  return { ok: true, patch: { hunks: nonEmpty, path } }
}

export interface AppliedHunk {
  /** 1-based index of the hunk within the patch. */
  index: number
  /** 1-based line in the ORIGINAL file where the hunk matched. */
  atLine: number
  /** Distance between the hinted line and where it actually matched. */
  offset: number
  /** True when the match ignored trailing whitespace. */
  fuzzy: boolean
}

export type PatchFailureReason =
  | 'parse'
  | 'context_mismatch'
  | 'overlap'
  | 'no_change'

export type PatchOutcome =
  | { ok: true; text: string; applied: AppliedHunk[]; path?: string }
  | { ok: false; reason: PatchFailureReason; detail: string; hunkIndex?: number }

function rtrim(line: string): string {
  return line.replace(/[ \t]+$/, '')
}

function matchesAt(lines: string[], expected: string[], pos: number, fuzzy: boolean): boolean {
  for (let i = 0; i < expected.length; i++) {
    const actual = lines[pos + i]
    if (actual === undefined) return false
    if (fuzzy ? rtrim(actual) !== rtrim(expected[i]) : actual !== expected[i]) return false
  }
  return true
}

/**
 * Locate the hunk's `expected` block, preferring the hinted position and
 * walking outward. `minPos` keeps hunks in order so two of them cannot claim
 * overlapping regions of the file.
 */
function findHunkPosition(
  lines: string[],
  expected: string[],
  hint: number,
  minPos: number
): { pos: number; fuzzy: boolean } | null {
  const last = lines.length - expected.length
  if (last < minPos) return null

  const start = Math.min(Math.max(hint, minPos), Math.max(minPos, last))
  // Exact matching is tried across the whole search window before any fuzzy
  // match is considered: a nearby exact match is always the right answer, even
  // when a whitespace-insensitive one sits closer to the hint.
  for (const fuzzy of [false, true]) {
    for (let drift = 0; drift <= MAX_DRIFT_LINES; drift++) {
      const forward = start + drift
      if (forward >= minPos && forward <= last && matchesAt(lines, expected, forward, fuzzy)) {
        return { pos: forward, fuzzy }
      }
      if (drift === 0) continue
      const back = start - drift
      if (back >= minPos && back <= last && matchesAt(lines, expected, back, fuzzy)) {
        return { pos: back, fuzzy }
      }
      if (start + drift > last && start - drift < minPos) break
    }
  }
  return null
}

/** The lines a hunk expects to find in the file, and the ones it leaves behind. */
function hunkSides(hunk: PatchHunk): { before: string[]; after: string[] } {
  const before: string[] = []
  const after: string[] = []
  for (const line of hunk.lines) {
    if (line.op !== 'add') before.push(line.text)
    if (line.op !== 'remove') after.push(line.text)
  }
  return { before, after }
}

/**
 * Render a hunk as the exact-replacement pair `edit_file` takes, so a hunk that
 * cannot be placed by context can still be retried through the unique-match
 * path. Returns null when the hunk has nothing to anchor on.
 */
export function hunkToExactEdit(hunk: PatchHunk): { oldString: string; newString: string } | null {
  const { before, after } = hunkSides(hunk)
  if (before.length === 0) return null
  const oldString = before.join('\n')
  const newString = after.join('\n')
  if (oldString === newString) return null
  return { oldString, newString }
}

function splitLines(text: string): string[] {
  return text.split('\n')
}

/**
 * Apply a parsed patch to `text`. Every hunk is matched against the ORIGINAL
 * line array and the splices are applied at the end, back to front, so one
 * hunk's edits never shift the coordinates another hunk was matched at. This is
 * also why the `@@` hints need no drift correction: in a unified diff the `-`
 * side line numbers are all in the original file's coordinate system.
 */
export function applyParsedPatch(text: string, patch: ParsedPatch): PatchOutcome {
  const lines = splitLines(text)
  const applied: AppliedHunk[] = []
  const edits: { pos: number; removeCount: number; insert: string[] }[] = []
  let minPos = 0

  for (const [i, hunk] of patch.hunks.entries()) {
    const { before, after } = hunkSides(hunk)
    // `@@ -5,0 +6,2 @@` means "insert after line 5", so a zero-length old side
    // anchors AFTER oldStart; every other hunk starts AT it.
    const hint = Math.max(0, hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1)

    if (before.length === 0) {
      // Pure insertion: nothing to match, so the hinted line is all there is.
      const pos = Math.min(Math.max(hint, minPos), lines.length)
      edits.push({ pos, removeCount: 0, insert: after })
      applied.push({ index: i + 1, atLine: pos + 1, offset: pos - hint, fuzzy: false })
      minPos = pos
      continue
    }

    const found = findHunkPosition(lines, before, hint, minPos)
    if (!found) {
      const overlapping = findHunkPosition(lines, before, hint, 0)
      if (overlapping) {
        return {
          ok: false,
          reason: 'overlap',
          hunkIndex: i + 1,
          detail: `Hunk ${i + 1} matches at line ${overlapping.pos + 1}, which an earlier hunk already changed. Hunks must be in file order and must not overlap.`
        }
      }
      return {
        ok: false,
        reason: 'context_mismatch',
        hunkIndex: i + 1,
        detail: `Hunk ${i + 1} does not match the file near line ${hunk.oldStart}. Its context/removed lines were:\n${before
          .slice(0, 8)
          .map((l) => `  ${l}`)
          .join('\n')}${before.length > 8 ? '\n  …' : ''}`
      }
    }

    edits.push({ pos: found.pos, removeCount: before.length, insert: after })
    applied.push({
      index: i + 1,
      atLine: found.pos + 1,
      offset: found.pos - hint,
      fuzzy: found.fuzzy
    })
    minPos = found.pos + before.length
  }

  const next = lines.slice()
  for (const edit of edits.slice().reverse()) {
    next.splice(edit.pos, edit.removeCount, ...edit.insert)
  }
  const result = next.join('\n')
  if (result === text) {
    return { ok: false, reason: 'no_change', detail: 'The patch applies cleanly but changes nothing.' }
  }
  return { ok: true, text: result, applied, path: patch.path }
}

/** Parse and apply in one step. */
export function applyUnifiedPatch(text: string, raw: string): PatchOutcome {
  const parsed = parseUnifiedPatch(raw)
  if (!parsed.ok) return { ok: false, reason: 'parse', detail: parsed.detail }
  return applyParsedPatch(text, parsed.patch)
}

/**
 * Retry a patch hunk by hunk through the exact-replacement path. Each hunk must
 * still match uniquely, so this recovers a bad `@@` header or stale context
 * padding without ever guessing which of several candidate sites was meant.
 */
function applyHunksAsExactEdits(text: string, patch: ParsedPatch): PatchOutcome {
  let current = text
  for (const [i, hunk] of patch.hunks.entries()) {
    const pair = hunkToExactEdit(hunk)
    if (!pair) {
      return {
        ok: false,
        reason: 'context_mismatch',
        hunkIndex: i + 1,
        detail: `Hunk ${i + 1} only adds lines and has no surrounding context, so it cannot be placed once its line numbers are wrong. Include a few unchanged lines above and below the insertion.`
      }
    }
    const edit = applyUniqueEdit(current, pair.oldString, pair.newString)
    if (!edit.ok) {
      return {
        ok: false,
        reason: 'context_mismatch',
        hunkIndex: i + 1,
        detail:
          edit.reason === 'ambiguous'
            ? `Hunk ${i + 1} matches ${edit.occurrences} places in the file. Add more context lines so it is unambiguous.`
            : `Hunk ${i + 1} does not match the file.`
      }
    }
    current = edit.text
  }
  if (current === text) {
    return { ok: false, reason: 'no_change', detail: 'The patch applies cleanly but changes nothing.' }
  }
  return {
    ok: true,
    text: current,
    applied: patch.hunks.map((_, i) => ({ index: i + 1, atLine: 0, offset: 0, fuzzy: true })),
    path: patch.path
  }
}

export type PatchApplyOutcome =
  | { ok: true; text: string; applied: AppliedHunk[]; path?: string; fellBack: boolean }
  | { ok: false; reason: PatchFailureReason; detail: string; hunkIndex?: number }

/**
 * Apply a patch, falling back to per-hunk exact replacement when the context
 * cannot be located. This — not `applyUnifiedPatch` — is what both the tool and
 * the approval-card preview call, so the card can never promise a result the
 * tool would refuse (or refuse one it would happily apply).
 */
export function applyPatchWithFallback(text: string, raw: string): PatchApplyOutcome {
  const parsed = parseUnifiedPatch(raw)
  if (!parsed.ok) return { ok: false, reason: 'parse', detail: parsed.detail }

  const direct = applyParsedPatch(text, parsed.patch)
  if (direct.ok) return { ...direct, fellBack: false }
  if (direct.reason !== 'context_mismatch' && direct.reason !== 'overlap') return direct

  const fallback = applyHunksAsExactEdits(text, parsed.patch)
  if (fallback.ok) return { ...fallback, fellBack: true }
  // Report the direct failure: it names the line the patch claimed, which is
  // more actionable than "the same text was not unique".
  return direct
}
