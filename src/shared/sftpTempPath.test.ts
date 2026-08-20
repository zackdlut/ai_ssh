import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { remoteTempPath } from './sftpTempPath'

const BASE = join('tmp', 'sftp-open')

describe('remoteTempPath', () => {
  it('mirrors the remote directory layout and keeps the file name', () => {
    expect(remoteTempPath(BASE, 'sess-1', '/etc/nginx/nginx.conf')).toBe(
      join(BASE, 'sess-1', 'etc', 'nginx', 'nginx.conf')
    )
  })

  it('keeps same-named files in different remote directories apart', () => {
    const a = remoteTempPath(BASE, 'sess-1', '/srv/a/config.yml')
    const b = remoteTempPath(BASE, 'sess-1', '/srv/b/config.yml')
    expect(a).not.toBe(b)
  })

  it('keeps the same file apart across sessions', () => {
    const a = remoteTempPath(BASE, 'sess-1', '/etc/hosts')
    const b = remoteTempPath(BASE, 'sess-2', '/etc/hosts')
    expect(a).not.toBe(b)
  })

  it('replaces characters that Windows filesystems reject', () => {
    expect(remoteTempPath(BASE, 'sess-1', '/logs/a:b?c*d.txt')).toBe(
      join(BASE, 'sess-1', 'logs', 'a_b_c_d.txt')
    )
  })

  it('keeps leading dots so dotfiles stay recognizable', () => {
    expect(remoteTempPath(BASE, 'sess-1', '/home/me/.bashrc')).toBe(
      join(BASE, 'sess-1', 'home', 'me', '.bashrc')
    )
  })

  it('drops traversal segments instead of resolving them', () => {
    expect(remoteTempPath(BASE, 'sess-1', '/srv/../../etc/passwd')).toBe(
      join(BASE, 'sess-1', 'srv', 'etc', 'passwd')
    )
  })

  it('accepts relative remote paths', () => {
    expect(remoteTempPath(BASE, 'sess-1', './notes.md')).toBe(
      join(BASE, 'sess-1', 'notes.md')
    )
  })

  it('rejects a path with no usable segment', () => {
    expect(() => remoteTempPath(BASE, 'sess-1', '/')).toThrow()
  })
})
