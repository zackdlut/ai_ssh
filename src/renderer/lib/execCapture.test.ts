import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildMarkerCommand,
  createCaptureEchoFilter,
  getCaptureTiming,
  hasCaptureMarker,
  isSessionCaptureActive,
  isSlowCaptureCommand,
  parseMarker,
  registerCaptureEcho,
  runCapturedCommand,
  stripCaptureArtifacts
} from './execCapture'

describe('buildMarkerCommand', () => {
  it('chains the helper with a semicolon so PS1 is not printed in between', () => {
    const { wrapped, marker } = buildMarkerCommand('pwd')
    expect(wrapped.startsWith(`pwd; __ec=$?; __m=${marker};`)).toBe(true)
    expect(wrapped).not.toMatch(/^pwd\n__ec=/)
  })

  it('groups commented or multiline commands so the helper is not swallowed', () => {
    const commented = buildMarkerCommand('echo hello # greet')
    expect(commented.wrapped.startsWith('{ echo hello # greet\n}; __ec=$?;')).toBe(true)

    const multiline = buildMarkerCommand('cd /tmp\nls')
    expect(multiline.wrapped.startsWith('{ cd /tmp\nls\n}; __ec=$?;')).toBe(true)
  })
})

describe('stripCaptureArtifacts', () => {
  it('keeps the prompt and drops the leaked helper plus marker', () => {
    const leaked =
      '{caf_container_changes} zackzh@WireRocky(~/caf/caf_pltf/httpsv)$ __ec=$?; __m=AISSH_51c51f426fa9; printf \'\\n%s ec=%s cwd=%s %s\\n\' "$__m" "$__ec" "$(pwd 2>/dev/null)" "$__m"\n' +
      '\n' +
      'AISSH_51c51f426fa9 ec=0 cwd=/home/zackzh/caf/caf_pltf/httpsv AISSH_51c51f426fa9\n'
    const visible = stripCaptureArtifacts(leaked)
    expect(visible).toContain('{caf_container_changes} zackzh@WireRocky(~/caf/caf_pltf/httpsv)$')
    expect(visible).not.toContain('AISSH_')
    expect(visible).not.toContain('__ec=$?')
  })

  it('keeps the user command when the helper is chained on the same echoed line', () => {
    const leaked =
      'zackzh@host:~$ pwd; __ec=$?; __m=AISSH_51c51f426fa9; printf \'\\n%s\\n\' "$__m"\n' +
      'AISSH_51c51f426fa9 ec=0 cwd=/home/zackzh AISSH_51c51f426fa9\n'
    expect(stripCaptureArtifacts(leaked).trim()).toBe('zackzh@host:~$ pwd')
  })

  it('leaves ordinary output untouched', () => {
    const chunk = 'hello\nworld\n'
    expect(stripCaptureArtifacts(chunk)).toBe(chunk)
  })
})

describe('parseMarker', () => {
  it('reads exit code and cwd from the printed sentinel, not the echoed helper', () => {
    const marker = 'AISSH_51c51f426fa9'
    const echoed = `__ec=$?; __m=${marker}; printf '\\n%s ec=%s cwd=%s %s\\n' "$__m" "$__ec" "$(pwd 2>/dev/null)" "$__m"\n`
    const printed = `${marker} ec=0 cwd=/home/zackzh/caf/caf_pltf/httpsv ${marker}\n`
    expect(hasCaptureMarker(echoed, marker)).toBe(false)
    expect(parseMarker(echoed + printed, marker)).toEqual({
      exitCode: 0,
      cwd: '/home/zackzh/caf/caf_pltf/httpsv'
    })
  })
})

describe('getCaptureTiming', () => {
  it('does not idle-timeout while waiting for the marker', () => {
    expect(getCaptureTiming('pwd').idleMs).toBeNull()
    expect(getCaptureTiming('ls -la').idleMs).toBeNull()
    expect(isSlowCaptureCommand('sleep 5')).toBe(true)
    expect(getCaptureTiming('sleep 5').idleMs).toBeNull()
  })
})

