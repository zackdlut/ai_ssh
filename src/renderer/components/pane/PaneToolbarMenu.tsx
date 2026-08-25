import { useEffect, useRef, useState } from 'react'
import { selectActiveTab, usePaneLayoutStore } from '../../store/paneLayoutStore'
import { useSessionsStore } from '../../store/sessionsStore'
import { usePaneDiffStore } from '../../store/paneDiffStore'
import { usePaneWorkspaceStore } from '../../store/paneWorkspaceStore'
import { countLeaves, type LayoutPreset } from '../../lib/paneLayout'
import { countLayoutLeaves } from '../../lib/paneLayoutSerialize'
import { duplicateSession } from '../../lib/connect'
import { useT } from '../../lib/i18n'
import UiIcon from '../UiIcon'
import DropdownMenuItem from '../DropdownMenuItem'

const PRESETS: { id: LayoutPreset; labelKey: 'pane.presetSingle' | 'pane.presetCols2' | 'pane.presetRows2' | 'pane.presetGrid4' }[] = [
  { id: 'single', labelKey: 'pane.presetSingle' },
  { id: 'cols2', labelKey: 'pane.presetCols2' },
  { id: 'rows2', labelKey: 'pane.presetRows2' },
  { id: 'grid4', labelKey: 'pane.presetGrid4' }
]

/**
 * Toolbar entry point for splitting, preset layouts, saved workspaces and diff.
 * Sync-group state and its actions live on the status bar instead, next to the
 * lock buttons that form the group.
 */
