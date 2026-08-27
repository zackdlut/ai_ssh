import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildMarkerCommand,
  createCaptureEchoFilter,
  execTimeoutMs,
  getCaptureTiming,
  hasCaptureMarker,
  interruptSessionCapture,
  isSessionCaptureActive,
  isSlowCaptureCommand,
  nextCaptureDeadline,
  parseMarker,
  refreshCommandTimeoutMinutes,
  registerCaptureEcho,
  runCapturedCommand,
  stripCaptureArtifacts
} from './execCapture'
import { DEFAULT_COMMAND_TIMEOUT_MINUTES } from '../../shared/aiSettings'

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
  afterEach(() => {
    refreshCommandTimeoutMinutes(DEFAULT_COMMAND_TIMEOUT_MINUTES)
  })

  it('does not idle-timeout while waiting for the marker', () => {
    expect(getCaptureTiming('pwd').idleMs).toBeNull()
    expect(getCaptureTiming('ls -la').idleMs).toBeNull()
    expect(isSlowCaptureCommand('sleep 5')).toBe(true)
    expect(getCaptureTiming('sleep 5').idleMs).toBeNull()
  })

  it('uses a 2-minute stall for typical commands and a 1-hour default ceiling', () => {
    const typical = getCaptureTiming('ls -la')
    expect(typical.slow).toBe(false)
    expect(typical.hardTimeoutMs).toBe(120_000)
    expect(typical.absoluteMaxMs).toBe(3_600_000)

    const slow = getCaptureTiming('npm install')
    expect(slow.slow).toBe(true)
    expect(slow.hardTimeoutMs).toBe(600_000)
    expect(slow.absoluteMaxMs).toBe(3_600_000)
  })

  it('treats builds, installs and transfers as slow even with sudo/env prefixes', () => {
    expect(isSlowCaptureCommand('docker build .')).toBe(true)
    expect(isSlowCaptureCommand('make all')).toBe(true)
    expect(isSlowCaptureCommand('sudo apt-get update')).toBe(true)
    expect(isSlowCaptureCommand('FOO=1 git clone https://example.com/repo.git')).toBe(true)
    expect(isSlowCaptureCommand('echo hi')).toBe(false)
    expect(execTimeoutMs('pwd')).toBe(120_000)
    expect(execTimeoutMs('cargo build')).toBe(600_000)
  })

  it('postpones the stall window on activity until the absolute ceiling', () => {
    const timing = getCaptureTiming('ls')
    expect(nextCaptureDeadline(0, timing, 0)).toBe(120_000)
    expect(nextCaptureDeadline(0, timing, 100_000)).toBe(120_000)
    expect(nextCaptureDeadline(0, timing, 3_550_000)).toBe(50_000)
    expect(nextCaptureDeadline(0, timing, 3_600_000)).toBe(0)
  })

  it('honours a configured absolute ceiling and clamps below the minimum', () => {
    refreshCommandTimeoutMinutes(120)
    expect(getCaptureTiming('ls').absoluteMaxMs).toBe(120 * 60_000)
    refreshCommandTimeoutMinutes(5)
    expect(getCaptureTiming('ls').absoluteMaxMs).toBe(10 * 60_000)
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
    vi.useRealTimers()
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

  it('does not stall-timeout while the command keeps producing output', async () => {
    vi.useFakeTimers()
    const run = runCapturedCommand('s1', 'pwd')
    const marker = markerOf(writes[0])

    await vi.advanceTimersByTimeAsync(100_000)
    emit('still going\n')
    await vi.advanceTimersByTimeAsync(100_000)
    expect(writes.some((w) => w === '\x03')).toBe(false)

    emit(`\n${marker} ec=0 cwd=/tmp ${marker}\n`)
    const cap = await run
    expect(cap.timedOut).toBe(false)
    expect(cap.exitCode).toBe(0)
  })

  it('sends Ctrl+C when the stall window expires with no marker', async () => {
    vi.useFakeTimers()
    const run = runCapturedCommand('s1', 'pwd')
    expect(writes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(writes).toContain('\x03')

    await vi.advanceTimersByTimeAsync(2000)
    const cap = await run
    expect(cap.timedOut).toBe(true)
    expect(cap.aborted).toBe(false)
  })

  it('interruptSessionCapture sends Ctrl+C and marks the capture aborted', async () => {
    vi.useFakeTimers()
    const run = runCapturedCommand('s1', 'pwd')
    expect(interruptSessionCapture('s1')).toBe(true)
    expect(writes).toContain('\x03')

    await vi.advanceTimersByTimeAsync(2000)
    const cap = await run
    expect(cap.aborted).toBe(true)
    expect(cap.timedOut).toBe(false)
  })

  it('interruptSessionCapture returns false when no capture is active', () => {
    expect(interruptSessionCapture('s1')).toBe(false)
  })
})