describe('createCaptureEchoFilter', () => {
  /** Feed a stream one chunk at a time and return everything written out. */
  function echoOf(chunks: string[], flush = true): string {
    let out = ''
    const filter = createCaptureEchoFilter((text) => {
      out += text
    })
    for (const chunk of chunks) filter.feed(chunk)
    if (flush) filter.flush()
    return out
  }

  it('never leaks a helper that a chunk boundary cut in half', () => {
    const marker = 'AISSH_51c51f426fa9'
    const line = `zackzh@host:~$ ls; __ec=$?; __m=${marker}; printf '\\n%s\\n' "$__m"\n`
    for (let cut = 1; cut < line.length; cut++) {
      const out = echoOf([line.slice(0, cut), line.slice(cut)])
      expect(out).not.toContain('AISSH_')
      expect(out).not.toContain('__ec')
      expect(out).not.toContain('__m')
      expect(out.trim()).toBe('zackzh@host:~$ ls')
    }
  })

  it('never leaks the printed sentinel, however it is split', () => {
    const marker = 'AISSH_51c51f426fa9'
    const line = `total 4\n${marker} ec=0 cwd=/home/zackzh ${marker}\n`
    for (let cut = 1; cut < line.length; cut++) {
      const out = echoOf([line.slice(0, cut), line.slice(cut)])
      expect(out).not.toContain('AISSH_')
      expect(out.trim()).toBe('total 4')
    }
  })

  it('drops a helper tail that readline wrapped onto its own line', () => {
    const out = echoOf([
      'zackzh@host:~$ ls; __ec=$?; __m=AISSH_51c51f426fa9;\n',
      `printf '\\n%s ec=%s cwd=%s %s\\n' "$__m" "$__ec" "$(pwd 2>/dev/null)" "$__m"\n`
    ])
    expect(out).not.toContain('$__m')
    expect(out).not.toContain('pwd 2>/dev/null')
  })

  it('passes plain output straight through and keeps carriage-return progress live', () => {
    expect(echoOf(['hello\nwor', 'ld\n'], false)).toBe('hello\nworld\n')
    expect(echoOf(['30%\r', '60%\r'], false)).toBe('30%\r60%\r')
  })

  it('flags only the opening write, so the view is pulled down once per command', () => {
    const firsts: boolean[] = []
    const filter = createCaptureEchoFilter((_text, first) => firsts.push(first))
    filter.feed('one\n')
    filter.feed('two\n')
    filter.flush()
    expect(firsts).toEqual([true, false])
  })

  it('releases a last line that never got a newline', () => {
    let out = ''
    const filter = createCaptureEchoFilter((text) => {
      out += text
    })
    filter.feed('no trailing newline __e')
    expect(out).toBe('no trailing newline')
    filter.flush()
    expect(out).toBe('no trailing newline __e')
  })
})

describe('runCapturedCommand', () => {
  const handlers: ((e: { sessionId: string; data: string }) => void)[] = []
  let writes: string[] = []

  beforeEach(() => {
    handlers.length = 0
    writes = []
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        ssh: {
          onData: (fn: (e: { sessionId: string; data: string }) => void) => {
            handlers.push(fn)
            return () => {
              const at = handlers.indexOf(fn)
              if (at >= 0) handlers.splice(at, 1)
            }
          },
          onStatus: () => () => {},
          write: (_sessionId: string, data: string) => writes.push(data)
        }
      }
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  const emit = (data: string): void => {
    for (const fn of [...handlers]) fn({ sessionId: 's1', data })
  }
  const markerOf = (wrapped: string): string => /__m=(AISSH_[A-Za-z0-9]+)/.exec(wrapped)![1]

  it('refuses a second command while the shell is still busy', async () => {
    const first = runCapturedCommand('s1', 'sleep 1')
    expect(isSessionCaptureActive('s1')).toBe(true)

    const second = await runCapturedCommand('s1', 'echo nope')
    expect(second.busy).toBe(true)
    // The busy command must not reach the shell alongside the running one.
    expect(writes).toHaveLength(1)

    const marker = markerOf(writes[0])
    emit(`\n${marker} ec=0 cwd=/tmp ${marker}\n`)
    expect((await first).busy).toBeUndefined()
    // Teardown is queued so late listeners still see the marker chunk.
    await Promise.resolve()
    expect(isSessionCaptureActive('s1')).toBe(false)
  })

  it('echoes a visible command into the registered terminal, sentinels removed', async () => {
    let shown = ''
    const unregister = registerCaptureEcho('s1', (text) => {
      shown += text
    })
    const run = runCapturedCommand('s1', 'echo hi', { visible: true })
    const marker = markerOf(writes[0])

    emit(`echo hi; __ec=$?; __m=${marker}; printf '\\n%s ec=%s cwd=%s %s\\n' "$__m" "$__e`)
    expect(shown).not.toContain('__ec')
    emit(`c" "$(pwd 2>/dev/null)" "$__m"\r\nhi\n`)
    emit(`\n${marker} ec=0 cwd=/tmp ${marker}\n`)

    const cap = await run
    expect(cap.exitCode).toBe(0)
    expect(shown).toContain('hi')
    expect(shown).not.toContain('AISSH_')
    expect(shown).not.toContain('__ec')
    unregister()
  })

  it('keeps a silent capture off the screen', async () => {
    let shown = ''
    const unregister = registerCaptureEcho('s1', (text) => {
      shown += text
    })
    const run = runCapturedCommand('s1', 'pwd')
    const marker = markerOf(writes[0])
    emit(`/tmp\n${marker} ec=0 cwd=/tmp ${marker}\n`)

    expect((await run).cwd).toBe('/tmp')
    expect(shown).toBe('')
    unregister()
  })
})
