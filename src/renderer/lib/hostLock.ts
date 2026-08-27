/**
 * Per-host serialization for agent writes.
 *
 * Chat tabs run their loops in parallel (each has its own `busyByTab` entry), so
 * two loops can reach the same machine at the same moment. Reads may overlap
 * freely, but two writes must not: `edit_file` twice on one config, or a restart
 * racing a config rewrite, produces a host state neither loop asked for and an
 * `exec` channel whose observed cwd belongs to the other task.
 *
 * The lock is keyed by TERMINAL TAB rather than by chat: the shared resource is
 * the machine behind the tab, and two chats pinned to the same tab are exactly
 * the case that needs ordering. Two tabs onto the same physical host stay
 * independent, which matches how the exec channels are already isolated.
 *
 * FIFO by construction — each waiter chains onto the previous one — so a loop
 * cannot be starved by a busier neighbour.
 */
const chains = new Map<string, Promise<void>>()

/**
 * Run `fn` with exclusive access to `key`. A missing key means the call names no
 * host (nothing to serialize against), so it runs straight away.
 */
export async function withHostLock<T>(
  key: string | undefined | null,
  fn: () => Promise<T>
): Promise<T> {
  if (!key) return fn()

  const previous = chains.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  // Claim the tail before awaiting, so a second caller in the same tick chains
  // onto this one instead of also seeing the old tail.
  const mine = previous.then(() => held)
  chains.set(key, mine)

  await previous
  try {
    return await fn()
  } finally {
    release()
    // Clear the entry only while this call is still the tail: if someone has
    // chained on behind us, that queue is theirs to finish.
    if (chains.get(key) === mine) chains.delete(key)
  }
}

/** Whether anything currently holds or waits on this host's lock. */
export function isHostLocked(key: string): boolean {
  return chains.has(key)
}
