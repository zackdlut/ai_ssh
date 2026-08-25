let cached: boolean | null = null

function probe(): boolean {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) return false
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
    // Release the probe context immediately; contexts are a limited resource.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    if (!renderer) return true
    return !/swiftshader|software|llvmpipe|basic render/i.test(renderer)
  } catch {
    return false
  }
}

/**
 * Whether WebGL2 is backed by a real GPU.
 *
 * Worth checking rather than just trying: the main process calls
 * `app.disableHardwareAcceleration()` to avoid GPU-process crashes in WSL and
 * VMs, and Chromium then still serves WebGL2 — through SwiftShader, a CPU
 * rasteriser that is *slower* than xterm's DOM renderer. So a plain
 * try/catch around the addon would happily make split panes worse. Cached
 * because the answer cannot change within a session.
 */
export function hasGpuWebgl2(): boolean {
  if (cached === null) cached = probe()
  return cached
}
