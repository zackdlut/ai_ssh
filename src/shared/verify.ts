/**
 * Deterministic Verify helpers for the SSH agent.
 *
 * The model used to judge success/failure purely by reading output text, which
 * is unreliable (a restart prints nothing, grep exits 1 without erroring, a curl
 * prints a page while the service is 500). Now that commands carry a real exit
 * code, this module turns the exit code + output into a structured signal:
 *  - signal layer: the shell exit code,
 *  - output layer: known error-pattern matching,
 * and classifies failures as retryable (transient) vs not (deterministic) so the
 * Error Recovery logic can back off vs change strategy instead of blindly
 * repeating a doomed command.
 */
export type FailureCategory = 'permission' | 'not_found' | 'network' | 'timeout' | 'generic'

export interface CommandVerdict {
  /** Overall status derived from exit code + output patterns. */
  status: 'success' | 'failed' | 'unknown'
  category?: FailureCategory
  /** True for transient failures worth retrying (network/timeout). */
  retryable: boolean
  /** Short human-readable hint shown to the model. */
  hint?: string
}

interface Pattern {
  re: RegExp
  category: FailureCategory
  retryable: boolean
  hint: string
}

const ERROR_PATTERNS: Pattern[] = [
  { re: /permission denied|operation not permitted|access denied|must be root|are you root/i, category: 'permission', retryable: false, hint: 'Permission denied — try sudo or a privileged user; do not blindly re-run the same command.' },
  { re: /command not found|not recognized as an internal|no such file or directory:.*\bnot found/i, category: 'not_found', retryable: false, hint: 'Command or file not found — check the path or try an alternative tool.' },
  { re: /connection refused|could not resolve host|network is unreachable|no route to host|connection timed out|temporary failure in name resolution/i, category: 'network', retryable: true, hint: 'Network error — the target may be down or unreachable; a retry may help, otherwise check connectivity.' },
  { re: /\btimed? out\b|timeout/i, category: 'timeout', retryable: true, hint: 'The operation timed out — consider retrying or increasing the timeout.' }
]

/**
 * Exit codes that reliably indicate a failure. Note: a non-zero exit is NOT
 * always an error (e.g. `grep` returns 1 for "no match", `test` returns 1 for
 * false), so we do not flag every non-zero code as failed — we surface it and
 * let output patterns / the model decide, but 126/127 (not executable / not
 * found) are unambiguous.
 */
function hardFailureExit(code: number): boolean {
  return code === 126 || code === 127
}

/**
 * Evaluate a command's result. `exitCode` may be null when it could not be
 * determined (older shells / capture timeout), in which case we fall back to
 * output patterns only and report 'unknown' when nothing matches.
 */
export function verifyCommand(output: string, exitCode: number | null): CommandVerdict {
  const text = output || ''
  const matched = ERROR_PATTERNS.find((p) => p.re.test(text))

  // Exit code is the primary signal when we have it: a zero exit means success
  // even if the output mentions "permission denied" for some individual item
  // (partial, non-fatal). Only surface an advisory hint in that case.
  if (exitCode === 0) {
    return matched
      ? { status: 'success', category: matched.category, retryable: false, hint: `note: exit 0 but output mentions "${matched.category}" for some items — verify it is not a partial failure.` }
      : { status: 'success', retryable: false }
  }

  // Non-zero or unknown: an error pattern pins down the category + retryability.
  if (matched) {
    return { status: 'failed', category: matched.category, retryable: matched.retryable, hint: matched.hint }
  }

  if (exitCode === null) {
    return { status: 'unknown', retryable: false }
  }
  if (hardFailureExit(exitCode)) {
    return {
      status: 'failed',
      category: exitCode === 127 ? 'not_found' : 'generic',
      retryable: false,
      hint:
        exitCode === 127
          ? 'Command not found (exit 127) — verify it is installed or use another tool.'
          : 'Command not executable (exit 126) — check permissions/path.'
    }
  }
  // Non-zero but ambiguous: report as failed-generic but non-retryable so the
  // model interprets it (some tools use non-zero for legitimate "no match").
  return {
    status: 'failed',
    category: 'generic',
    retryable: false,
    hint: `Command exited non-zero (exit ${exitCode}); confirm whether this indicates a real failure for this command.`
  }
}
