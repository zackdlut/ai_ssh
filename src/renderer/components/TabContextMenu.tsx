import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'
import { usePaneLayoutStore, type PaneTab } from '../store/paneLayoutStore'
import { usePaneWorkspaceStore } from '../store/paneWorkspaceStore'
import { useKeybindingsStore } from '../store/keybindingsStore'
import { MAX_PANES_PER_TAB, MAX_PANES_TOTAL } from '../lib/paneLayout'
import { countLayoutLeaves } from '../lib/paneLayoutSerialize'
import { getContextMenuPosition } from '../lib/contextMenuPosition'
import { duplicateSession, reconnectSession } from '../lib/connect'
import { useT } from '../lib/i18n'
import ContextMenuItem from './ContextMenuItem'
import UiIcon from './UiIcon'

/**
 * What one tab shows: the tab itself plus the session in its focused pane.
 *
 * A tab owns a whole tree, so nothing about it is a single session — but the
 * label, the status dot and the session-specific menu entries all describe the
 * pane the user is looking at, which is what Windows Terminal does too.
 */
export interface TabView {
  tab: PaneTab
  session?: TerminalSession
  paneCount: number
  /** Every session in the tree, so closing the tab can close all of them. */
  terminalIds: string[]
}

const TAB_COLORS = [
  '#ff6b6b',
  '#ff9d3c',
  '#ffd93d',
  '#51cf66',
  '#4dabf7',
  '#b197fc',
  '#f783ac',
  '#adb5bd'
]

interface Props {
  x: number
  y: number
  view: TabView
  tabCount: number
  onClose: () => void
  onRename: (view: TabView) => void
  onSaveOutput: (session: TerminalSession) => void
  onCloseTab: (view: TabView) => void
  onCloseOthers: (view: TabView) => void
  onCloseAll: () => void
}

