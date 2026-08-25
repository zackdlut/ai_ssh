import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'
import { useAIStore } from '../store/aiStore'
import { useSftpStore } from '../store/sftpStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import { usePaneLayoutStore } from '../store/paneLayoutStore'
import { connectFromConfig, connectWsl } from '../lib/connect'
import { readFullTerminalOutput } from '../lib/terminalRegistry'
import { useT, type TranslationKey } from '../lib/i18n'
import UiIcon from './UiIcon'
import DropdownMenuItem from './DropdownMenuItem'
import TabContextMenu, { type TabView } from './TabContextMenu'
import type { WslDistro } from '../../shared/types'
import { collectLeaves } from '../lib/paneLayout'
import { TAB_DRAG_MIME } from '../lib/tabDrag'

export type SettingsMenuItem =
  | 'ai'
  | 'skills'
  | 'userRules'
  | 'themes'
  | 'terminal'
  | 'shortcuts'
  | 'language'
  | 'startup'
  | 'about'

interface TabMenuState {
  x: number
  y: number
  view: TabView
}

function defaultLogName(tab: TerminalSession): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${tab.username}@${tab.host}-${stamp}.log`
}

function sessionLabel(session: TerminalSession): string {
  return session.customTitle ?? session.title
}

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string

/** `customTitle` wins, else the focused pane's session, as Windows Terminal does. */
function tabLabel(view: TabView, t: Translate): string {
  if (view.tab.customTitle) return view.tab.customTitle
  return view.session ? sessionLabel(view.session) : t('pane.emptyTitle')
}

function tabHoverTitle(view: TabView, t: Translate): string {
  const { session } = view
  const base =
    !session || session.status === 'idle'
      ? tabLabel(view, t)
      : t('tabbar.tabTitle', {
          user: session.username,
          host: session.host,
          nlMode: session.nlMode ? t('tabbar.nlMode') : '',
          action: t('tabbar.doubleClickRename')
        })
  if (view.paneCount < 2) return base
  return `${base} · ${t('workspace.paneCount', { count: view.paneCount })}`
}

interface Props {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onNewTab: () => void
  onSettingsSelect: (item: SettingsMenuItem) => void
}

export default function TabBar({
  sidebarOpen,
  onToggleSidebar,
  onNewTab,
  onSettingsSelect
}: Props): JSX.Element {
  const { sessions, activeSessionId, removeSessions } = useSessionsStore()
  const paneTabs = usePaneLayoutStore((s) => s.tabs)
  const activeTabId = usePaneLayoutStore((s) => s.activeTabId)
  const activateTab = usePaneLayoutStore((s) => s.activateTab)
  const reorderTab = usePaneLayoutStore((s) => s.reorderTab)
  const renamePaneTab = usePaneLayoutStore((s) => s.renameTab)
  const { panelOpen, togglePanel } = useAIStore()
  const sftpOpen = useSftpStore((s) => s.panelOpen)
  const toggleSftp = useSftpStore((s) => s.togglePanel)
  const setSftpOpen = useSftpStore((s) => s.setPanelOpen)
  // Subscribe to connections so the recent list refreshes as usage changes.
  const connections = useBookmarksStore((s) => s.connections)
  const getRecentConnections = useBookmarksStore((s) => s.getRecentConnections)
  const t = useT()
  const [recentOpen, setRecentOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [wslDistros, setWslDistros] = useState<WslDistro[]>([])
  const [wslMenuOpen, setWslMenuOpen] = useState(false)
  const [menu, setMenu] = useState<TabMenuState | null>(null)
  const closeMenu = useCallback((): void => setMenu(null), [])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const recent = recentOpen ? getRecentConnections(5) : []
  const activeIsWsl = sessions.find((tt) => tt.id === activeSessionId)?.kind === 'wsl'

  const views = useMemo<TabView[]>(
    () =>
      paneTabs.map((tab) => {
        const leaves = collectLeaves(tab.root)
        const focusedTerminalId = leaves.find((leaf) => leaf.id === tab.focusedPaneId)?.terminalId
        return {
          tab,
          session: focusedTerminalId
            ? sessions.find((s) => s.id === focusedTerminalId)
            : undefined,
          paneCount: leaves.length,
          terminalIds: leaves
            .map((leaf) => leaf.terminalId)
            .filter((id): id is string => Boolean(id))
        }
      }),
    [paneTabs, sessions]
  )

  // SFTP relies on the SSH channel; close the panel when a WSL tab is active.
  useEffect(() => {
    if (activeIsWsl && sftpOpen) setSftpOpen(false)
  }, [activeIsWsl, sftpOpen, setSftpOpen])

  // Probe installed WSL distributions once; empty on non-Windows so the button
  // stays hidden there.
  useEffect(() => {
    let cancelled = false
    void window.api.wsl.list().then((list) => {
      if (!cancelled) setWslDistros(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!wslMenuOpen) return
    const close = (): void => setWslMenuOpen(false)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [wslMenuOpen])

  const openWsl = (distro?: string): void => {
    setWslMenuOpen(false)
    void connectWsl(distro)
  }

  const handleWslClick = (): void => {
    if (wslDistros.length <= 1) {
      openWsl(wslDistros[0]?.name)
    } else {
      setWslMenuOpen((v) => !v)
    }
  }

  useEffect(() => {
    if (!recentOpen) return
    const close = (): void => setRecentOpen(false)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [recentOpen])

  useEffect(() => {
    if (!settingsOpen) return
    const close = (): void => setSettingsOpen(false)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [settingsOpen])

  const saveTabOutput = async (session: TerminalSession): Promise<void> => {
    closeMenu()
    const content = readFullTerminalOutput(session.id).trim()
    if (!content) {
      window.alert(t('tabbar.saveOutputEmpty'))
      return
    }
    const res = await window.api.terminal.saveLog(content, defaultLogName(session))
    if (res.error) window.alert(t('tabbar.saveOutputFailed', { error: res.error }))
  }

  /** Hang up the ptys, then drop the sessions in one go so the bridge fires once. */
  const closeSessions = (ids: string[]): void => {
    if (ids.length === 0) return
    for (const id of ids) {
      const sessionId = sessions.find((s) => s.id === id)?.sessionId
      if (sessionId) window.api.ssh.close(sessionId)
    }
    removeSessions(ids)
  }

  /*
   * Closing a tab closes everything in it. That is a bigger action than it looks
   * when the tree holds several sessions and only one of them is on screen, so
   * more than one gets a confirmation first.
   */
  const closeTabs = (targets: TabView[]): boolean => {
    const doomed = targets.flatMap((view) => view.terminalIds)
    if (doomed.length > 1 && !window.confirm(t('tabbar.closeTabConfirm', { count: doomed.length }))) {
      return false
    }
    closeSessions(doomed)
    const layout = usePaneLayoutStore.getState()
    // Sessions closing already takes any tab they emptied; this covers tabs that
    // held nothing to begin with.
    for (const view of targets) layout.closeTab(view.tab.id)
    return true
  }

  const handleClose = (e: React.MouseEvent, view: TabView): void => {
    e.stopPropagation()
    closeTabs([view])
  }

  const closeOthers = (view: TabView): void => {
    closeMenu()
    closeTabs(views.filter((other) => other.tab.id !== view.tab.id))
  }

  const closeAll = (): void => {
    closeMenu()
    closeTabs(views)
  }

  const startRename = (view: TabView): void => {
    closeMenu()
    setRenamingId(view.tab.id)
    setRenameValue(tabLabel(view, t))
  }

  const commitRename = (): void => {
    if (renamingId) renamePaneTab(renamingId, renameValue)
    setRenamingId(null)
  }

  const cancelRename = (): void => {
    setRenamingId(null)
  }

  return (
    <div className="tabbar">
      <div className="brand">
        <span className="brand-mark">A</span>
        <span className="brand-name">
          AI <b>Terminal</b>
        </span>
      </div>
      <button
        className={`toolbar-btn ${sidebarOpen ? 'active' : ''}`}
        onClick={onToggleSidebar}
        title={t('tabbar.toggleSidebar')}
      >
        <UiIcon name="connections" />
        <span>{t('tabbar.connections')}</span>
      </button>
      {views.map((view) => {
        const { tab, session, paneCount } = view
        const active = tab.id === activeTabId
        const color = session?.color
        return (
          <div
            key={tab.id}
            className={`tab ${active ? 'active' : ''} ${
              dragOverId === tab.id && dragId && dragId !== tab.id ? 'drag-over' : ''
            } ${dragId === tab.id ? 'dragging' : ''} ${color ? 'has-color' : ''}`}
            draggable={renamingId !== tab.id}
            onDragStart={(e) => {
              setDragId(tab.id)
              e.dataTransfer.effectAllowed = 'move'
              // Reordering within the bar reads `dragId`. A drop onto a pane
              // happens in another component tree, so that id has to travel on
              // the event — and it is the session's, since a pane holds one of
              // those rather than a whole tab.
              if (session) e.dataTransfer.setData(TAB_DRAG_MIME, session.id)
            }}
            onDragOver={(e) => {
              if (!dragId || dragId === tab.id) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (dragOverId !== tab.id) setDragOverId(tab.id)
            }}
            onDragLeave={() => {
              if (dragOverId === tab.id) setDragOverId(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragId && dragId !== tab.id) reorderTab(dragId, tab.id)
              setDragId(null)
              setDragOverId(null)
            }}
            onDragEnd={() => {
              setDragId(null)
              setDragOverId(null)
            }}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenu({ x: e.clientX, y: e.clientY, view })
            }}
            onDoubleClick={() => startRename(view)}
            style={color ? ({ '--tab-color': color } as React.CSSProperties) : undefined}
            title={tabHoverTitle(view, t)}
          >
            <span className={`status-dot ${session ? (session.nlMode ? 'nl' : session.status) : 'idle'}`} />
            {active && <span className="tab-underline" aria-hidden />}
            <span className="tab-label">
              <span className="tab-title" aria-hidden={renamingId === tab.id}>
                {tabLabel(view, t)}
              </span>
              {renamingId === tab.id ? (
                <input
                  className="tab-title-input"
                  value={renameValue}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitRename()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      cancelRename()
                    }
                  }}
                />
              ) : null}
            </span>
            {paneCount > 1 ? (
              <span
                className="pane-menu-count tab-pane-count"
                title={t('workspace.paneCount', { count: paneCount })}
              >
                {paneCount}
              </span>
            ) : null}
            <button
              className="close-btn"
              onClick={(e) => handleClose(e, view)}
              title={t('tabbar.closeTab')}
            >
              ×
            </button>
          </div>
        )
      })}
      <div className="tab-add-wrap">
        <button className="tab-add" onClick={onNewTab} title={t('tabbar.newTab')}>
          <UiIcon name="plus" className="tab-add-glyph" />
        </button>
        <button
          className={`tab-add-caret ${recentOpen ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            setRecentOpen((v) => !v)
          }}
          title={t('tabbar.recentConnections')}
        >
          <UiIcon name="caret-down" className="tab-add-caret-glyph" />
        </button>
        {recentOpen && (
          <div className="recent-menu" onClick={(e) => e.stopPropagation()}>
            <div className="recent-menu-title">
              <UiIcon name="clock" size="sm" className="menu-item-icon" />
              {t('tabbar.recentTitle')}
            </div>
            {connections.length === 0 || recent.length === 0 ? (
              <div className="recent-menu-empty">{t('tabbar.recentEmpty')}</div>
            ) : (
              recent.map((c) => (
                <button
                  key={c.id}
                  className="recent-menu-item"
                  onClick={() => {
                    setRecentOpen(false)
                    void connectFromConfig(c)
                  }}
                  title={`${c.username}@${c.host}:${c.port}`}
                >
                  <UiIcon name="server" className="menu-item-icon" />
                  <span className="recent-item-body">
                    <span className="recent-item-name">{c.name}</span>
                    <span className="recent-item-sub">
                      {c.username}@{c.host}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {wslDistros.length > 0 && (
        <div className="wsl-launch">
          <button
            className={`wsl-btn ${wslMenuOpen ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              handleWslClick()
            }}
            title={
              wslDistros.length === 1
                ? `${t('tabbar.openWsl')} · ${wslDistros[0].name}`
                : t('tabbar.openWsl')
            }
            aria-haspopup={wslDistros.length > 1 ? 'menu' : undefined}
            aria-expanded={wslDistros.length > 1 ? wslMenuOpen : undefined}
          >
            <UiIcon name="terminal" className="wsl-btn-icon" />
            <span className="wsl-btn-label">WSL</span>
            {wslDistros.length > 1 && (
              <UiIcon
                name="caret-down"
                className={`wsl-btn-caret ${wslMenuOpen ? 'open' : ''}`}
                size="sm"
              />
            )}
          </button>
          {wslMenuOpen && wslDistros.length > 1 && (
            <div className="recent-menu wsl-menu" role="menu" onClick={(e) => e.stopPropagation()}>
              <div className="recent-menu-title">
                <UiIcon name="terminal" size="sm" className="menu-item-icon" />
                {t('tabbar.openWsl')}
              </div>
              {wslDistros.map((d) => (
                <button
                  key={d.name}
                  className="recent-menu-item"
                  role="menuitem"
                  onClick={() => openWsl(d.name)}
                  title={d.name}
                >
                  <UiIcon name="terminal" className="menu-item-icon" />
                  <span className="recent-item-body">
                    <span className="recent-item-name">{d.name}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="tabbar-spacer" />
      <div className="tabbar-actions">
        <div className="tabbar-action-slot toolbar-menu-wrap">
          <button
            className={`toolbar-btn toolbar-menu-btn tabbar-action-btn ${settingsOpen ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              setSettingsOpen((v) => !v)
            }}
            title={t('tabbar.settings')}
          >
            <UiIcon name="settings" />
            <span>{t('tabbar.settings')}</span>
            <UiIcon name="caret-down" className={`toolbar-menu-caret ${settingsOpen ? 'open' : ''}`} size="sm" />
          </button>
          {settingsOpen && (
            <div className="toolbar-dropdown-menu" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem
                icon="themes"
                onClick={() => {
                  setSettingsOpen(false)
                  onSettingsSelect('themes')
                }}
              >
                {t('tabbar.themes')}
              </DropdownMenuItem>
              <DropdownMenuItem
                icon="terminal"
                onClick={() => {
                  setSettingsOpen(false)
                  onSettingsSelect('terminal')
                }}
              >
                {t('tabbar.terminalAppearance')}
              </DropdownMenuItem>
              <DropdownMenuItem
                icon="edit"
                onClick={() => {
                  setSettingsOpen(false)
                  onSettingsSelect('shortcuts')
                }}
              >
                {t('tabbar.shortcuts')}
              </DropdownMenuItem>
              <DropdownMenuItem
                icon="language"
                onClick={() => {
                  setSettingsOpen(false)
                  onSettingsSelect('language')
                }}
              >
                {t('tabbar.language')}
              </DropdownMenuItem>
              <DropdownMenuItem
                icon="settings"
                onClick={() => {
                  setSettingsOpen(false)
                  onSettingsSelect('startup')
                }}
              >
                {t('tabbar.startup')}
              </DropdownMenuItem>
              <DropdownMenuItem
                icon="ai"
                onClick={() => {
                  setSettingsOpen(false)
                  onSettingsSelect('ai')
                }}
              >
                {t('tabbar.aiSettings')}
              </DropdownMenuItem>
              <DropdownMenuItem
                icon="skills"
                onClick={() => {
                  setSettingsOpen(false)
                  onSettingsSelect('skills')
                }}
              >
                {t('tabbar.skills')}
              </DropdownMenuItem>
              <DropdownMenuItem
                icon="edit"
                onClick={() => {
                  setSettingsOpen(false)
                  onSettingsSelect('userRules')
                }}
              >
                {t('tabbar.userRules')}
              </DropdownMenuItem>
              <div className="toolbar-dropdown-divider" role="separator" />
              <DropdownMenuItem
                icon="about"
                onClick={() => {
                  setSettingsOpen(false)
                  onSettingsSelect('about')
                }}
              >
                {t('tabbar.about')}
              </DropdownMenuItem>
            </div>
          )}
        </div>
        <div className="tabbar-action-slot">
          <button
            className={`toolbar-btn tabbar-action-btn ${panelOpen ? 'active' : ''}`}
            onClick={togglePanel}
            title={t('tabbar.toggleAi')}
          >
            <UiIcon name="copilot" />
            <span>{t('tabbar.aiCopilot')}</span>
          </button>
        </div>
        <div className="tabbar-action-slot">
          <button
            className={`toolbar-btn tabbar-action-btn ${sftpOpen ? 'active' : ''}`}
            onClick={toggleSftp}
            disabled={activeIsWsl}
            title={activeIsWsl ? t('tabbar.sftpWslUnsupported') : t('tabbar.toggleSftp')}
          >
            <UiIcon name="sftp" />
            <span>{t('tabbar.sftp')}</span>
          </button>
        </div>
      </div>
      {menu && (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          view={menu.view}
          tabCount={views.length}
          onClose={closeMenu}
          onRename={startRename}
          onSaveOutput={saveTabOutput}
          onCloseTab={(target) => closeTabs([target])}
          onCloseOthers={closeOthers}
          onCloseAll={closeAll}
        />
      )}
    </div>
  )
}
