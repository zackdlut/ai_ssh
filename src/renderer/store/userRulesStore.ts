import { create } from 'zustand'

interface UserRulesState {
  rules: string
  loaded: boolean

  load: () => Promise<void>
  setRules: (rules: string) => Promise<void>
}

export const useUserRulesStore = create<UserRulesState>((set) => ({
  rules: '',
  loaded: false,

  load: async () => {
    const rules = await window.api.config.getUserRules()
    set({ rules, loaded: true })
  },

  setRules: async (rules) => {
    const saved = await window.api.config.setUserRules(rules)
    set({ rules: saved })
  }
}))
