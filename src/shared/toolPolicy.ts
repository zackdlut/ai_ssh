/**
 * Approval policy for agent tool calls.
 *
 * The rule this replaces was `readonly ? auto : ask`, with one exception that
 * made `exec_command` auto unless it matched a destructive regex. The result
 * was backwards in both directions: changing the app's color theme demanded an
 * approval click, while `systemctl stop nginx` ran unattended because it is not
 * in the destructive list. Risk lives in what a call DOES, not in whether it is
 * shaped like a shell command.
 *
 * Decisions are made from three inputs: the tool, the concrete command being
 * run (for `exec_command`), and how much autonomy the user granted. Commands
 * are classified by an explicit read-only allowlist first, so the common
 * investigative loop (`ls`, `cat`, `ps`, `systemctl status`, `journalctl`)
 * flows without interruption while anything that writes has to be recognized as
 * safe rather than merely fail to look dangerous.
 */
import { isDangerous } from './dangerousCommands'
import { isAutoApprovedTool } from './aiTools'
import type { AutonomyMode } from './types'

export const DEFAULT_AUTONOMY_MODE: AutonomyMode = 'balanced'

export type ToolDecision =
  /** Run immediately. */
  | 'auto'
  /** Show an approval card and wait. */
  | 'ask'
  /** Refuse outright; never offered as a one-click approval. */
  | 'deny'

/**
 * Commands that only observe. Matched against the first word of each stage of
 * the pipeline, so `ps aux | grep nginx` is read-only but
 * `cat x > /etc/hosts` is not (the redirect check below catches it).
 */
const READONLY_COMMANDS = new Set([
  'ls', 'll', 'dir', 'pwd', 'cd', 'echo', 'cat', 'head', 'tail', 'less', 'more',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'sed', 'cut', 'sort', 'uniq', 'wc',
  'tr', 'column', 'jq', 'yq', 'xxd', 'od', 'strings', 'file', 'stat', 'realpath',
  'basename', 'dirname', 'readlink', 'find', 'locate', 'which', 'whereis', 'type',
  'du', 'df', 'free', 'uptime', 'top', 'htop', 'vmstat', 'iostat', 'mpstat', 'sar',
  'ps', 'pgrep', 'lsof', 'ss', 'netstat', 'ip', 'ifconfig', 'route', 'arp',
  'ping', 'traceroute', 'mtr', 'dig', 'nslookup', 'host', 'curl', 'wget',
  'uname', 'hostname', 'hostnamectl', 'id', 'whoami', 'groups', 'w', 'who', 'last',
  'date', 'env', 'printenv', 'locale', 'lscpu', 'lsblk', 'lspci', 'lsusb', 'blkid',
  'mount', 'dmesg', 'journalctl', 'tee', 'diff', 'cmp', 'md5sum', 'sha256sum',
  'git', 'docker', 'kubectl', 'systemctl', 'service', 'crontab', 'ulimit', 'nproc',
  'true', 'false', 'test', 'sleep', 'seq', 'xargs', 'timeout', 'nice', 'time'
])

/**
 * Subcommands that make an otherwise-observational tool mutating. `git status`
 * is safe; `git push` is not, and neither reads as dangerous to a regex.
 */
const MUTATING_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(['push', 'commit', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'clean', 'am', 'apply', 'cherry-pick', 'revert', 'stash', 'tag', 'pull', 'fetch', 'clone', 'init', 'rm', 'mv', 'restore']),
  docker: new Set(['run', 'exec', 'rm', 'rmi', 'kill', 'stop', 'start', 'restart', 'build', 'push', 'pull', 'prune', 'create', 'compose', 'commit', 'load', 'import', 'network', 'volume', 'system']),
  kubectl: new Set(['apply', 'delete', 'create', 'edit', 'patch', 'replace', 'scale', 'rollout', 'drain', 'cordon', 'uncordon', 'taint', 'label', 'annotate', 'exec', 'cp', 'run']),
  systemctl: new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask', 'set-property', 'kill', 'isolate', 'daemon-reload', 'reset-failed', 'edit']),
  service: new Set(['start', 'stop', 'restart', 'reload', 'force-reload']),
  crontab: new Set(['-r', '-e']),
  ip: new Set(['addr', 'address', 'link', 'route', 'rule', 'netns']),
  mount: new Set([]),
  tee: new Set([])
}

/** Subcommands that keep the parent read-only even though it usually mutates. */
const READONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  ip: new Set(['show', 'list', 'get']),
  crontab: new Set(['-l'])
}

