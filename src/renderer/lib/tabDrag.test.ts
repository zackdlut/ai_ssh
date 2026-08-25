import { describe, expect, it } from 'vitest'
import { TAB_DRAG_MIME, dropZoneSplit, isTabDrag, readDraggedTabId } from './tabDrag'

function fakeTransfer(types: string[], data: Record<string, string> = {}): DataTransfer {
  return {
    types,
    getData: (type: string) => data[type] ?? ''
  } as unknown as DataTransfer
}

describe('dropZoneSplit', () => {
  it('puts the new pane on the side that was dropped on', () => {
    expect(dropZoneSplit('left')).toEqual({ dir: 'row', before: true })
    expect(dropZoneSplit('right')).toEqual({ dir: 'row', before: false })
    expect(dropZoneSplit('top')).toEqual({ dir: 'col', before: true })
    expect(dropZoneSplit('bottom')).toEqual({ dir: 'col', before: false })
  })

  it('treats the centre as "no split"', () => {
    expect(dropZoneSplit('center')).toBeNull()
  })
})

describe('isTabDrag', () => {
  it('accepts our own drags and ignores foreign ones', () => {
    expect(isTabDrag(fakeTransfer([TAB_DRAG_MIME]))).toBe(true)
    expect(isTabDrag(fakeTransfer(['Files']))).toBe(false)
    expect(isTabDrag(fakeTransfer([]))).toBe(false)
    expect(isTabDrag(null)).toBe(false)
  })

  it('recognises a drag that also carries other types', () => {
    expect(isTabDrag(fakeTransfer(['text/plain', TAB_DRAG_MIME]))).toBe(true)
  })
})

describe('readDraggedTabId', () => {
  it('reads the tab id out of the payload', () => {
    const dt = fakeTransfer([TAB_DRAG_MIME], { [TAB_DRAG_MIME]: 'tab-7' })
    expect(readDraggedTabId(dt)).toBe('tab-7')
  })

  it('returns null when the payload is empty, as during dragover', () => {
    expect(readDraggedTabId(fakeTransfer([TAB_DRAG_MIME]))).toBeNull()
    expect(readDraggedTabId(null)).toBeNull()
  })
})
