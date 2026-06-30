import { app } from 'electron'
import { cp, mkdir, readFile, rm } from 'fs/promises'
import { basename, join } from 'path'
import { getSkills, setSkills } from '../config/store'
import type { InstalledSkill } from '../../shared/types'

/** Hard cap on the SKILL.md body returned to the model, to protect the context budget. */
const MAX_SKILL_BODY = 12000

/** Root directory where installed skills are copied (survives source moves). */
function skillsRoot(): string {
  return join(app.getPath('userData'), 'skills')
}

function genId(): string {
  return `skill-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

interface ParsedSkill {
  name?: string
  description?: string
}

/**
 * Extract `name`/`description` from a SKILL.md's leading YAML-ish frontmatter
 * (the block delimited by `---` lines). Falls back to the first `# heading`
 * for the name. Intentionally a tiny line parser — no YAML dependency.
 */
export function parseSkillMd(text: string): ParsedSkill {
  const result: ParsedSkill = {}
  const fm = /^\s*---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (fm) {
    for (const raw of fm[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(raw.trim())
      if (!kv) continue
      const key = kv[1].toLowerCase()
      const val = kv[2].trim().replace(/^["']|["']$/g, '')
      if (key === 'name' && val) result.name = val
      else if (key === 'description' && val) result.description = val
    }
  }
  if (!result.name) {
    const heading = /^#\s+(.+)$/m.exec(text)
    if (heading) result.name = heading[1].trim()
  }
  return result
}

export function listSkills(): InstalledSkill[] {
  return getSkills()
}

/**
 * Install a skill from a local folder: validate it has a top-level SKILL.md,
 * parse its metadata, copy the whole folder into userData/skills/<id>, and
 * persist the metadata record.
 */
export async function installSkill(sourceDir: string): Promise<InstalledSkill> {
  const srcMd = join(sourceDir, 'SKILL.md')
  let text: string
  try {
    text = await readFile(srcMd, 'utf8')
  } catch {
    throw new Error('The selected folder has no SKILL.md at its top level.')
  }

  const parsed = parseSkillMd(text)
  const name = parsed.name || basename(sourceDir)
  const description = parsed.description || ''

  const id = genId()
  const dir = join(skillsRoot(), id)
  await mkdir(skillsRoot(), { recursive: true })
  await cp(sourceDir, dir, { recursive: true })

  const skill: InstalledSkill = {
    id,
    name,
    description,
    enabled: true,
    dir,
    sourcePath: sourceDir,
    installedAt: Date.now()
  }
  setSkills([...getSkills(), skill])
  return skill
}

export async function removeSkill(id: string): Promise<InstalledSkill[]> {
  const list = getSkills()
  const target = list.find((s) => s.id === id)
  if (target) {
    await rm(target.dir, { recursive: true, force: true }).catch(() => {
      /* metadata removal proceeds even if the dir is already gone */
    })
  }
  return setSkills(list.filter((s) => s.id !== id))
}

export function setSkillEnabled(id: string, enabled: boolean): InstalledSkill[] {
  return setSkills(getSkills().map((s) => (s.id === id ? { ...s, enabled } : s)))
}

/** Read a skill's full SKILL.md body, resolved by id or (case-insensitive) name. */
export async function readSkillBody(idOrName: string): Promise<string> {
  const key = idOrName.trim()
  const list = getSkills()
  const skill =
    list.find((s) => s.id === key) ??
    list.find((s) => s.name.toLowerCase() === key.toLowerCase())
  if (!skill) throw new Error(`No installed skill matching "${idOrName}".`)
  const text = await readFile(join(skill.dir, 'SKILL.md'), 'utf8')
  return text.length > MAX_SKILL_BODY ? `${text.slice(0, MAX_SKILL_BODY)}\n…(truncated)` : text
}
