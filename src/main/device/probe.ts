import { Socket } from 'net'
import type { DeviceProbeResult } from '../../shared/types'

/**
 * Test whether a saved SSH device is reachable, with a bare TCP connect.
 *
 * A completed handshake is the whole claim: the board is powered, on the
 * network, and something is listening on that port. Deliberately not a login —
 * the device list refreshes on a timer, and an authentication attempt per
 * device per refresh would spend the user's credentials continuously and risk
 * tripping fail2ban or an account lockout on their own hardware.
 *
 * Uses node's `net` rather than an ICMP ping because ping needs a raw socket
 * (root on Linux) and answers a different question anyway: a Pi that responds
 * to ping but has sshd stopped is not a device this app can open.
 */
const PROBE_TIMEOUT_MS = 1500

export function probeDevice(
  host: string,
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<DeviceProbeResult> {
  const target = host?.trim()
  if (!target) return Promise.resolve({ reachable: false, error: 'No host.' })
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve({ reachable: false, error: `Invalid port: ${String(port)}` })
  }

  return new Promise<DeviceProbeResult>((resolve) => {
    const socket = new Socket()
    const startedAt = Date.now()
    let settled = false

    const finish = (result: DeviceProbeResult): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ reachable: true, latencyMs: Date.now() - startedAt }))
    socket.once('timeout', () => finish({ reachable: false, error: 'Timed out.' }))
    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish({ reachable: false, error: describeProbeError(err) })
    )

    try {
      socket.connect(port, target)
    } catch (e) {
      finish({ reachable: false, error: e instanceof Error ? e.message : String(e) })
    }
  })
}

/**
 * Probe a batch of devices with a bounded fan-out.
 *
 * The cap is what makes an unattended refresh safe. Opening a socket per saved
 * device at once is fine for five devices and a burst of dozens of simultaneous
 * SYNs for a large bookmark tree, which some home routers drop wholesale — so
 * the whole list would come back "offline" because the probe itself was the
 * problem.
 */
const MAX_CONCURRENT_PROBES = 8

export async function probeDevices(
  targets: { id: string; host: string; port: number }[]
): Promise<Record<string, DeviceProbeResult>> {
  const results: Record<string, DeviceProbeResult> = {}
  const queue = [...targets]

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift()
      if (!next) return
      results[next.id] = await probeDevice(next.host, next.port)
    }
  }

  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_PROBES, queue.length) },
    () => worker()
  )
  await Promise.all(workers)
  return results
}

function describeProbeError(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case 'ECONNREFUSED':
      return 'Connection refused (host is up, nothing listening on that port).'
    case 'EHOSTUNREACH':
      return 'Host unreachable.'
    case 'ENETUNREACH':
      return 'Network unreachable.'
    case 'ENOTFOUND':
      return 'Host name could not be resolved.'
    default:
      return err.message
  }
}
