/** Extract runnable shell commands from fenced ```bash / ```sh code blocks. */
export function extractCommands(markdown: string): string[] {
  const commands: string[] = []
  const fence = /```(?:bash|sh|shell|zsh)?\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fence.exec(markdown)) !== null) {
    const body = match[1].trim()
    if (body) commands.push(body)
  }
  return commands
}

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f|\brm\s+(-[a-z]*\s+)*-[a-z]*f[a-z]*r/i,
  /\brm\s+-rf?\b/i,
  /\bmkfs\.?\w*/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\b(init\s+0|init\s+6)\b/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bchmod\s+-R\s+777\s+\//i,
  /\b(userdel|deluser)\b/i,
  /\biptables\s+-F\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\btruncate\s+-s\s*0/i
]

export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(command))
}
