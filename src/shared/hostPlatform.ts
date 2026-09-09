/**
 * The platform this app runs on, asked in a way both processes can answer.
 *
 * `process` is a main-process global. The renderer runs with `contextIsolation`
 * on and `nodeIntegration` off, so its main world has no such binding at all —
 * reading `process.platform` there is a ReferenceError, not an `undefined`, and
 * it takes down whatever call it sits in. Shared modules are imported by both
 * sides, so a bare `process.platform` in one of them is a renderer-only crash
 * that no type check and no main-process test can see.
 *
 * Both lookups go through `globalThis`, which is defined everywhere: reading a
 * missing property off it yields `undefined` instead of throwing.
 */
export type HostPlatform = 'win32' | 'darwin' | 'other'

export function hostPlatform(): HostPlatform {
  const platform = (globalThis as { process?: { platform?: string } }).process?.platform
  if (platform) {
    if (platform === 'win32') return 'win32'
    if (platform === 'darwin') return 'darwin'
    return 'other'
  }
  // Renderer: the user agent is the only platform the main world is told about.
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? ''
  if (/Windows/i.test(ua)) return 'win32'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'darwin'
  return 'other'
}
