import { create } from 'zustand'
import type { BuiltinSkill, InstalledSkill } from '../../shared/types'

interface SkillsState {
  skills: InstalledSkill[]
  /** Skills shipped with the app, each flagged with whether it is installed. */
  builtins: BuiltinSkill[]
  loaded: boolean
  installing: boolean
  /** Id of the bundled skill currently being installed, for a per-row spinner. */
  installingBuiltin: string | null

  load: () => Promise<void>
  /** Open the folder picker and install; returns the outcome for UI feedback. */
  install: () => Promise<{ error?: string; cancelled?: boolean; skill?: InstalledSkill }>
  installBuiltin: (id: string) => Promise<{ error?: string; skill?: InstalledSkill }>
  remove: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
}

export const useSkillsStore = create<SkillsState>((set) => ({
  skills: [],
  builtins: [],
  loaded: false,
  installing: false,
  installingBuiltin: null,

  load: async () => {
    // Both lists in one pass: the bundled list carries an "installed" flag
    // derived from the installed one, so fetching them apart could render a
    // bundled skill as available when it is already there.
    const [skills, builtins] = await Promise.all([
      window.api.skills.list(),
      window.api.skills.listBuiltin()
    ])
    set({ skills, builtins, loaded: true })
  },

  installBuiltin: async (id) => {
    set({ installingBuiltin: id })
    try {
      const res = await window.api.skills.installBuiltin(id)
      if (res.skills) {
        set({
          skills: res.skills,
          builtins: await window.api.skills.listBuiltin()
        })
      }
      return { error: res.error, skill: res.skill }
    } finally {
      set({ installingBuiltin: null })
    }
  },

  install: async () => {
    set({ installing: true })
    try {
      const res = await window.api.skills.install()
      if (res.skills) set({ skills: res.skills })
      return { error: res.error, cancelled: res.cancelled, skill: res.skill }
    } finally {
      set({ installing: false })
    }
  },

  remove: async (id) => {
    const skills = await window.api.skills.remove(id)
    // Removing a bundled skill puts it back on offer, so the flags are stale
    // until re-read — otherwise the row the user just deleted stays hidden and
    // reinstalling it needs a restart.
    set({ skills, builtins: await window.api.skills.listBuiltin() })
  },

  setEnabled: async (id, enabled) => {
    const skills = await window.api.skills.setEnabled(id, enabled)
    set({ skills })
  }
}))
