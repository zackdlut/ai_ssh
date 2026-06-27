import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../../lib/i18n'
import { getContextMenuPosition } from '../../lib/contextMenuPosition'
import { SHORTCUT_COPY, SHORTCUT_CUT, SHORTCUT_PASTE } from '../../lib/shortcuts'
import ContextMenuItem from '../ContextMenuItem'
import UiIcon from '../UiIcon'

export interface SftpPathFieldProps {
  cwd: string
  disabled?: boolean
  onNavigate: (path: string) => void
  onBrowse?: () => void
}

type PathMenu = {
  anchorX: number
  anchorY: number
  selectionStart: number
  selectionEnd: number
}

function isClipboardShortcut(e: React.KeyboardEvent<HTMLInputElement>): boolean {
  if (!e.ctrlKey && !e.metaKey) return false
  const key = e.key.toLowerCase()
  return key === 'c' || key === 'v' || key === 'x' || key === 'a'
}

export default function SftpPathField({
  cwd,
  disabled = false,
  onNavigate,
  onBrowse
}: SftpPathFieldProps): JSX.Element {
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pathInput, setPathInput] = useState(cwd)
  const [menu, setMenu] = useState<PathMenu | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    setPathInput(cwd)
  }, [cwd])

  useEffect(() => {
    if (!menu) return
    const close = (): void => {
      setMenu(null)
      setMenuPos(null)
    }
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

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      setMenuPos(null)
      return
    }
    const rect = menuRef.current.getBoundingClientRect()
    setMenuPos(getContextMenuPosition(menu.anchorX, menu.anchorY, rect.width, rect.height))
  }, [menu])

  const submitPath = (): void => {
    const path = pathInput.trim()
    if (!path) return
    onNavigate(path)
  }

  const onPathKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (isClipboardShortcut(e)) {
      e.stopPropagation()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      submitPath()
    } else if (e.key === 'Escape') {
      setPathInput(cwd)
      e.currentTarget.blur()
    }
  }

  const onContextMenu = (e: React.MouseEvent<HTMLInputElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    if (disabled) return
    const el = e.currentTarget
    setMenu({
      anchorX: e.clientX,
      anchorY: e.clientY,
      selectionStart: el.selectionStart ?? 0,
      selectionEnd: el.selectionEnd ?? 0
    })
    setMenuPos(null)
  }

  const copySelection = (): void => {
    if (!menu) return
    const text = pathInput.slice(menu.selectionStart, menu.selectionEnd)
    if (text) void navigator.clipboard.writeText(text)
    setMenu(null)
  }

  const cutSelection = (): void => {
    if (!menu) return
    const { selectionStart: start, selectionEnd: end } = menu
    if (start === end) return
    const text = pathInput.slice(start, end)
    void navigator.clipboard.writeText(text)
    const next = pathInput.slice(0, start) + pathInput.slice(end)
    setPathInput(next)
    requestAnimationFrame(() => {
      const el = inputRef.current
      el?.focus()
      el?.setSelectionRange(start, start)
    })
    setMenu(null)
  }

  const pasteToInput = (): void => {
    if (!menu) return
    const { selectionStart: start, selectionEnd: end } = menu
    void navigator.clipboard.readText().then((clip) => {
      if (!clip) return
      const next = pathInput.slice(0, start) + clip + pathInput.slice(end)
      const pos = start + clip.length
      setPathInput(next)
      requestAnimationFrame(() => {
        const el = inputRef.current
        el?.focus()
        el?.setSelectionRange(pos, pos)
      })
    })
    setMenu(null)
  }

  return (
    <>
      <div className="sftp-path">
        <input
          ref={inputRef}
          className="sftp-path-input"
          type="text"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={onPathKeyDown}
          onBlur={() => setPathInput(cwd)}
          onContextMenu={onContextMenu}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          aria-label={t('sftp.path')}
          placeholder="/"
        />
      </div>
      {onBrowse && (
        <button
          type="button"
          className="sftp-btn-icon"
          onClick={onBrowse}
          disabled={disabled}
          title={t('sftp.browse')}
          aria-label={t('sftp.browse')}
        >
          <UiIcon name="browse" />
        </button>
      )}

      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{
            left: menuPos?.x ?? menu.anchorX,
            top: menuPos?.y ?? menu.anchorY,
            visibility: menuPos ? 'visible' : 'hidden'
          }}
        >
          <ContextMenuItem
            shortcut={SHORTCUT_COPY}
            icon="copy"
            onClick={copySelection}
            disabled={menu.selectionStart === menu.selectionEnd}
          >
            {t('common.copy')}
          </ContextMenuItem>
          <ContextMenuItem
            shortcut={SHORTCUT_CUT}
            icon="cut"
            onClick={cutSelection}
            disabled={menu.selectionStart === menu.selectionEnd}
          >
            {t('common.cut')}
          </ContextMenuItem>
          <ContextMenuItem shortcut={SHORTCUT_PASTE} icon="paste" onClick={pasteToInput}>
            {t('common.paste')}
          </ContextMenuItem>
        </div>
      )}
    </>
  )
}
