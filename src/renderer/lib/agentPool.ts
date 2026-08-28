/**
 * Concurrency gate for delegated sub-agents.
 *
 * `delegate_to_host` runs without approval, so nothing between the model and
 * the network asks whether eight simultaneous investigations are a good idea.
 * Each one is its own bounded LLM loop plus its own stream of SSH commands, and
 * they all point at the same provider — with the sub-agents sharing the main
 * model, a wide fan-out is the fastest way to turn a useful survey into a wall
 * of 429s. The step budget in `subAgent.ts` bounds how long ONE sub-agent runs;
 * this bounds how many run at once.
 *
 * Two limits, acquired in this order:
 *
 * - ONE per host. The product rule is one agent per machine: a second
 *   investigation of the same box would compete for the same shell, and on a
 *   WSL tab it would simply fail (the PTY capture allows one at a time). Same
 *   chained-promise FIFO as `hostLock`, so delegations queue in the order the
 *   model emitted them.
 * - N app-wide. A ceiling on concurrent LLM streams and concurrent SSH load.
 *
 * The order matters. Taking the global slot first lets several delegations to
 * ONE host fill the pool and then serialize behind each other, starving the
 * other hosts that the fan-out was for; taking the host slot first means a
 * queued delegation holds nothing anyone else wants.
 *
 * These keys are deliberately NOT `hostLock`'s. A delegation spans many turns,
 * and its own commands take the write lock individually — holding that lock out
 * here would block every other chat's writes to the machine for the whole
 * investigation, which is exactly why `HOST_MUTATING_TOOLS` leaves this tool
 * out.
 */

/**
 * Concurrent delegated sub-agents, app-wide. Four is chosen for the provider,
 * not the hosts: SSH would take far more, but every sub-agent is also an
 * in-flight completion stream on the same account as the main loop.
 */
export const MAX_PARALLEL_SUB_AGENTS = 4

/** Tail of the queue per terminal tab, mirroring `hostLock`'s chain. */
const hostQueues = new Map<string, Promise<void>>()

let active = 0
const waiters: Array<() => void> = []

function acquireGlobal(): Promise<void> {
  if (active < MAX_PARALLEL_SUB_AGENTS) {
    active += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      active += 1
      resolve()
    })
  })
}

function releaseGlobal(): void {
  active -= 1
  waiters.shift()?.()
}

/**
 * Reserve this host's slot. Returns the promise to wait on plus its release,
 * with the reservation already installed — so two delegations emitted in the
 * same tick queue behind each other rather than both seeing an empty chain.
 */
function reserveHost(key: string): { ready: Promise<void>; release: () => void } {
  const previous = hostQueues.get(key) ?? Promise.resolve()
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const mine = previous.then(() => held)
  hostQueues.set(key, mine)
  return {
    ready: previous,
    release: () => {
      release()
      if (hostQueues.get(key) === mine) hostQueues.delete(key)
    }
  }
}

export interface SubAgentSlotOptions {
  /**
   * Checked once both slots are held. A delegation cancelled while queued must
   * not start: Stop has already told the user everything is stopping, and the
   * abort handle registered by the sub-agent itself cannot help before its loop
   * exists.
   */
  cancelled?: () => boolean
  /**
   * Called when the delegation has to wait, so the card can say so instead of
   * showing an investigation that has not started. Not called when a slot is
   * free immediately.
   */
  onQueued?: () => void
}

/** Thrown in place of running `fn` when Stop landed while queued. */
export class SubAgentCancelled extends Error {
  constructor() {
    super('Cancelled while waiting for a sub-agent slot.')
    this.name = 'SubAgentCancelled'
  }
}

/**
 * Run a delegated investigation under both limits. An empty `hostKey` skips the
 * per-host slot — callers validate the tab first, so this only happens for a
 * call that is about to fail anyway.
 */
export async function withSubAgentSlot<T>(
  hostKey: string,
  fn: () => Promise<T>,
  opts: SubAgentSlotOptions = {}
): Promise<T> {
  // Both questions are asked before reserving anything, while the answer is
  // still a plain synchronous fact rather than a race.
  const waitsForHost = !!hostKey && hostQueues.has(hostKey)
  const host = hostKey ? reserveHost(hostKey) : null
  if (waitsForHost || active >= MAX_PARALLEL_SUB_AGENTS) opts.onQueued?.()
  if (host) await host.ready
  await acquireGlobal()
  try {
    if (opts.cancelled?.()) throw new SubAgentCancelled()
    return await fn()
  } finally {
    releaseGlobal()
    host?.release()
  }
}

/** Live pool occupancy, for tests and for the "queued" line in the UI. */
export function subAgentPoolStats(): { active: number; waiting: number; hosts: number } {
  return { active, waiting: waiters.length, hosts: hostQueues.size }
}

/** Test-only reset; the pool is module state shared by every chat. */
export function resetSubAgentPool(): void {
  active = 0
  waiters.length = 0
  hostQueues.clear()
}
