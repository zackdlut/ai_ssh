import { useEffect, useRef, useState } from 'react'
import { MIN_SYNC_GROUP, usePaneSyncStore } from '../../store/paneSyncStore'
import { useT } from '../../lib/i18n'
import UiIcon from '../UiIcon'
import DropdownMenuItem from '../DropdownMenuItem'

/**
 * The sync group on the status bar: what it is doing, and the things you do to
 * it.
 *
 * Locking panes is what forms the group, so the pill reports rather than
 * switches. Broadcasting sits beside it as its own indicator, because a live
 * group typing into every session is something you should never have to open a
 * menu to see or stop. The whole cluster stays out of the bar while nothing is
 * locked.
 */
export default function SyncGroupStatus(): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const lockedCount = usePaneSyncStore((s) => s.lockedTerminalIds.length)
  const syncInput = usePaneSyncStore((s) => s.syncInput)
  const realignScroll = usePaneSyncStore((s) => s.realignScroll)
  const setSyncInput = usePaneSyncStore((s) => s.setSyncInput)
  const clearLocks = usePaneSyncStore((s) => s.clearLocks)

  const groupReady = lockedCount >= MIN_SYNC_GROUP

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  // Nothing locked: the group does not exist, so neither does this.
  if (lockedCount === 0) return null

  const run = (fn: () => void): void => {
    setOpen(false)
    fn()
  }

  return (
    <div className="sync-bar" role="group" aria-label={t('sync.title')} ref={wrapRef}>
      <button
        type="button"
        className={`sync-seg sync-seg--lock ${groupReady ? 'is-on' : ''} ${open ? 'is-open' : ''}`}
        // The dot carries whether the group is live, so the label is free to be
        // just the count. What that state means goes here.
        title={groupReady ? t('sync.groupOn', { count: lockedCount }) : t('sync.needTwo')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sync-seg-dot" aria-hidden />
        <span>{t('status.locked', { count: lockedCount })}</span>
        <UiIcon name="caret-down" size="sm" className={`sync-seg-caret ${open ? 'open' : ''}`} />
      </button>
      {groupReady && (
        <button
          type="button"
          className={`sync-seg ${syncInput ? 'is-armed' : ''}`}
          title={t('sync.inputHint')}
          aria-pressed={syncInput}
          onClick={() => setSyncInput(!syncInput)}
        >
          {t('sync.input')}
        </button>
      )}
      {open && (
        // The status bar is a live region; opening a menu inside it should not
        // be read out as a status change.
        <div className="sync-pop" role="menu" aria-live="off">
          {groupReady && (
            <DropdownMenuItem
              icon="lock"
              title={t('sync.realignHint')}
              onClick={() => run(realignScroll)}
            >
              {t('sync.realign')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem icon="delete" onClick={() => run(clearLocks)}>
            {t('sync.clear')}
          </DropdownMenuItem>
        </div>
      )}
    </div>
  )
}
