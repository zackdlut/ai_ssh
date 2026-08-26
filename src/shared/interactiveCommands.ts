/**
 * Commands that take over the PTY as a full-screen / pager UI. Sentinel-wrapped
 * capture cannot coexist with them: the helper never prints, and the user's
 * keyboard is locked for the duration of the hard timeout.
 */
const INTERACTIVE_TUI_RE =
  /(?:^|[;&|\n]\s*)(?:sudo\s+)?(?:vim|vi|nvim|nano|emacs(?:-nw)?|less|more|most|top|htop|btop|iotop|atop|nmtui|mc|tmux|screen|man|info|watch)\b/i

/** `top -b` / `top -bn1` print without taking over the TTY. */
const TOP_STAGE_RE = /(?:^|[;&|\n]\s*)(?:sudo\s+)?top(\s+[^\n;&|]*)/i
const TOP_BATCH_FLAG_RE = /(?:^|\s)-[a-zA-Z]*b/

/** True when `command` would open an interactive TUI rather than print and exit. */
export function isInteractiveTuiCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (!INTERACTIVE_TUI_RE.test(trimmed)) return false
  const topStage = TOP_STAGE_RE.exec(trimmed)
  if (topStage && TOP_BATCH_FLAG_RE.test(topStage[1] ?? '')) return false
  return true
}
