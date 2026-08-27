/**
 * Harness-side enforcement of plan step assertions.
 *
 * The prompt's rule — "a task that CHANGES state is confirmed only by an
 * INDEPENDENT check" — was a soft constraint: nothing measured whether the
 * check happened, so a model that restarted a service and announced success
 * produced exactly the same trace as one that verified it. This module turns
 * the rule into something testable. A step may declare the command that proves
 * it; the loop then compares that claim against the commands actually executed
 * and refuses to let the turn end while a claim is unmet.
 *
 * Matching is deliberately loose about form and strict about outcome. An agent
 * that wrote `systemctl is-active nginx` when the plan said
 * `systemctl is-active nginx.service` has done the work, and failing it for
 * punctuation would teach the model to stop declaring checks at all. But an
 * exit code that does not match, or output that does not match the expected
 * pattern, is a failed verification no matter how the command was spelled.
 */
import type { PlanItem } from './types'

/** One command the agent really ran, with its result. */
export interface ExecEvidence {
  command: string
  exitCode: number | null
  output: string
}

export type StepVerifyState =
  /** The step declared no check. */
  | { kind: 'none' }
  /** The declared check has not been run yet. */
  | { kind: 'missing' }
  /** The check ran and its result contradicts the assertion. */
  | { kind: 'failed'; reason: string }
  | { kind: 'passed' }

/**
 * Reduce a command to the tokens that identify it, dropping the noise that
 * varies between two correct spellings of the same check: quoting, the `sudo`
 * prefix, `.service` suffixes, and short flags.
 */
function commandTokens(command: string): string[] {
  return command
    .toLowerCase()
    .replace(/["'`]/g, '')
    .split(/[\s|;&]+/)
    .map((tok) => tok.replace(/\.service$/, '').replace(/[,.]+$/, ''))
    .filter((tok) => tok.length > 0 && !tok.startsWith('-'))
}

/**
 * True when `actual` plausibly IS the declared check: every meaningful token of
 * the declaration appears in what ran. Extra tokens are fine — an agent that
 * added `--no-pager` or piped to `head` still ran the check.
 */
export function commandMatches(declared: string, actual: string): boolean {
  const want = commandTokens(declared)
  if (want.length === 0) return false
  const got = new Set(commandTokens(actual))
  return want.every((tok) => got.has(tok))
}

function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

/** Evaluate one step's assertion against everything the agent has run. */
export function verifyPlanStep(item: PlanItem, evidence: readonly ExecEvidence[]): StepVerifyState {
  const check = item.verify
  if (!check || !check.command.trim()) return { kind: 'none' }

  // Latest run wins: an agent that fixed the problem and re-checked should not
  // be held to the failing first attempt.
  const matches = evidence.filter((e) => commandMatches(check.command, e.command))
  const run = matches[matches.length - 1]
  if (!run) return { kind: 'missing' }

  const expected = check.expectExitCode ?? 0
  if (run.exitCode !== expected) {
    return {
      kind: 'failed',
      reason: `\`${run.command}\` exited ${run.exitCode ?? 'unknown'}, but the step expects ${expected}`
    }
  }

  if (check.expectOutput) {
    const re = safeRegExp(check.expectOutput)
    if (!re) {
      // An unparseable pattern is the plan's bug, not the host's. Treat the
      // exit-code half as the whole assertion rather than blocking forever on a
      // regex the model cannot see is broken.
      return { kind: 'passed' }
    }
    if (!re.test(run.output)) {
      return {
        kind: 'failed',
        reason: `\`${run.command}\` succeeded but its output does not match /${check.expectOutput}/`
      }
    }
  }
  return { kind: 'passed' }
}

export interface UnmetStep {
  item: PlanItem
  state: Extract<StepVerifyState, { kind: 'missing' | 'failed' }>
}

/**
 * Steps the agent has marked completed (or is currently on) whose declared
 * check has not actually passed. A pending step is not listed: it has not been
 * claimed yet, and the plan's own "keep going" nudge already covers it.
 */
export function unmetPlanSteps(
  plan: readonly PlanItem[] | undefined,
  evidence: readonly ExecEvidence[]
): UnmetStep[] {
  if (!plan || plan.length === 0) return []
  const unmet: UnmetStep[] = []
  for (const item of plan) {
    if (item.status !== 'completed' && item.status !== 'in_progress') continue
    const state = verifyPlanStep(item, evidence)
    if (state.kind === 'missing' || state.kind === 'failed') unmet.push({ item, state })
  }
  return unmet
}

/**
 * The message injected when the model tries to finish with an unmet assertion.
 * Written as an instruction rather than an error: the model's next move is to
 * run the check, not to apologize.
 */
export function unmetStepsPrompt(unmet: readonly UnmetStep[]): string {
  const lines = unmet.map(({ item, state }) =>
    state.kind === 'missing'
      ? `- "${item.title}": the check \`${item.verify?.command}\` has not been run.`
      : `- "${item.title}": ${state.reason}.`
  )
  return `Verification checkpoint: you cannot report this task as done yet. These plan steps declared an independent check that has not passed:
${lines.join('\n')}

Run the missing check(s) now with a tool call. If a check FAILED, the task did not succeed — diagnose it, or report the failure with the evidence. If a check is no longer the right proof, call update_plan to correct or drop it, and say why. Do not simply repeat that the work is complete.`
}
