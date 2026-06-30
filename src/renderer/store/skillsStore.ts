import { create } from 'zustand'
import type { InstalledSkill } from '../../shared/types'

interface SkillsState {
  skills: InstalledSkill[]
  loaded: boolean
  installing: boolean

  load: () => Promise<void>
  /** Open the folder picker and install; returns the outcome for UI feedback. */
  install: () => Promise<{ error?: string; cancelled?: boolean; skill?: InstalledSkill }>
  remove: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
}

export const useSkillsStore = create<SkillsState>((set) => ({
  skills: [],
  loaded: false,
  installing: false,

  load: async () => {
    const skills = await window.api.skills.list()
    set({ skills, loaded: true })
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
    set({ skills })
  },

  setEnabled: async (id, enabled) => {
    const skills = await window.api.skills.setEnabled(id, enabled)
    set({ skills })
  }
}))
