/**
 * Git tools for remote repositories.
 *
 * `exec_command` can already run git, and `toolPolicy` already classifies
 * `git status` as read-only and `git commit` as mutating. What it cannot do is
 * guarantee that classification: the model composes the command string, so one
 * `git log --oneline && rm -rf build` slips past the allowlist check as a
 * pipeline the policy has to reason about, and one `git diff` on a large repo
 * dumps unbounded output into the window.
 *
 * These tools invert that. The command is composed HERE from a fixed
 * subcommand enum and shell-quoted arguments, so `git_read` cannot express a
 * write at all — which is what lets it sit in READONLY_TOOLS and run without an
 * approval click even in Plan mode. `git_commit` is the single write, and it
 * always goes through the approval card.
 */
import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'
import { runAgentCommand } from './agentExec'
import { shellQuote, type ToolResult } from './fileTools'
import { toolResultCharBudget } from './toolBudget'

/** Read subcommands `git_read` is allowed to compose. */
export const GIT_READ_SUBCOMMANDS = ['status', 'diff', 'log', 'show', 'branch'] as const
export type GitReadSubcommand = (typeof GIT_READ_SUBCOMMANDS)[number]

/** Default and maximum entries returned by `log`. */
const LOG_DEFAULT_LIMIT = 20
const LOG_MAX_LIMIT = 200
/** Ceiling on a git result, whatever the turn's budget allows. */
const GIT_MAX_RESULT_CHARS = 32 * 1024

/**
 * Characters a ref may contain. Deliberately narrower than git's own rules: it
 * excludes everything the shell would interpret, so a ref cannot smuggle a
 * second command past the quoting, and a leading `-` is rejected separately so
 * a ref cannot turn into an option.
 */
const REF_RE = /^[A-Za-z0-9._/@^~-]+$/

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

function resolveTab(tabId: string | undefined): { tab: TerminalSession } | { error: string } {
  if (!tabId) return { error: 'tab_id is required.' }
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === tabId)
  if (!tab) return { error: `No open tab with id "${tabId}".` }
  if (tab.status !== 'connected' || !tab.sessionId) {
    return { error: `Tab "${tabId}" is not connected (status: ${tab.status}).` }
  }
  return { tab }
}

/** A path or ref beginning with `-` would be read by git as an option. */
function rejectsAsOption(value: string): boolean {
  return value.startsWith('-')
}

function validateRef(ref: string): string | undefined {
  if (rejectsAsOption(ref)) return `"${ref}" starts with "-", which git would read as an option.`
  if (!REF_RE.test(ref)) {
    return `"${ref}" is not a valid ref. Use a branch, tag or commit id (letters, digits and . _ / @ ^ ~ -).`
  }
  return undefined
}

/** `git -C <repo> --no-pager` prefix; the pager would never return over exec. */
function gitPrefix(repo: string): string {
  return `git -C ${shellQuote(repo)} --no-pager`
}

function buildReadCommand(
  sub: GitReadSubcommand,
  repo: string,
  opts: { ref?: string; path?: string; staged?: boolean; limit?: number }
): string {
  const git = gitPrefix(repo)
  const pathSuffix = opts.path ? ` -- ${shellQuote(opts.path)}` : ''
  switch (sub) {
    case 'status':
      return `${git} status --short --branch`
    case 'diff':
      return `${git} diff --stat --patch${opts.staged ? ' --staged' : ''}${
        opts.ref ? ` ${opts.ref}` : ''
      }${pathSuffix}`
    case 'log':
      return `${git} log --oneline --decorate --max-count=${opts.limit ?? LOG_DEFAULT_LIMIT}${
        opts.ref ? ` ${opts.ref}` : ''
      }${pathSuffix}`
    case 'show':
      return `${git} show --stat --patch ${opts.ref ?? 'HEAD'}${pathSuffix}`
    case 'branch':
      return `${git} branch --verbose --all`
  }
}

