import { describe, expect, it } from 'vitest'
import { isHostLocked, withHostLock } from './hostLock'

/** A task that records its own start/end so overlap is visible in the log. */
function tracked(log: string[], name: string, hold: Promise<void>) {
  return async (): Promise<string> => {
    log.push(`${name}:start`)
    await hold
    log.push(`${name}:end`)
    return name
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('withHostLock', () => {
  it('serializes two calls on the same host', async () => {
    const log: string[] = []
    const first = deferred()
    const second = deferred()

    const a = withHostLock('tab-1', tracked(log, 'a', first.promise))
    const b = withHostLock('tab-1', tracked(log, 'b', second.promise))

    // b must not have started while a holds the lock, even though both were
    // launched in the same tick.
    await Promise.resolve()
    expect(log).toEqual(['a:start'])

    first.resolve()
    await a
    second.resolve()
    await b

    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('lets different hosts run at the same time', async () => {
    const log: string[] = []
    const gate = deferred()

    const a = withHostLock('tab-1', tracked(log, 'a', gate.promise))
    const b = withHostLock('tab-2', tracked(log, 'b', gate.promise))

    await Promise.resolve()
    expect(log).toEqual(['a:start', 'b:start'])

    gate.resolve()
    await Promise.all([a, b])
  })

  it('runs immediately when no host is named', async () => {
    const log: string[] = []
    const gate = deferred()
    // A call with no tab_id names no shared resource, so there is nothing to
    // queue behind — including behind a locked host.
    const held = withHostLock('tab-1', tracked(log, 'held', gate.promise))
    const free = withHostLock(undefined, tracked(log, 'free', Promise.resolve()))

    await expect(free).resolves.toBe('free')
    gate.resolve()
    await held
  })

  it('grants the lock in call order', async () => {
    const order: string[] = []
    const gate = deferred()
    const runs = ['a', 'b', 'c', 'd'].map((name) =>
      withHostLock('tab-1', async () => {
        await gate.promise
        order.push(name)
      })
    )
    gate.resolve()
    await Promise.all(runs)
    expect(order).toEqual(['a', 'b', 'c', 'd'])
  })

  it('releases the lock when the task throws, so the queue keeps moving', async () => {
    await expect(
      withHostLock('tab-err', () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom')

    // A leaked lock here would freeze every later write to this host.
    expect(isHostLocked('tab-err')).toBe(false)
    await expect(withHostLock('tab-err', () => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('forgets the host once the last waiter finishes', async () => {
    const gate = deferred()
    const a = withHostLock('tab-2', () => gate.promise)
    const b = withHostLock('tab-2', () => gate.promise)
    expect(isHostLocked('tab-2')).toBe(true)

    gate.resolve()
    await Promise.all([a, b])
    expect(isHostLocked('tab-2')).toBe(false)
  })
})