export default function PaneToolbarMenu(): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const splitFocused = usePaneLayoutStore((s) => s.splitFocused)
  const applyPreset = usePaneLayoutStore((s) => s.applyPreset)
  const evenOut = usePaneLayoutStore((s) => s.evenOut)
  const paneCount = usePaneLayoutStore((s) => countLeaves(selectActiveTab(s).root))
  const canSplit = usePaneLayoutStore((s) => s.canSplit())
  const focusedTerminalId = usePaneLayoutStore((s) => s.focusedTerminalId())
  const canDuplicate = useSessionsStore(
    (s) => s.sessions.find((session) => session.id === focusedTerminalId)?.status === 'connected'
  )
  const openDiff = usePaneDiffStore((s) => s.openPanel)

  const layouts = usePaneWorkspaceStore((s) => s.layouts)
  const loaded = usePaneWorkspaceStore((s) => s.loaded)
  const loadLayouts = usePaneWorkspaceStore((s) => s.load)
  const saveLayout = usePaneWorkspaceStore((s) => s.save)
  const restoreLayout = usePaneWorkspaceStore((s) => s.restore)
  const removeLayout = usePaneWorkspaceStore((s) => s.remove)
  const [naming, setNaming] = useState(false)

  // Saved layouts are only needed once this menu is opened.
  useEffect(() => {
    if (open && !loaded) void loadLayouts()
  }, [open, loaded, loadLayouts])

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  const run = (fn: () => void): void => {
    setOpen(false)
    fn()
  }

  /**
   * Windows Terminal's Duplicate Pane: split, then dial the same host into the
   * pane that appeared. A failed dial takes its pane with it, so a refused
   * connection does not leave the layout rearranged for nothing.
   */
  const duplicatePane = async (): Promise<void> => {
    const layout = usePaneLayoutStore.getState()
    if (!focusedTerminalId || !layout.canSplit()) return
    layout.splitFocused('row')
    const paneId = usePaneLayoutStore.getState().activeTab().focusedPaneId
    const err = await duplicateSession(focusedTerminalId, paneId)
    if (err) {
      usePaneLayoutStore.getState().closePane(paneId)
      window.alert(err)
    }
  }

  return (
    <div className="tabbar-action-slot toolbar-menu-wrap" ref={wrapRef}>
      <button
        className={`toolbar-btn toolbar-menu-btn tabbar-action-btn ${open ? 'active' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        title={t('pane.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <UiIcon name="layout-grid" />
        <span>{t('pane.menu')}</span>
        {paneCount > 1 && <span className="pane-menu-count">{paneCount}</span>}
        <UiIcon name="caret-down" className={`toolbar-menu-caret ${open ? 'open' : ''}`} size="sm" />
      </button>
      {open && (
        <div className="toolbar-dropdown-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem
            icon="split-right"
            disabled={!canSplit}
            title={canSplit ? undefined : t('pane.maxPanes')}
            onClick={() => run(() => splitFocused('row'))}
          >
            {t('pane.splitRight')}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon="split-down"
            disabled={!canSplit}
            title={canSplit ? undefined : t('pane.maxPanes')}
            onClick={() => run(() => splitFocused('col'))}
          >
            {t('pane.splitDown')}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon="copy"
            disabled={!canDuplicate || !canSplit}
            title={canSplit ? undefined : t('pane.maxPanes')}
            onClick={() => run(() => void duplicatePane())}
          >
            {t('pane.duplicatePane')}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon="layout-grid"
            disabled={paneCount < 2}
            title={t('pane.evenOutHint')}
            onClick={() => run(() => evenOut())}
          >
            {t('pane.evenOut')}
          </DropdownMenuItem>
          <DropdownMenuItem icon="diff" onClick={() => run(() => openDiff())}>
            {t('pane.diff')}
          </DropdownMenuItem>

          <div className="toolbar-dropdown-divider" role="separator" />
          <div className="toolbar-dropdown-label">{t('pane.layoutSection')}</div>
          {PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset.id}
              icon="layout-grid"
              onClick={() => run(() => applyPreset(preset.id))}
            >
              {t(preset.labelKey)}
            </DropdownMenuItem>
          ))}

          <div className="toolbar-dropdown-divider" role="separator" />
          <div className="toolbar-dropdown-label">{t('workspace.title')}</div>
          <DropdownMenuItem icon="save" onClick={() => run(() => setNaming(true))}>
            {t('workspace.save')}
          </DropdownMenuItem>
          {layouts.length === 0 ? (
            <div className="pane-menu-note">{t('workspace.none')}</div>
          ) : (
            layouts.map((layout) => (
              <div className="pane-menu-row" key={layout.id}>
                <button
                  type="button"
                  className="pane-menu-row-main"
                  onClick={() => run(() => restoreLayout(layout.id))}
                  title={t('workspace.restoreHint')}
                >
                  <UiIcon name="layout-grid" size="sm" />
                  <span className="pane-menu-row-name">{layout.name}</span>
                  <span className="pane-menu-row-meta">
                    {t('workspace.paneCount', { count: countLayoutLeaves(layout.root) })}
                  </span>
                </button>
                <button
                  type="button"
                  className="pane-menu-row-del"
                  title={t('workspace.delete')}
                  onClick={() => void removeLayout(layout.id)}
                >
                  ×
                </button>
              </div>
            ))
          )}

        </div>
      )}
      {naming && (
        <SaveLayoutPrompt
          onCancel={() => setNaming(false)}
          onSave={(name) => {
            setNaming(false)
            void saveLayout(name)
          }}
        />
      )}
    </div>
  )
}

/** Asks for a workspace name before storing the current split tree. */
function SaveLayoutPrompt({
  onSave,
  onCancel
}: {
  onSave: (name: string) => void
  onCancel: () => void
}): JSX.Element {
  const t = useT()
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const submit = (): void => {
    if (name.trim()) onSave(name)
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal modal-save-layout"
        role="dialog"
        aria-label={t('workspace.save')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">{t('workspace.save')}</div>
        <div className="modal-body">
          <div className="context-hint">{t('workspace.saveHint')}</div>
          <input
            ref={inputRef}
            className="save-layout-input"
            value={name}
            placeholder={t('workspace.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onCancel()
            }}
          />
        </div>
        <div className="modal-footer">
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button className="primary" disabled={!name.trim()} onClick={submit}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
