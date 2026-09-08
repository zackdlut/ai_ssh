import { app } from 'electron'
import { cp, mkdir, readdir, readFile, rm } from 'fs/promises'
import { basename, join } from 'path'
import { getSkills, setSkills } from '../config/store'
import type { BuiltinSkill, InstalledSkill } from '../../shared/types'

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
/**
 * Where the skills shipped with the app live.
 *
 * `extraResources` puts them beside the packaged app, while in development they
 * are still in the repo — and `app.getAppPath()` points at `out/` in a dev run,
 * so the repo root is one level up from it.
 */
function builtinSkillsRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills')
}

/**
 * The bundled skills, each flagged with whether it is already installed.
 *
 * A missing or unreadable directory yields an empty list rather than an error:
 * bundled skills are an offer, and a build that shipped without them should
 * leave the rest of the skills UI working.
 */
export async function listBuiltinSkills(): Promise<BuiltinSkill[]> {
  const root = builtinSkillsRoot()
  let entries: string[]
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }

  const installed = new Set(getSkills().map((s) => s.builtinId).filter(Boolean))
  const out: BuiltinSkill[] = []
  for (const id of entries) {
    let text: string
    try {
      text = await readFile(join(root, id, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const parsed = parseSkillMd(text)
    out.push({
      id,
      name: parsed.name || id,
      description: parsed.description || '',
      installed: installed.has(id)
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Install one bundled skill by its folder name.
 *
 * It goes through the same copy-into-userData path as a user's own folder, so a
 * bundled skill can be edited or removed afterwards like any other — the app's
 * copy is a starting point, not a managed file.
 */
export async function installBuiltinSkill(id: string): Promise<InstalledSkill> {
  // The id indexes a directory, so a traversal in it would read outside the
  // bundle. Only a plain folder name is ever valid here.
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw new Error(`"${id}" is not a valid built-in skill id.`)
  }
  const existing = getSkills().find((s) => s.builtinId === id)
  if (existing) return existing
  const skill = await installSkill(join(builtinSkillsRoot(), id))
  const tagged: InstalledSkill = { ...skill, builtinId: id }
  setSkills(getSkills().map((s) => (s.id === skill.id ? tagged : s)))
  return tagged
}

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
