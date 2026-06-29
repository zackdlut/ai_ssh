import { useEffect, useState } from 'react'
import { useTabsStore, type TerminalTab } from '../store/tabsStore'
import { useAIStore } from '../store/aiStore'
import { useSftpStore } from '../store/sftpStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import { cloneTab, connectFromConfig, reconnectTab } from '../lib/connect'
import { readFullTerminalOutput } from '../lib/terminalRegistry'
import { useT } from '../lib/i18n'
import UiIcon from './UiIcon'
import DropdownMenuItem from './DropdownMenuItem'
import ContextMenuItem from './ContextMenuItem'

export type SettingsMenuItem = 'ai' | 'themes' | 'terminal' | 'language' | 'about'

interface TabContextMenu {
  x: number
  y: number
  tab: TerminalTab
}

function defaultLogName(tab: TerminalTab): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${tab.username}@${tab.host}-${stamp}.log`
}

interface Props {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onNewConnection: () => void
  onSettingsSelect: (item: SettingsMenuItem) => void
}

export default function TabBar({
  sidebarOpen,
  onToggleSidebar,
  onNewConnection,
  onSettingsSelect
}: Props): JSX.Element {
  const { tabs, activeTabId, setActive, removeTab } = useTabsStore()
  const { panelOpen, togglePanel } = useAIStore()
  const sftpOpen = useSftpStore((s) => s.panelOpen)
  const toggleSftp = useSftpStore((s) => s.togglePanel)
  // Subscribe to connections so the recent list refreshes as usage changes.
  const connections = useBookmarksStore((s) => s.connections)
  const getRecentConnections = useBookmarksStore((s) => s.getRecentConnections)
  const t = useT()
  const [recentOpen, setRecentOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [menu, setMenu] = useState<TabContextMenu | null>(null)

  const recent = recentOpen ? getRecentConnections(5) : []

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

  const handleClose = (e: React.MouseEvent, id: string, sessionId: string): void => {
    e.stopPropagation()
    window.api.ssh.close(sessionId)
    removeTab(id)
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
          className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
          onClick={() => setActive(tab.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, tab })
          }}
          onDoubleClick={() => {
            setActive(tab.id)
            if (tab.status === 'closed' || tab.status === 'error') {
              void reconnectTab(tab.id)
            } else if (tab.status === 'connected') {
              void cloneTab(tab.id)
            }
          }}
          title={t('tabbar.tabTitle', {
            user: tab.username,
            host: tab.host,
            nlMode: tab.nlMode ? t('tabbar.nlMode') : '',
            action:
              tab.status === 'closed' || tab.status === 'error'
                ? t('tabbar.doubleClickReconnect')
                : t('tabbar.doubleClickClone')
          })}
        >
          <span className={`status-dot ${tab.nlMode ? 'nl' : tab.status}`} />
          <span className="tab-title">{tab.title}</span>
          <button
            className="close-btn"
            onClick={(e) => handleClose(e, tab.id, tab.sessionId)}
            title={t('tabbar.closeTab')}
          >
            ×
          </button>
        </div>
      ))}
      <div className="tab-add-wrap">
        <button className="tab-add" onClick={onNewConnection} title={t('tabbar.newConnection')}>
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
                icon="language"
                onClick={() => {
                  setSettingsOpen(false)
                  onSettingsSelect('language')
                }}
              >
                {t('tabbar.language')}
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
            title={t('tabbar.toggleSftp')}
          >
            <UiIcon name="sftp" />
            <span>{t('tabbar.sftp')}</span>
          </button>
        </div>
      </div>
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <ContextMenuItem icon="save" onClick={() => void saveTabOutput(menu.tab)}>
            {t('tabbar.saveOutput')}
          </ContextMenuItem>
        </div>
      )}
    </div>
  )
}
