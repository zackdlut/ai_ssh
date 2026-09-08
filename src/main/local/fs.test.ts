import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { globLocal, grepLocal, readTextLocal, writeTextLocal } from './fs'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aissh-fs-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readTextLocal', () => {
  /**
   * `truncated` is the flag `edit_file` refuses on. Getting it wrong in the
   * permissive direction means the agent reads a prefix of a large file,
   * rewrites what it read, and silently deletes the rest.
   */
  it('reports truncation exactly at the boundary, not one byte early or late', async () => {
    const path = join(dir, 'a.txt')
    await writeFile(path, '0123456789')

    const exact = await readTextLocal(path, { maxBytes: 10 })
    expect(exact.text).toBe('0123456789')
    expect(exact.bytesRead).toBe(10)
    expect(exact.truncated).toBe(false)

    const short = await readTextLocal(path, { maxBytes: 9 })
    expect(short.text).toBe('012345678')
    expect(short.truncated).toBe(true)

    const over = await readTextLocal(path, { maxBytes: 99 })
    expect(over.truncated).toBe(false)
  })

  it('pages from startByte and reports the file size, not the window size', async () => {
    const path = join(dir, 'a.txt')
    await writeFile(path, '0123456789')

    const window = await readTextLocal(path, { startByte: 4, maxBytes: 3 })
    expect(window.text).toBe('456')
    expect(window.startByte).toBe(4)
    expect(window.bytesRead).toBe(3)
    // The size is the whole file; a caller paging through needs it to know
    // when to stop, and the window length would say "done" every time.
    expect(window.size).toBe(10)
    expect(window.truncated).toBe(true)
  })

  it('returns an empty, untruncated window when startByte is past the end', async () => {
    // Reading past the end is how a pager discovers it has finished, so this
    // has to be an ordinary empty result rather than an error.
    const path = join(dir, 'a.txt')
    await writeFile(path, 'abc')
    const past = await readTextLocal(path, { startByte: 99 })
    expect(past.text).toBe('')
    expect(past.bytesRead).toBe(0)
    expect(past.truncated).toBe(false)
    expect(past.size).toBe(3)
  })

  it('refuses a directory instead of returning gibberish', async () => {
    await expect(readTextLocal(dir)).rejects.toThrow(/directory/)
  })
})

describe('writeTextLocal', () => {
  it('keeps the mode of a file it overwrites', async () => {
    // Writing to something the user made executable, or deliberately narrowed,
    // must not reset it to whatever the process umask says.
    const path = join(dir, 'run.sh')
    await writeFile(path, 'old', { mode: 0o755 })
    await writeTextLocal(path, 'new')
    const after = await readTextLocal(path)
    expect(after.text).toBe('new')
    const { statLocal } = await import('./fs')
    expect((await statLocal(path)).mode & 0o777).toBe(0o755)
  })
})

describe('grepLocal', () => {
  beforeEach(async () => {
    await writeFile(join(dir, 'a.ts'), 'const x = 1\nconst target = 2\n')
    await writeFile(join(dir, 'b.md'), 'target in markdown\n')
    await mkdir(join(dir, 'node_modules'))
    await writeFile(join(dir, 'node_modules', 'c.ts'), 'target in a dependency\n')
  })

  it('emits path:line:text, the shape the SSH grep already returns', async () => {
    const res = await grepLocal(dir, 'target', { max: 10 })
    const hit = res.lines.find((l) => l.includes('a.ts'))
    expect(hit).toBe(`${join(dir, 'a.ts')}:2:const target = 2`)
  })

  it('skips node_modules, as the shell version does with --exclude-dir', async () => {
    const res = await grepLocal(dir, 'target', { max: 10 })
    expect(res.lines.some((l) => l.includes('node_modules'))).toBe(false)
  })

  it('honours the glob filter', async () => {
    const res = await grepLocal(dir, 'target', { max: 10, glob: '*.md' })
    expect(res.lines).toHaveLength(1)
    expect(res.lines[0]).toContain('b.md')
  })

  it('reports truncation rather than leaving it to be inferred from a full page', async () => {
    const res = await grepLocal(dir, 'target', { max: 1 })
    expect(res.lines).toHaveLength(1)
    expect(res.truncated).toBe(true)
  })
})

describe('globLocal', () => {
  beforeEach(async () => {
    await mkdir(join(dir, 'src', 'deep'), { recursive: true })
    await writeFile(join(dir, 'src', 'app.ts'), '')
    await writeFile(join(dir, 'src', 'deep', 'util.ts'), '')
    await writeFile(join(dir, 'src', 'readme.md'), '')
  })

  it('matches a bare pattern against the basename', async () => {
    const res = await globLocal(dir, '*.ts', { max: 50 })
    expect(res.lines).toHaveLength(2)
    expect(res.lines.every((l) => l.endsWith('.ts'))).toBe(true)
  })

  it('matches a pattern with a separator against the whole path', async () => {
    const res = await globLocal(dir, 'deep/*.ts', { max: 50 })
    expect(res.lines).toHaveLength(1)
    expect(res.lines[0]).toContain('util.ts')
  })

  it('lets ** cross directories where * does not', async () => {
    expect((await globLocal(dir, 'src/**/*.ts', { max: 50 })).lines).toHaveLength(2)
    expect((await globLocal(dir, 'src/*.ts', { max: 50 })).lines).toHaveLength(1)
  })
})
