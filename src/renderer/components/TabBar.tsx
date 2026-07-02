import { useEffect, useState } from 'react'
import { useTabsStore, type TerminalTab } from '../store/tabsStore'
import { useAIStore } from '../store/aiStore'
import { useSftpStore } from '../store/sftpStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import { cloneTab, connectFromConfig, connectWsl, reconnectTab } from '../lib/connect'
import { readFullTerminalOutput } from '../lib/terminalRegistry'
import { useT } from '../lib/i18n'
import UiIcon from './UiIcon'
import DropdownMenuItem from './DropdownMenuItem'
import ContextMenuItem from './ContextMenuItem'
import type { WslDistro } from '../../shared/types'

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

interface TabContextMenu {
  x: number
  y: number
  tab: TerminalTab
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

function defaultLogName(tab: TerminalTab): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${tab.username}@${tab.host}-${stamp}.log`
}

function tabLabel(tab: TerminalTab): string {
  return tab.customTitle ?? tab.title
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
  const { tabs, activeTabId, setActive, removeTab, removeTabs, renameTab, setTabColor, reorderTab } =
    useTabsStore()
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
  const [menu, setMenu] = useState<TabContextMenu | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const recent = recentOpen ? getRecentConnections(5) : []
  const activeIsWsl = tabs.find((tt) => tt.id === activeTabId)?.kind === 'wsl'

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

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('wheel', close)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const saveTabOutput = async (tab: TerminalTab): Promise<void> => {
    setMenu(null)
    const content = readFullTerminalOutput(tab.id).trim()
    if (!content) {
      window.alert(t('tabbar.saveOutputEmpty'))
      return
    }
    const res = await window.api.terminal.saveLog(content, defaultLogName(tab))
    if (res.error) window.alert(t('tabbar.saveOutputFailed', { error: res.error }))
  }

  const closeTab = (tab: TerminalTab): void => {
    if (tab.sessionId) window.api.ssh.close(tab.sessionId)
    removeTab(tab.id)
  }

  const handleClose = (e: React.MouseEvent, tab: TerminalTab): void => {
    e.stopPropagation()
    closeTab(tab)
  }

  const closeOthers = (tab: TerminalTab): void => {
    setMenu(null)
    const others = tabs.filter((tt) => tt.id !== tab.id)
    others.forEach((tt) => {
      if (tt.sessionId) window.api.ssh.close(tt.sessionId)
    })
    removeTabs(others.map((tt) => tt.id))
  }

  const closeAll = (): void => {
    setMenu(null)
    tabs.forEach((tt) => {
      if (tt.sessionId) window.api.ssh.close(tt.sessionId)
    })
    removeTabs(tabs.map((tt) => tt.id))
  }

  const startRename = (tab: TerminalTab): void => {
    setMenu(null)
    setRenamingId(tab.id)
    setRenameValue(tabLabel(tab))
  }

  const commitRename = (): void => {
    if (renamingId) renameTab(renamingId, renameValue)
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
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${tab.id === activeTabId ? 'active' : ''} ${
            dragOverId === tab.id && dragId && dragId !== tab.id ? 'drag-over' : ''
          } ${dragId === tab.id ? 'dragging' : ''} ${tab.color ? 'has-color' : ''}`}
          draggable={renamingId !== tab.id}
          onDragStart={(e) => {
            setDragId(tab.id)
            e.dataTransfer.effectAllowed = 'move'
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
          onClick={() => setActive(tab.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, tab })
          }}
          onDoubleClick={() => startRename(tab)}
          style={tab.color ? ({ '--tab-color': tab.color } as React.CSSProperties) : undefined}
          title={
            tab.status === 'idle'
              ? tabLabel(tab)
              : t('tabbar.tabTitle', {
                  user: tab.username,
                  host: tab.host,
                  nlMode: tab.nlMode ? t('tabbar.nlMode') : '',
                  action: t('tabbar.doubleClickRename')
                })
          }
        >
          <span className={`status-dot ${tab.nlMode ? 'nl' : tab.status}`} />
          {tab.id === activeTabId && <span className="tab-underline" aria-hidden />}
          <span className="tab-label">
            <span
              className="tab-title"
              aria-hidden={renamingId === tab.id}
            >
              {tabLabel(tab)}
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
          <button
            className="close-btn"
            onClick={(e) => handleClose(e, tab)}
            title={t('tabbar.closeTab')}
          >
            ×
          </button>
        </div>
      ))}
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
        <div className="tab-add-wrap wsl-launch-wrap">
          <button
            className={`toolbar-btn tab-wsl-btn ${wslMenuOpen ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              handleWslClick()
            }}
            title={t('tabbar.openWsl')}
          >
            <UiIcon name="terminal" />
            <span>WSL</span>
            {wslDistros.length > 1 && (
              <UiIcon
                name="caret-down"
                className={`tab-add-caret-glyph ${wslMenuOpen ? 'open' : ''}`}
                size="sm"
              />
            )}
          </button>
          {wslMenuOpen && wslDistros.length > 1 && (
            <div className="recent-menu" onClick={(e) => e.stopPropagation()}>
              <div className="recent-menu-title">
                <UiIcon name="terminal" size="sm" className="menu-item-icon" />
                {t('tabbar.openWsl')}
              </div>
              {wslDistros.map((d) => (
                <button
                  key={d.name}
                  className="recent-menu-item"
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
                icon="copilot"
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
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {(menu.tab.status === 'closed' || menu.tab.status === 'error') && (
            <>
              <ContextMenuItem
                icon="connect"
                onClick={() => {
                  const tab = menu.tab
                  setMenu(null)
                  setActive(tab.id)
                  void reconnectTab(tab.id)
                }}
              >
                {t('tabbar.reconnect')}
              </ContextMenuItem>
              <div className="context-menu-divider" role="separator" />
            </>
          )}
          <ContextMenuItem icon="rename" onClick={() => startRename(menu.tab)}>
            {t('tabbar.rename')}
          </ContextMenuItem>
          <div className="context-menu-colors" onClick={(e) => e.stopPropagation()}>
            <span className="context-menu-colors-label">{t('tabbar.setColor')}</span>
            <div className="context-menu-swatches">
              {TAB_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-swatch ${menu.tab.color === c ? 'active' : ''}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => {
                    setTabColor(menu.tab.id, c)
                    setMenu(null)
                  }}
                />
              ))}
              <button
                type="button"
                className={`color-swatch color-swatch-none ${!menu.tab.color ? 'active' : ''}`}
                title={t('tabbar.colorNone')}
                onClick={() => {
                  setTabColor(menu.tab.id, undefined)
                  setMenu(null)
                }}
              />
            </div>
          </div>
          <div className="context-menu-divider" role="separator" />
          <ContextMenuItem
            icon="copy"
            disabled={menu.tab.status !== 'connected'}
            onClick={() => {
              const tab = menu.tab
              setMenu(null)
              void cloneTab(tab.id)
            }}
          >
            {t('tabbar.duplicate')}
          </ContextMenuItem>
          <ContextMenuItem icon="save" onClick={() => void saveTabOutput(menu.tab)}>
            {t('tabbar.saveOutput')}
          </ContextMenuItem>
          <div className="context-menu-divider" role="separator" />
          <ContextMenuItem
            icon="delete"
            onClick={() => {
              const tab = menu.tab
              setMenu(null)
              closeTab(tab)
            }}
          >
            {t('tabbar.closeTab')}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={tabs.length <= 1}
            onClick={() => closeOthers(menu.tab)}
          >
            {t('tabbar.closeOthers')}
          </ContextMenuItem>
          <ContextMenuItem onClick={closeAll}>{t('tabbar.closeAll')}</ContextMenuItem>
        </div>
      )}
    </div>
  )
}
