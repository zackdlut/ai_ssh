import { describe, expect, it } from 'vitest'
import {
  PANE_DRAG_MIME,
  TAB_DRAG_MIME,
  dropZoneSplit,
  isLayoutDrag,
  isPaneDrag,
  isTabDrag,
  paneDropAction,
  readDraggedPaneId,
  readDraggedTabId
} from './tabDrag'

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

describe('pane drag MIME', () => {
  it('recognises a pane drag and ignores a tab drag', () => {
    expect(isPaneDrag(fakeTransfer([PANE_DRAG_MIME]))).toBe(true)
    expect(isPaneDrag(fakeTransfer([TAB_DRAG_MIME]))).toBe(false)
    expect(isPaneDrag(null)).toBe(false)
  })

  it('treats either MIME as a layout drag that should arm drop zones', () => {
    expect(isLayoutDrag(fakeTransfer([TAB_DRAG_MIME]))).toBe(true)
    expect(isLayoutDrag(fakeTransfer([PANE_DRAG_MIME]))).toBe(true)
    expect(isLayoutDrag(fakeTransfer(['Files']))).toBe(false)
  })

  it('reads the pane id out of the payload', () => {
    const dt = fakeTransfer([PANE_DRAG_MIME], { [PANE_DRAG_MIME]: 'pane-3' })
    expect(readDraggedPaneId(dt)).toBe('pane-3')
    expect(readDraggedPaneId(fakeTransfer([PANE_DRAG_MIME]))).toBeNull()
  })
})

describe('paneDropAction', () => {
  const paneDrag = (paneId: string): DataTransfer =>
    fakeTransfer([PANE_DRAG_MIME], { [PANE_DRAG_MIME]: paneId })
  const tabDrag = (terminalId: string): DataTransfer =>
    fakeTransfer([TAB_DRAG_MIME], { [TAB_DRAG_MIME]: terminalId })

  it('swaps two panes on a centre drop', () => {
    expect(paneDropAction(paneDrag('p1'), 'center', 'p2')).toEqual({
      kind: 'swapPanes',
      sourcePaneId: 'p1'
    })
  })

  it('moves a pane to the side that was dropped on', () => {
    expect(paneDropAction(paneDrag('p1'), 'top', 'p2')).toEqual({
      kind: 'movePane',
      sourcePaneId: 'p1',
      dir: 'col',
      before: true
    })
    expect(paneDropAction(paneDrag('p1'), 'right', 'p2')).toEqual({
      kind: 'movePane',
      sourcePaneId: 'p1',
      dir: 'row',
      before: false
    })
  })

  it('ignores a pane dropped on itself', () => {
    for (const zone of ['center', 'left', 'bottom'] as const) {
      expect(paneDropAction(paneDrag('p1'), zone, 'p1')).toBeNull()
    }
  })

  it('still handles a tab dragged off the tab bar', () => {
    expect(paneDropAction(tabDrag('t1'), 'center', 'p2')).toEqual({
      kind: 'showTerminal',
      terminalId: 't1'
    })
    expect(paneDropAction(tabDrag('t1'), 'left', 'p2')).toEqual({
      kind: 'splitWithTerminal',
      terminalId: 't1',
      dir: 'row',
      before: true
    })
  })

  it('is null for a foreign or empty payload', () => {
    expect(paneDropAction(fakeTransfer(['Files']), 'center', 'p2')).toBeNull()
    expect(paneDropAction(null, 'center', 'p2')).toBeNull()
    // A pane drag whose id cannot be read is not a tab drag either.
    expect(paneDropAction(fakeTransfer([PANE_DRAG_MIME]), 'center', 'p2')).toBeNull()
  })
})