/** Shell metacharacters that turn an observational command into a write. */
const WRITE_REDIRECT_RE = />{1,2}\s*[^&\s]|>\|/

function firstWord(stage: string): string {
  // Strip `sudo`, `nohup`, and leading `VAR=value` assignments to reach the
  // real command; each of them hides what is actually about to run.
  const cleaned = stage
    .trim()
    .replace(/^(?:sudo(?:\s+-\w+)*\s+|nohup\s+|env\s+|[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '')
  return cleaned.split(/\s+/)[0] ?? ''
}

function secondWord(stage: string): string {
  const cleaned = stage
    .trim()
    .replace(/^(?:sudo(?:\s+-\w+)*\s+|nohup\s+|env\s+|[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '')
  return cleaned.split(/\s+/)[1] ?? ''
}

/** True when `sudo` escalates this command; escalation always deserves a look. */
export function usesSudo(command: string): boolean {
  return /(^|[|;&]\s*)sudo\b/.test(command)
}

/**
 * Classify a shell command as read-only. Conservative by construction:
 * anything not positively recognized is treated as mutating.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (WRITE_REDIRECT_RE.test(trimmed)) return false
  if (usesSudo(trimmed)) return false
  // Command substitution can hide anything at all inside an innocent-looking
  // wrapper, so it disqualifies the whole command.
  if (/\$\(|`/.test(trimmed)) return false

  const stages = trimmed.split(/\|\||&&|[|;]/)
  for (const stage of stages) {
    if (!stage.trim()) continue
    const cmd = firstWord(stage)
    if (!cmd) return false
    const base = cmd.split('/').pop() ?? cmd
    if (!READONLY_COMMANDS.has(base)) return false

    const sub = secondWord(stage)
    if (READONLY_SUBCOMMANDS[base]?.has(sub)) continue
    if (MUTATING_SUBCOMMANDS[base]?.has(sub)) return false
    // `sed -i` and `tee` without a subcommand rewrite files in place.
    if (base === 'sed' && /\s-[a-zA-Z]*i\b/.test(stage)) return false
    if (base === 'tee') return false
    if (base === 'mount' && sub) return false
  }
  return true
}

export interface PolicyInput {
  tool: string
  /** Raw JSON arguments string as emitted by the model. */
  argsJson?: string
  mode: AutonomyMode
  /**
   * Tools the user chose to always allow for the rest of this chat, via the
   * approval card. Session-scoped on purpose: a blanket grant that outlives the
   * task it was given for is a grant the user did not actually make.
   */
  sessionAllowlist?: ReadonlySet<string>
}

function parseCommand(argsJson: string | undefined): string | null {
  if (!argsJson) return null
  try {
    const args = JSON.parse(argsJson) as { command?: unknown }
    return typeof args.command === 'string' ? args.command : null
  } catch {
    return null
  }
}

/**
 * Decide how a tool call should be handled. Destructive commands are never
 * auto-approved in any mode — autonomy governs convenience, not safety.
 */
export function decideToolCall(input: PolicyInput): ToolDecision {
  const { tool, argsJson, mode, sessionAllowlist } = input

  if (isAutoApprovedTool(tool)) return 'auto'

  if (tool === 'exec_command' || tool === 'run_in_terminal') {
    const command = parseCommand(argsJson)
    // Unparseable arguments are not evidence of safety.
    if (command === null) return 'ask'
    if (isDangerous(command)) return mode === 'conservative' ? 'deny' : 'ask'
    if (mode === 'autonomous') return 'auto'
    if (isReadOnlyCommand(command)) return mode === 'conservative' ? 'ask' : 'auto'
    if (sessionAllowlist?.has(tool)) return 'auto'
    return 'ask'
  }

  if (mode === 'autonomous') return 'auto'
  if (sessionAllowlist?.has(tool)) return 'auto'
  if (mode === 'conservative') return 'ask'

  // Balanced: app-state changes (tabs, saved configs, folders, settings) are
  // cheap to undo and were the most annoying thing to click through, so they
  // run; anything that writes to the remote host still asks.
  return LOW_RISK_ACTION_TOOLS.has(tool) ? 'auto' : 'ask'
}

/**
 * Action tools whose effects are local, visible, and trivially reversible by
 * the user through the normal UI.
 */
const LOW_RISK_ACTION_TOOLS = new Set([
  'open_ssh',
  'create_ssh_config',
  'update_ssh_config',
  'create_folder',
  'move_connection_to_folder',
  'update_app_settings'
])

/** Whether a tool call must wait for explicit approval under this policy. */
export function requiresApproval(input: PolicyInput): boolean {
  return decideToolCall(input) !== 'auto'
}
