/**
 * Print the assembled Copilot system prompt, so the copy embedded in
 * `docs/copilot-prompt-and-agent-loop.md` can be regenerated rather than
 * hand-edited (and quietly drift from what the app actually sends).
 *
 *   npx tsx scripts/dumpPrompt.ts [full|core|none]
 */
import { buildCopilotSystemPrompt } from '../src/shared/prompts/copilot'
import { toolNamesFor } from '../src/shared/aiTools'

const variants = {
  full: () => toolNamesFor('full'),
  core: () => toolNamesFor('core'),
  none: () => [] as string[]
}

const which = (process.argv[2] ?? 'full') as keyof typeof variants
if (!variants[which]) {
  console.error(`Unknown variant "${which}". Use one of: ${Object.keys(variants).join(', ')}`)
  process.exit(1)
}

const prompt = buildCopilotSystemPrompt({ toolNames: variants[which]() })
process.stdout.write(prompt)
console.error(
  `\n---\n${which}: ${prompt.length} chars | ` +
    Object.entries(variants)
      .map(([k, f]) => `${k}=${buildCopilotSystemPrompt({ toolNames: f() }).length}`)
      .join(' ')
)