export default function TabContextMenu({
  x,
  y,
  view,
  tabCount,
  onClose,
  onRename,
  onSaveOutput,
  onCloseTab,
  onCloseOthers,
  onCloseAll
}: Props): JSX.Element {
  const t = useT()
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [naming, setNaming] = useState(false)

  const activateTab = usePaneLayoutStore((s) => s.activateTab)
  const splitFocused = usePaneLayoutStore((s) => s.splitFocused)
  const showTerminal = usePaneLayoutStore((s) => s.showTerminal)
  const totalPaneCount = usePaneLayoutStore((s) => s.totalPaneCount())
  const setSessionColor = useSessionsStore((s) => s.setSessionColor)

  const layouts = usePaneWorkspaceStore((s) => s.layouts)
  const loaded = usePaneWorkspaceStore((s) => s.loaded)
  const loadLayouts = usePaneWorkspaceStore((s) => s.load)
  const saveLayout = usePaneWorkspaceStore((s) => s.save)
  const restoreLayout = usePaneWorkspaceStore((s) => s.restore)
  const removeLayout = usePaneWorkspaceStore((s) => s.remove)

  const splitVertical = useKeybindingsStore((s) => s.splitVertical)
  const splitHorizontal = useKeybindingsStore((s) => s.splitHorizontal)

  const canSplit = view.paneCount < MAX_PANES_PER_TAB && totalPaneCount < MAX_PANES_TOTAL
  const canDuplicatePane = view.session?.status === 'connected' && canSplit
  const splitTitle = canSplit ? undefined : t('pane.maxPanes')

  useEffect(() => {
    if (!loaded) void loadLayouts()
  }, [loaded, loadLayouts])

  useEffect(() => {
    if (naming) return
    const closeIfOutside = (e: Event): void => {
      if (menuRef.current?.contains(e.target as Node)) return
      onClose()
    }
    window.addEventListener('click', closeIfOutside)
    window.addEventListener('wheel', closeIfOutside)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('click', closeIfOutside)
      window.removeEventListener('wheel', closeIfOutside)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, naming])

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos(getContextMenuPosition(x, y, rect.width, rect.height))
  }, [x, y, layouts.length])

  const runOnTab = (fn: () => void): void => {
    onClose()
    activateTab(view.tab.id)
    fn()
  }

  /**
   * Windows Terminal's Duplicate Pane: split, then dial the same host into the
   * pane that appeared. A failed dial takes its pane with it, so a refused
   * connection does not leave the layout rearranged for nothing.
   */
  const duplicatePane = async (): Promise<void> => {
    const terminalId = view.session?.id
    onClose()
    activateTab(view.tab.id)
    const layout = usePaneLayoutStore.getState()
    if (!terminalId || !layout.canSplit()) return
    layout.splitFocused('row')
    const paneId = usePaneLayoutStore.getState().activeTab().focusedPaneId
    const err = await duplicateSession(terminalId, paneId)
    if (err) {
      usePaneLayoutStore.getState().closePane(paneId)
      window.alert(err)
    }
  }

  return (
    <>
      {!naming && (
        <div
          ref={menuRef}
          className="context-menu tab-context-menu"
          role="menu"
          style={{
            left: pos?.x ?? x,
            top: pos?.y ?? y,
            visibility: pos ? 'visible' : 'hidden'
          }}
          onClick={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
        {view.session && (view.session.status === 'closed' || view.session.status === 'error') && (
          <>
            <ContextMenuItem
              icon="connect"
              onClick={() => {
                const id = view.session!.id
                onClose()
                showTerminal(id)
                void reconnectSession(id)
              }}
            >
              {t('tabbar.reconnect')}
            </ContextMenuItem>
            <div className="context-menu-divider" role="separator" />
          </>
        )}
        <ContextMenuItem icon="rename" onClick={() => onRename(view)}>
          {t('tabbar.rename')}
        </ContextMenuItem>
        {view.session && (
          <div className="context-menu-colors" onClick={(e) => e.stopPropagation()}>
            <span className="context-menu-colors-label">{t('tabbar.setColor')}</span>
            <div className="context-menu-swatches">
              {TAB_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-swatch ${view.session!.color === c ? 'active' : ''}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => {
                    setSessionColor(view.session!.id, c)
                    onClose()
                  }}
                />
              ))}
              <button
                type="button"
                className={`color-swatch color-swatch-none ${!view.session.color ? 'active' : ''}`}
                title={t('tabbar.colorNone')}
                onClick={() => {
                  setSessionColor(view.session!.id, undefined)
                  onClose()
                }}
              />
            </div>
          </div>
        )}

        <div className="context-menu-divider" role="separator" />
        <ContextMenuItem
          icon="copy"
          disabled={view.session?.status !== 'connected'}
          onClick={() => {
            const id = view.session!.id
            onClose()
            void duplicateSession(id)
          }}
        >
          {t('tabbar.duplicate')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="split-right"
          disabled={!canSplit}
          title={splitTitle}
          shortcut={splitVertical}
          onClick={() => runOnTab(() => splitFocused('row'))}
        >
          {t('pane.splitRight')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="split-down"
          disabled={!canSplit}
          title={splitTitle}
          shortcut={splitHorizontal}
          onClick={() => runOnTab(() => splitFocused('col'))}
        >
          {t('pane.splitDown')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="copy"
          disabled={!canDuplicatePane}
          title={splitTitle}
          onClick={() => void duplicatePane()}
        >
          {t('pane.duplicatePane')}
        </ContextMenuItem>

        <div className="context-menu-divider" role="separator" />
        <div className="context-menu-section">{t('workspace.title')}</div>
        <ContextMenuItem
          icon="save"
          onClick={() => {
            activateTab(view.tab.id)
            setNaming(true)
          }}
        >
          {t('workspace.save')}
        </ContextMenuItem>
        {layouts.length === 0 ? (
          <div className="pane-menu-note">{t('workspace.none')}</div>
        ) : (
          <div className="context-menu-layouts">
            {layouts.map((layout) => (
              <div className="pane-menu-row" key={layout.id}>
                <button
                  type="button"
                  className="pane-menu-row-main"
                  onClick={() => {
                    onClose()
                    restoreLayout(layout.id)
                  }}
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
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeLayout(layout.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="context-menu-divider" role="separator" />
        <ContextMenuItem
          icon="save"
          disabled={!view.session}
          onClick={() => {
            if (!view.session) return
            void onSaveOutput(view.session)
          }}
        >
          {t('tabbar.saveOutput')}
        </ContextMenuItem>
        <div className="context-menu-divider" role="separator" />
        <ContextMenuItem
          icon="delete"
          onClick={() => {
            onClose()
            onCloseTab(view)
          }}
        >
          {t('tabbar.closeTab')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={tabCount <= 1}
          icon="close-others"
          onClick={() => onCloseOthers(view)}
        >
          {t('tabbar.closeOthers')}
        </ContextMenuItem>
        <ContextMenuItem icon="close-all" onClick={onCloseAll}>
          {t('tabbar.closeAll')}
        </ContextMenuItem>
        </div>
      )}
      {naming && (
        <SaveLayoutPrompt
          onCancel={() => {
            setNaming(false)
            onClose()
          }}
          onSave={(name) => {
            activateTab(view.tab.id)
            void saveLayout(name)
            onClose()
          }}
        />
      )}
    </>
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
