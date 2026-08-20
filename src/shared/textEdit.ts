/**
 * Exact-match text editing, shared by the `edit_file` tool and the approval
 * card that previews it.
 *
 * The uniqueness rule is the whole reason this exists. A model asked to change
 * one line of a config will happily emit a `sed -i` whose pattern also matches
 * three other lines, and nothing about the result says so. Requiring
 * `old_string` to occur exactly once turns the edit into an operation that
 * either lands where intended or fails with something the model can act on.
 */

export type EditOutcome =
  | { ok: true; text: string; replacements: number }
  | { ok: false; reason: 'empty_old' | 'identical' | 'not_found' | 'ambiguous'; occurrences: number }

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/**
 * Apply an exact-string edit. Without `replaceAll`, `oldString` must occur
 * exactly once; with it, every occurrence is replaced.
 */
export function applyUniqueEdit(
  text: string,
  oldString: string,
  newString: string,
  replaceAll = false
): EditOutcome {
  if (oldString === '') return { ok: false, reason: 'empty_old', occurrences: 0 }
  if (oldString === newString) return { ok: false, reason: 'identical', occurrences: 0 }

  const occurrences = countOccurrences(text, oldString)
  if (occurrences === 0) return { ok: false, reason: 'not_found', occurrences: 0 }
  if (occurrences > 1 && !replaceAll) return { ok: false, reason: 'ambiguous', occurrences }

  return {
    ok: true,
    // `split/join` rather than a regex: `oldString` is literal text and may
    // contain characters a RegExp would interpret, and `String.replace` with a
    // string pattern would also expand `$&` in the replacement.
    text: replaceAll ? text.split(oldString).join(newString) : replaceOnce(text, oldString, newString),
    replacements: replaceAll ? occurrences : 1
  }
}

function replaceOnce(text: string, oldString: string, newString: string): string {
  const idx = text.indexOf(oldString)
  if (idx === -1) return text
  return text.slice(0, idx) + newString + text.slice(idx + oldString.length)
}
