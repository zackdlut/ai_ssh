import { describe, expect, it } from 'vitest'
import {
  appendCheckpoint,
  checkpointFromBackupNote,
  isRegisteredBackupNote,
  matchCheckpoint,
  parseBackupPath,
  shortCheckpointPath,
  MAX_CHECKPOINTS
} from './fileCheckpoints'
import type { FileCheckpoint } from '../../shared/types'

function cp(partial: Partial<FileCheckpoint> & Pick<FileCheckpoint, 'id' | 'path'>): FileCheckpoint {
  return {
    terminalTabId: 't1',
    backupPath: `${partial.path}.bak.1`,
    at: 1,
    ...partial
  }
}

describe('backup notes', () => {
  it('registers only a successful backup path, before the target write', () => {
    expect(isRegisteredBackupNote('backup: /etc/nginx.conf.bak.9')).toBe(true)
    expect(checkpointFromBackupNote('/etc/nginx.conf', 'backup: /etc/nginx.conf.bak.9', 't1')).toEqual(
      {
        terminalTabId: 't1',
        path: '/etc/nginx.conf',
        backupPath: '/etc/nginx.conf.bak.9'
      }
    )
    expect(isRegisteredBackupNote('backup skipped (file exceeds 1)')).toBe(false)
    expect(isRegisteredBackupNote('backup failed: disk full')).toBe(false)
    expect(checkpointFromBackupNote('/x', 'backup failed: disk full', 't1')).toBeNull()
  })

  it('parses the backup path from a tool result', () => {
    expect(parseBackupPath('edited: /a\nbackup: /a.bak.2\nnote: verify')).toBe('/a.bak.2')
    expect(parseBackupPath('backup skipped (file exceeds 1)')).toBeUndefined()
  })
})

describe('appendCheckpoint', () => {
  it('keeps the newest tail', () => {
    const many = Array.from({ length: MAX_CHECKPOINTS + 5 }, (_, i) =>
      cp({ id: String(i), path: `/f${i}` })
    )
    const next = appendCheckpoint(many.slice(0, MAX_CHECKPOINTS + 4), many[MAX_CHECKPOINTS + 4])
    expect(next).toHaveLength(MAX_CHECKPOINTS)
    expect(next[0].id).toBe('5')
    expect(next.at(-1)?.id).toBe(String(MAX_CHECKPOINTS + 4))
  })
})

describe('matchCheckpoint', () => {
  it('prefers the latest backup for a path', () => {
    const list = [
      cp({ id: '1', path: '/etc/nginx.conf', backupPath: '/etc/nginx.conf.bak.1' }),
      cp({ id: '2', path: '/etc/nginx.conf', backupPath: '/etc/nginx.conf.bak.2' })
    ]
    expect(matchCheckpoint(list, { path: '/etc/nginx.conf' })?.id).toBe('2')
    expect(matchCheckpoint(list, { backupPath: '/etc/nginx.conf.bak.1' })?.id).toBe('1')
  })
})

describe('shortCheckpointPath', () => {
  it('keeps a short tail', () => {
    expect(shortCheckpointPath('/etc/nginx/nginx.conf')).toBe('…/nginx/nginx.conf')
    expect(shortCheckpointPath('/etc/hosts')).toBe('/etc/hosts')
  })
})