/** Cap the returned text against the calling turn's per-result budget. */
function clampResult(text: string, budgetChars?: number): string {
  const cap = Math.min(
    GIT_MAX_RESULT_CHARS,
    Math.max(1000, toolResultCharBudget(budgetChars))
  )
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n… (truncated at ${cap} characters; narrow the request with path or limit)`
}

function formatResult(
  command: string,
  res: { output: string; exitCode: number | null; cwd: string | null },
  budgetChars?: number
): string {
  const body = res.output.trim()
  return [
    `command: ${command}`,
    `exit_code: ${res.exitCode ?? 'unknown'}`,
    'output:',
    body ? clampResult(body, budgetChars) : '(no output)'
  ].join('\n')
}

/**
 * Run one read-only git command in a repository on the host.
 *
 * Every argument is either a fixed enum member or shell-quoted, so this cannot
 * be steered into a write. That is a property of the code, not of a regex over
 * a model-authored string — which is why the approval policy can trust it.
 */
export async function gitRead(
  args: Record<string, unknown>,
  ctx?: { resultCharBudget?: number }
): Promise<ToolResult> {
  const resolved = resolveTab(str(args.tab_id))
  if ('error' in resolved) return { ok: false, error: resolved.error }

  const sub = str(args.subcommand) as GitReadSubcommand | undefined
  if (!sub || !GIT_READ_SUBCOMMANDS.includes(sub)) {
    return {
      ok: false,
      error: `subcommand must be one of ${GIT_READ_SUBCOMMANDS.join(', ')}.`
    }
  }
  const repo = str(args.repo) ?? '.'
  if (rejectsAsOption(repo)) return { ok: false, error: 'repo must be a directory path.' }

  const ref = str(args.ref)
  if (ref) {
    const invalid = validateRef(ref)
    if (invalid) return { ok: false, error: invalid }
  }
  const path = str(args.path)
  if (path && rejectsAsOption(path)) {
    return { ok: false, error: 'path must be a file or directory path, not an option.' }
  }
  const limit = Math.min(LOG_MAX_LIMIT, Math.max(1, num(args.limit) ?? LOG_DEFAULT_LIMIT))

  const command = buildReadCommand(sub, repo, {
    ref,
    path,
    staged: args.staged === true,
    limit
  })
  const res = await runAgentCommand(resolved.tab, command)
  if (res.disconnected) {
    return { ok: false, error: `SSH session for tab "${resolved.tab.id}" disconnected during git ${sub}.` }
  }
  // A non-zero exit is reported as a successful CALL with a failing command:
  // `git diff` in a directory that is not a repo is information the model needs
  // to act on, not a tool malfunction.
  return { ok: true, result: formatResult(command, res, ctx?.resultCharBudget) }
}

/**
 * Create a commit in a repository on the host. Always goes through approval —
 * it is the only git tool that writes.
 */
export async function gitCommit(args: Record<string, unknown>): Promise<ToolResult> {
  const resolved = resolveTab(str(args.tab_id))
  if ('error' in resolved) return { ok: false, error: resolved.error }

  const repo = str(args.repo) ?? '.'
  if (rejectsAsOption(repo)) return { ok: false, error: 'repo must be a directory path.' }
  const message = str(args.message)
  if (!message) return { ok: false, error: 'message is required.' }

  const git = gitPrefix(repo)
  const stage = args.stage_all === true ? `${git} add -A && ` : ''
  const command = `${stage}${git} commit -m ${shellQuote(message)}`

  const res = await runAgentCommand(resolved.tab, command)
  if (res.disconnected) {
    return { ok: false, error: `SSH session for tab "${resolved.tab.id}" disconnected during the commit.` }
  }
  if (res.exitCode !== 0) {
    return {
      ok: false,
      error: `${formatResult(command, res)}\nnote: nothing was committed. "nothing to commit" means the changes are not staged — set stage_all, or stage them first.`
    }
  }
  return {
    ok: true,
    result: `${formatResult(command, res)}\nnote: the commit exists locally on the host; it has NOT been pushed.`
  }
}
