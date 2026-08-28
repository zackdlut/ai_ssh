import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_PARALLEL_SUB_AGENTS,
  SubAgentCancelled,
  resetSubAgentPool,
  subAgentPoolStats,
  withSubAgentSlot
} from './agentPool'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** A task that records its own start/end so overlap is visible in the log. */
function tracked(log: string[], name: string, hold: Promise<void>) {
  return async (): Promise<string> => {
    log.push(`${name}:start`)
    await hold
    log.push(`${name}:end`)
    return name
  }
}

/** Let every already-resolved continuation run before asserting. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

beforeEach(() => {
  resetSubAgentPool()
})

describe('withSubAgentSlot', () => {
  it('runs delegations to DIFFERENT hosts at the same time', async () => {
    // The entire point of the tool: three hosts surveyed concurrently rather
    // than one after another.
    const log: string[] = []
    const gate = deferred()
    const runs = ['h1', 'h2', 'h3'].map((host) =>
      withSubAgentSlot(host, tracked(log, host, gate.promise))
    )

    await settle()
    expect(log).toEqual(['h1:start', 'h2:start', 'h3:start'])

    gate.resolve()
    await expect(Promise.all(runs)).resolves.toEqual(['h1', 'h2', 'h3'])
  })

  it('allows only one sub-agent per host, queueing the rest', async () => {
    const log: string[] = []
    const first = deferred()
    const second = deferred()

    const a = withSubAgentSlot('same-host', tracked(log, 'a', first.promise))
    const b = withSubAgentSlot('same-host', tracked(log, 'b', second.promise))

    await settle()
    expect(log).toEqual(['a:start'])

    first.resolve()
    await a
    second.resolve()
    await b
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('grants a host its slots in call order', async () => {
    const order: string[] = []
    const gate = deferred()
    const runs = ['a', 'b', 'c', 'd'].map((name) =>
      withSubAgentSlot('one-host', async () => {
        await gate.promise
        order.push(name)
      })
    )
    gate.resolve()
    await Promise.all(runs)
    expect(order).toEqual(['a', 'b', 'c', 'd'])
  })

  it('caps concurrency app-wide even across distinct hosts', async () => {
    // Sub-agents share the parent's model, so a wide fan-out is a pile of
    // simultaneous completion streams on one account.
    const log: string[] = []
    const gate = deferred()
    const hosts = Array.from({ length: MAX_PARALLEL_SUB_AGENTS + 2 }, (_, i) => `h${i}`)
    const runs = hosts.map((host) => withSubAgentSlot(host, tracked(log, host, gate.promise)))

    await settle()
    expect(log.filter((l) => l.endsWith(':start'))).toHaveLength(MAX_PARALLEL_SUB_AGENTS)
    expect(subAgentPoolStats().active).toBe(MAX_PARALLEL_SUB_AGENTS)

    gate.resolve()
    await Promise.all(runs)
    expect(log.filter((l) => l.endsWith(':start'))).toHaveLength(hosts.length)
  })

  it('releases both slots when the task throws', async () => {
    // A leaked slot is worse here than a failed delegation: it silently lowers
    // the ceiling for the rest of the session.
    await expect(
      withSubAgentSlot('boom-host', () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom')

    expect(subAgentPoolStats()).toEqual({ active: 0, waiting: 0, hosts: 0 })
    await expect(withSubAgentSlot('boom-host', () => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('refuses to start a delegation cancelled while it queued', async () => {
    // Stop has already told the user everything is stopping. The sub-agent's own
    // canceller cannot help before its loop exists, so the pool checks here.
    const log: string[] = []
    const gate = deferred()
    let cancelled = false

    const holder = withSubAgentSlot('busy-host', tracked(log, 'holder', gate.promise))
    const queued = withSubAgentSlot('busy-host', tracked(log, 'queued', Promise.resolve()), {
      cancelled: () => cancelled
    })

    await settle()
    cancelled = true
    gate.resolve()
    await holder

    await expect(queued).rejects.toBeInstanceOf(SubAgentCancelled)
    expect(log).not.toContain('queued:start')
    expect(subAgentPoolStats().active).toBe(0)
  })

  it('reports queueing only when the call actually has to wait', async () => {
    const gate = deferred()
    let firstQueued = false
    let secondQueued = false

    const a = withSubAgentSlot('h', () => gate.promise, {
      onQueued: () => {
        firstQueued = true
      }
    })
    const b = withSubAgentSlot('h', () => Promise.resolve(), {
      onQueued: () => {
        secondQueued = true
      }
    })

    await settle()
    expect(firstQueued).toBe(false)
    expect(secondQueued).toBe(true)

    gate.resolve()
    await Promise.all([a, b])
  })

  it('does not queue a call that names no host', async () => {
    // Only reached by a delegation that is about to fail validation anyway, so
    // it must not be able to block on a slot.
    const gate = deferred()
    const held = withSubAgentSlot('h', () => gate.promise)
    await expect(withSubAgentSlot('', () => Promise.resolve('free'))).resolves.toBe('free')
    gate.resolve()
    await held
  })
})
