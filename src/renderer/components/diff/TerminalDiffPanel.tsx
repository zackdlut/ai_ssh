import { useEffect, useMemo, useRef } from 'react'
import { computeTextDiff, type DiffLine } from '../../../shared/textDiff'
import { normalizeForDiff, toSideBySideRows } from '../../../shared/diffRows'
import { usePaneDiffStore } from '../../store/paneDiffStore'
import {
  DIFF_RECENT_LINES,
  describeSource,
  parseSourceKey,
  readSource,
  sameSource,
  sourceKey,
  type DiffRange,
  type DiffSource
} from '../../lib/diffSource'
import { useSessionsStore, type TerminalSession } from '../../store/sessionsStore'
import { selectActiveTab, usePaneLayoutStore } from '../../store/paneLayoutStore'
import { usePaneSnapshotStore } from '../../store/paneSnapshotStore'
import { collectLeaves } from '../../lib/paneLayout'
import { formatTerminalLabel } from '../../lib/pinnedTerminal'
import { askAboutDiff } from '../../lib/aiService'
import { useT } from '../../lib/i18n'
import UiIcon from '../UiIcon'

interface SourceOption {
  key: string
  label: string
  source: DiffSource
}

interface SourceGroup {
  label: string
  options: SourceOption[]
}

/** Rebuild a unified-diff text so Copilot receives something it can read. */
function toUnifiedText(hunks: ReturnType<typeof toSideBySideRows>): string {
  const out: string[] = []
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart} +${hunk.newStart} @@`)
    for (const row of hunk.rows) {
      if (row.left && row.right && row.left.op === 'context') out.push(` ${row.left.text}`)
      else {
        if (row.left) out.push(`-${row.left.text}`)
        if (row.right) out.push(`+${row.right.text}`)
      }
    }
  }
  return out.join('\n')
}

export default function TerminalDiffPanel(): JSX.Element {
  const t = useT()
  const tabs = useSessionsStore((s) => s.sessions)
  const paneRoot = usePaneLayoutStore((s) => selectActiveTab(s).root)
  const snapshots = usePaneSnapshotStore((s) => s.snapshots)
  const removeSnapshot = usePaneSnapshotStore((s) => s.remove)

  const left = usePaneDiffStore((s) => s.left)
  const right = usePaneDiffStore((s) => s.right)
  const range = usePaneDiffStore((s) => s.range)
  const normalize = usePaneDiffStore((s) => s.normalize)
  const onlyChanges = usePaneDiffStore((s) => s.onlyChanges)
  const reloadToken = usePaneDiffStore((s) => s.reloadToken)
  const close = usePaneDiffStore((s) => s.close)
  const setSide = usePaneDiffStore((s) => s.setSide)
  const swap = usePaneDiffStore((s) => s.swap)
  const setRange = usePaneDiffStore((s) => s.setRange)
  const setNormalize = usePaneDiffStore((s) => s.setNormalize)
  const setOnlyChanges = usePaneDiffStore((s) => s.setOnlyChanges)
  const reload = usePaneDiffStore((s) => s.reload)
  const pruneMissing = usePaneDiffStore((s) => s.pruneMissing)

  const leftScrollRef = useRef<HTMLDivElement>(null)
  const rightScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [close])

  // A snapshot can be dropped while the panel is closed; clear the dangling side
  // rather than rendering an empty column.
  useEffect(() => {
    pruneMissing()
  }, [pruneMissing, snapshots])

  /*
   * Offered in the pickers: the panes on screen, then sessions living in other
   * tabs, then snapshots.
   *
   * Sessions in other tabs stay on the list because a diff reads a scrollback
   * buffer, which needs no pane; they are grouped apart so that "left vs right"
   * still means the two panes in front of the user.
   */
  const groups = useMemo<SourceGroup[]>(() => {
    const onScreen = collectLeaves(paneRoot)
      .map((leaf) => leaf.terminalId)
      .filter((id): id is string => Boolean(id))
    const byId = new Map(tabs.map((tab) => [tab.id, tab]))
    const option = (tab: TerminalSession): SourceOption => ({
      key: sourceKey({ kind: 'terminal', terminalId: tab.id }),
      label: formatTerminalLabel(tab),
      source: { kind: 'terminal', terminalId: tab.id } as DiffSource
    })

    const out: SourceGroup[] = [
      {
        label: t('diff.groupPanes'),
        options: onScreen
          .map((id) => byId.get(id))
          .filter((tab): tab is TerminalSession => Boolean(tab))
          .map(option)
      }
    ]

    const elsewhere = tabs.filter(
      (tab) => tab.status === 'connected' && !onScreen.includes(tab.id)
    )
    if (elsewhere.length > 0) {
      out.push({ label: t('diff.groupOtherTabs'), options: elsewhere.map(option) })
    }

    if (snapshots.length > 0) {
      out.push({
        label: t('diff.groupSnapshots'),
        options: snapshots.map((snap) => ({
          key: sourceKey({ kind: 'snapshot', snapshotId: snap.id }),
          label: snap.label,
          source: { kind: 'snapshot', snapshotId: snap.id } as DiffSource
        }))
      })
    }

    return out
  }, [tabs, paneRoot, snapshots, t])

  const raw = useMemo(
    () => ({ left: readSource(left, range), right: readSource(right, range) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadToken forces a re-read of the live buffers
    [left, right, range, reloadToken]
  )

  const normalized = useMemo(
    () => ({
      left: normalizeForDiff(raw.left, normalize),
      right: normalizeForDiff(raw.right, normalize)
    }),
    [raw, normalize]
  )

  const diff = useMemo(
    () => computeTextDiff(normalized.left, normalized.right),
    [normalized]
  )

  const hunks = useMemo(() => toSideBySideRows(diff), [diff])

  const samePane = sameSource(left, right)
  const missing = !left || !right
  const identical = !missing && !samePane && !diff.skipped && hunks.length === 0

  const label = (source: DiffSource | null): string => describeSource(source, t('diff.noSelection'))

  // Snapshots are only reachable through this panel, so this is where they get
  // cleaned up rather than accumulating invisibly.
  const snapshotSides = (
    [
      { side: 'left' as const, source: left },
      { side: 'right' as const, source: right }
    ] satisfies { side: 'left' | 'right'; source: DiffSource | null }[]
  ).flatMap(({ side, source }) =>
    source?.kind === 'snapshot' ? [{ side, snapshotId: source.snapshotId }] : []
  )

  return (
    <div className="diff-panel" role="dialog" aria-label={t('diff.title')}>
      <div className="diff-panel-header">
        <span className="diff-panel-title">
          <UiIcon name="diff" size="sm" />
          {t('diff.title')}
        </span>
        {!missing && !diff.skipped && (
          <span className="diff-panel-stat">
            {t('diff.stat', { added: diff.added, removed: diff.removed })}
          </span>
        )}
        <span className="diff-panel-spacer" />
        <button type="button" className="diff-panel-btn" onClick={reload}>
          {t('diff.refresh')}
        </button>
        <button type="button" className="diff-panel-btn" onClick={swap}>
          {t('diff.swap')}
        </button>
        <button
          type="button"
          className="diff-panel-btn"
          disabled={diff.skipped || hunks.length === 0}
          onClick={() => askAboutDiff(toUnifiedText(hunks), label(left), label(right))}
        >
          {t('diff.explain')}
        </button>
        <button
          type="button"
          className="diff-panel-btn diff-panel-close"
          onClick={close}
          title={t('common.close')}
        >
          ×
        </button>
      </div>

      <div className="diff-panel-controls">
        <SidePicker
          side="left"
          value={left}
          groups={groups}
          label={t('diff.left')}
          onChange={(source) => setSide('left', source)}
        />
        <SidePicker
          side="right"
          value={right}
          groups={groups}
          label={t('diff.right')}
          onChange={(source) => setSide('right', source)}
        />

        {snapshotSides.length > 0 && (
          <div className="diff-control diff-control--snapshots">
            <span className="diff-control-label">{t('diff.groupSnapshots')}</span>
            {snapshotSides.map(({ side, snapshotId }) => (
              <button
                key={side}
                type="button"
                className="diff-snapshot-del"
                title={t('snapshot.delete')}
                onClick={() => {
                  setSide(side, null)
                  removeSnapshot(snapshotId)
                }}
              >
                {side === 'left' ? t('diff.left') : t('diff.right')} ×
              </button>
            ))}
            <span className="diff-control-hint">{t('snapshot.memoryNote')}</span>
          </div>
        )}

        <label className="diff-control">
          <span className="diff-control-label">{t('diff.range')}</span>
          <select value={range} onChange={(e) => setRange(e.target.value as DiffRange)}>
            <option value="viewport">{t('diff.rangeViewport')}</option>
            <option value="recent">{t('diff.rangeRecent', { count: DIFF_RECENT_LINES })}</option>
            <option value="all">{t('diff.rangeAll')}</option>
          </select>
        </label>

        <div className="diff-control diff-control--checks">
          <span className="diff-control-label">{t('diff.normalize')}</span>
          <label>
            <input
              type="checkbox"
              checked={normalize.trimTrailing}
              onChange={(e) => setNormalize({ trimTrailing: e.target.checked })}
            />
            {t('diff.trimTrailing')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={normalize.collapseSpaces}
              onChange={(e) => setNormalize({ collapseSpaces: e.target.checked })}
            />
            {t('diff.collapseSpaces')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={normalize.maskVolatile}
              onChange={(e) => setNormalize({ maskVolatile: e.target.checked })}
            />
            {t('diff.maskVolatile')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={onlyChanges}
              onChange={(e) => setOnlyChanges(e.target.checked)}
            />
            {t('diff.onlyChanges')}
          </label>
        </div>
      </div>

      <div className="diff-panel-body">
        {missing ? (
          <div className="diff-panel-note">{t('diff.empty')}</div>
        ) : samePane ? (
          <div className="diff-panel-note">{t('diff.samePane')}</div>
        ) : diff.skipped ? (
          <div className="diff-panel-note diff-panel-note--warn">{t('diff.skipped')}</div>
        ) : identical ? (
          <div className="diff-panel-note">{t('diff.identical')}</div>
        ) : (
          <div className="diff-columns">
            <DiffColumn
              scrollRef={leftScrollRef}
              peerRef={rightScrollRef}
              heading={label(left)}
              hunks={hunks}
              side="left"
              onlyChanges={onlyChanges}
            />
            <DiffColumn
              scrollRef={rightScrollRef}
              peerRef={leftScrollRef}
              heading={label(right)}
              hunks={hunks}
              side="right"
              onlyChanges={onlyChanges}
            />
          </div>
        )}
      </div>
    </div>
  )
}

interface SidePickerProps {
  side: 'left' | 'right'
  value: DiffSource | null
  groups: SourceGroup[]
  label: string
  onChange: (source: DiffSource | null) => void
}

function SidePicker({ side, value, groups, label, onChange }: SidePickerProps): JSX.Element {
  return (
    <label className={`diff-control diff-control--${side}`}>
      <span className="diff-control-label">{label}</span>
      <select
        value={sourceKey(value)}
        onChange={(e) => onChange(parseSourceKey(e.target.value))}
      >
        <option value="" />
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

interface DiffColumnProps {
  scrollRef: React.RefObject<HTMLDivElement>
  peerRef: React.RefObject<HTMLDivElement>
  heading: string
  hunks: ReturnType<typeof toSideBySideRows>
  side: 'left' | 'right'
  onlyChanges: boolean
}

function lineClass(line: DiffLine | undefined, side: 'left' | 'right'): string {
  if (!line) return 'diff-line diff-line--filler'
  if (line.op === 'context') return 'diff-line diff-line--context'
  return `diff-line diff-line--${side === 'left' ? 'remove' : 'add'}`
}

function DiffColumn({
  scrollRef,
  peerRef,
  heading,
  hunks,
  side,
  onlyChanges
}: DiffColumnProps): JSX.Element {
  // Both columns render the same row list, so mirroring scrollTop keeps the
  // two sides on the same row without any per-row measurement.
  const onScroll = (): void => {
    const self = scrollRef.current
    const peer = peerRef.current
    if (!self || !peer || peer.scrollTop === self.scrollTop) return
    peer.scrollTop = self.scrollTop
  }

  return (
    <div className="diff-column">
      <div className="diff-column-heading" title={heading}>
        {heading}
      </div>
      <div className="diff-column-body" ref={scrollRef} onScroll={onScroll}>
        {hunks.map((hunk, hunkIndex) => (
          <div className="diff-hunk" key={`${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`}>
            {!onlyChanges && (
              <div className="diff-hunk-heading">
                @@ {side === 'left' ? `-${hunk.oldStart}` : `+${hunk.newStart}`} @@
              </div>
            )}
            {hunk.rows
              .filter((row) => !onlyChanges || row.left?.op !== 'context')
              .map((row, rowIndex) => {
                const line = side === 'left' ? row.left : row.right
                return (
                  <div className={lineClass(line, side)} key={rowIndex}>
                    <span className="diff-line-no">
                      {(side === 'left' ? line?.oldLine : line?.newLine) ?? ''}
                    </span>
                    <span className="diff-line-text">{line?.text ?? ''}</span>
                  </div>
                )
              })}
          </div>
        ))}
      </div>
    </div>
  )
}
