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

export { isDangerous } from '../../shared/dangerousCommands'
