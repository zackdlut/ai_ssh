import { describe, expect, it } from 'vitest'
import {
  buildMarkerCommand,
  getCaptureTiming,
  hasCaptureMarker,
  isSlowCaptureCommand,
  parseMarker,
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
