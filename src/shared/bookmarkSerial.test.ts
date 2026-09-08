import { describe, expect, it } from 'vitest'
import {
  buildConnectionBundle,
  mergeBundle,
  parseConnectionBundle
} from './bookmarkBundle'
import { buildSessionsXml } from './superputty'
import type { ConnectionConfig } from './types'

/**
 * A serial device shares the bookmark tree with SSH hosts, which means it also
 * shares the import, export, and dedup code that was written when every entry
 * had a host. These cover the two places that assumption breaks.
 */

const sshEntry: ConnectionConfig = {
  id: 'pi',
  name: 'pi-lab',
  host: '192.168.1.20',
  port: 22,
  username: 'pi',
  parentId: null
}

const serialEntry: ConnectionConfig = {
  id: 'esp',
  name: 'esp32-devkit',
  kind: 'serial',
  host: '',
  port: 0,
  username: '',
  serial: { path: '/dev/ttyUSB0', baudRate: 115200, dtr: false, rts: false, newline: 'lf' },
  deviceKind: 'esp32',
  parentId: null
}

const newFolderId = (): string => 'folder-test'

describe('JSON bundle round-trip', () => {
  it('keeps a serial device, which has no host to be validated against', () => {
    const { json } = buildConnectionBundle({ folders: [], connections: [serialEntry] })
    const parsed = parseConnectionBundle(json)
    expect(parsed.dropped).toBe(0)
    expect(parsed.connections).toHaveLength(1)
    expect(parsed.connections[0].kind).toBe('serial')
    expect(parsed.connections[0].serial?.path).toBe('/dev/ttyUSB0')
  })

  it('preserves the port settings that cannot be re-derived', () => {
    const { json } = buildConnectionBundle({ folders: [], connections: [serialEntry] })
    const back = parseConnectionBundle(json).connections[0]
    expect(back.serial).toMatchObject({
      baudRate: 115200,
      dtr: false,
      rts: false,
      newline: 'lf'
    })
    expect(back.deviceKind).toBe('esp32')
  })

  it('still drops an SSH entry with no host', () => {
    const parsed = parseConnectionBundle(
      JSON.stringify({ connections: [{ id: 'x', name: 'nowhere', username: 'root' }] })
    )
    expect(parsed.dropped).toBe(1)
    expect(parsed.connections).toHaveLength(0)
  })

  it('drops a serial entry with no port path, since nothing can open it', () => {
    const parsed = parseConnectionBundle(
      JSON.stringify({ connections: [{ id: 'x', name: 'board', kind: 'serial', serial: {} }] })
    )
    expect(parsed.dropped).toBe(1)
  })

  it('accepts a serial entry carrying only a path, filling the rest at connect time', () => {
    const parsed = parseConnectionBundle(
      JSON.stringify({
        connections: [{ id: 'x', name: 'board', kind: 'serial', serial: { path: 'COM7' } }]
      })
    )
    expect(parsed.dropped).toBe(0)
    expect(parsed.connections[0].serial).toEqual({ path: 'COM7' })
  })
})

describe('merge dedup', () => {
  const importTwoBoards = (): ReturnType<typeof mergeBundle> => {
    const second: ConnectionConfig = {
      ...serialEntry,
      id: 'esp-2',
      name: 'esp32-b',
      serial: { path: '/dev/ttyUSB1', baudRate: 115200 }
    }
    const bundle = parseConnectionBundle(
      buildConnectionBundle({ folders: [], connections: [serialEntry, second] }).json
    )
    return mergeBundle(bundle, { folders: [], connections: [] }, newFolderId)
  }

  it('imports two boards as two devices rather than collapsing them', () => {
    // Both have an empty host, port, and username, so a host-based duplicate
    // check would treat the second as a copy of the first.
    const result = importTwoBoards()
    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.connections.map((c) => c.serial?.path)).toEqual([
      '/dev/ttyUSB0',
      '/dev/ttyUSB1'
    ])
  })

  it('does skip a second entry for the same port path', () => {
    const bundle = parseConnectionBundle(
      buildConnectionBundle({
        folders: [],
        connections: [serialEntry, { ...serialEntry, id: 'dup', name: 'same-port' }]
      }).json
    )
    const result = mergeBundle(bundle, { folders: [], connections: [] }, newFolderId)
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(1)
  })

  it('never treats a serial entry as a duplicate of an SSH one', () => {
    const bundle = parseConnectionBundle(
      buildConnectionBundle({ folders: [], connections: [serialEntry] }).json
    )
    const result = mergeBundle(
      bundle,
      { folders: [], connections: [{ ...sshEntry, host: '', port: 0, username: '' }] },
      newFolderId
    )
    expect(result.imported).toBe(1)
  })
})

describe('SuperPuTTY XML export', () => {
  it('writes the SSH host and reports the serial device as skipped', () => {
    const { xml, exported, skipped } = buildSessionsXml({
      folders: [],
      connections: [sshEntry, serialEntry]
    })
    expect(exported).toBe(1)
    expect(skipped).toBe(1)
    expect(xml).toContain('192.168.1.20')
    // The schema is SSH-only, so an exported serial row would reconnect to nothing.
    expect(xml).not.toContain('ttyUSB0')
    expect(xml).not.toContain('esp32-devkit')
  })

  it('skips nothing when every entry is an SSH host', () => {
    expect(buildSessionsXml({ folders: [], connections: [sshEntry] }).skipped).toBe(0)
  })
})
