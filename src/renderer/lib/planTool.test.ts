import { beforeEach, describe, expect, it } from 'vitest'

// The store reads persisted UI prefs at module load; this suite only needs the
// plan it holds, so a minimal in-memory store is enough to let it import.
const backing = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: () => null,
  length: 0
} as Storage

// The store debounces a write to disk after every mutation; in this suite the
// timer would fire mid-run against an Electron bridge that does not exist.
;(globalThis as unknown as { window: unknown }).window = {
  api: { config: { setCopilotChats: async () => undefined } }
}

const { useAIStore } = await import('../store/aiStore')
const { buildPlanContextMessage, planGroupSizes, updatePlan } = await import('./planTool')

const CHAT = 'chat-1'

/** A step in the shape the model sends, not the shape we store. */
function step(
  title: string,
  status: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { title, status, ...extra }
}

function currentPlan() {
  return useAIStore.getState().chatTabs.find((t) => t.id === CHAT)?.plan ?? []
}

beforeEach(() => {
  useAIStore.setState({
    chatTabs: [
      { id: CHAT, title: 'Chat', messages: [], draft: '', updatedAt: Date.now() }
    ],
    activeChatTabId: CHAT
  })
})

describe('updatePlan grouping', () => {
  it('accepts several in_progress steps that share one group', () => {
    // The shape this feature exists for: the same check on three machines, none
    // of which has any reason to wait for the others.
    const res = updatePlan(CHAT, {
      items: [
        step('check web-1', 'in_progress', { group: 1 }),
        step('check web-2', 'in_progress', { group: 1 }),
        step('check web-3', 'in_progress', { group: 1 }),
        step('summarize', 'pending', { group: 2 })
      ]
    })

    expect(res.ok).toBe(true)
    expect(currentPlan().filter((i) => i.status === 'in_progress')).toHaveLength(3)
  })

  it('still refuses several in_progress steps that are not one group', () => {
    // Dropping the check entirely is how a plan stops being a record of what
    // remains: "everything is in progress" tells the next turn nothing.
    const spread = updatePlan(CHAT, {
      items: [
        step('restart nginx', 'in_progress', { group: 1 }),
        step('migrate the db', 'in_progress', { group: 2 })
      ]
    })
    expect(spread.ok).toBe(false)
    expect(spread.error).toContain('not one parallel group')

    const ungrouped = updatePlan(CHAT, {
      items: [step('a', 'in_progress'), step('b', 'in_progress')]
    })
    expect(ungrouped.ok).toBe(false)
    expect(ungrouped.error).toContain('not one parallel group')
  })

  it('keeps the single-in_progress rule for a plan with no groups', () => {
    const res = updatePlan(CHAT, {
      items: [step('one', 'in_progress'), step('two', 'pending')]
    })
    expect(res.ok).toBe(true)
  })

  it('rejects a group that is not a positive integer', () => {
    // Silently dropping it would turn "these run together" into steps the
    // harness then refuses to run together, with no way to see why.
    for (const bad of [0, -1, 1.5, 'one']) {
      const res = updatePlan(CHAT, { items: [step('x', 'pending', { group: bad })] })
      expect(res.ok, String(bad)).toBe(false)
      expect(res.error, String(bad)).toContain('positive integer')
    }
  })

  it('labels a shared group but not a group of one', () => {
    const res = updatePlan(CHAT, {
      items: [
        step('alone', 'completed', { group: 1 }),
        step('together a', 'in_progress', { group: 2 }),
        step('together b', 'in_progress', { group: 2 })
      ]
    })
    expect(res.result).toContain('together a  (parallel group 2)')
    expect(res.result).not.toContain('alone  (parallel group 1)')
  })
})

describe('buildPlanContextMessage', () => {
  it('explains parallel groups only when the plan has one', () => {
    updatePlan(CHAT, {
      items: [
        step('probe a', 'in_progress', { group: 1 }),
        step('probe b', 'in_progress', { group: 1 })
      ]
    })
    expect(buildPlanContextMessage(CHAT)).toContain('same parallel group')

    // A linear plan must not pay window for a feature it is not using, nor be
    // invited to invent one.
    updatePlan(CHAT, { items: [step('just this', 'in_progress')] })
    expect(buildPlanContextMessage(CHAT)).not.toContain('same parallel group')
  })

  it('still re-states each step and its verify assertion', () => {
    updatePlan(CHAT, {
      items: [
        step('restart nginx', 'completed', {
          verify: { command: 'systemctl is-active nginx', expect_output: '^active' }
        })
      ]
    })
    const msg = buildPlanContextMessage(CHAT) ?? ''
    expect(msg).toContain('systemctl is-active nginx')
    expect(msg).toContain('^active')
  })
})

describe('planGroupSizes', () => {
  it('counts only explicit groups, so an ungrouped step is never "parallel"', () => {
    const sizes = planGroupSizes([
      { id: '1', title: 'a', status: 'pending' },
      { id: '2', title: 'b', status: 'pending', group: 3 },
      { id: '3', title: 'c', status: 'pending', group: 3 }
    ])
    expect(sizes.get(3)).toBe(2)
    expect(sizes.size).toBe(1)
  })
})
