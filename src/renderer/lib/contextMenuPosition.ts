const VIEWPORT_PADDING = 8

export function getContextMenuPosition(
  anchorX: number,
  anchorY: number,
  menuWidth: number,
  menuHeight: number,
  padding = VIEWPORT_PADDING
): { x: number; y: number } {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  let x = anchorX
  let y = anchorY

  if (x + menuWidth > viewportWidth - padding) {
    x = viewportWidth - menuWidth - padding
  }
  if (y + menuHeight > viewportHeight - padding) {
    y = anchorY - menuHeight
  }

  x = Math.max(padding, x)
  y = Math.max(padding, y)

  return { x, y }
}
