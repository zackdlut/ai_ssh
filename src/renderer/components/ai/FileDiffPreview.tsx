import { useEffect, useState } from 'react'
import { useSessionsStore } from '../../store/sessionsStore'
import { useT } from '../../lib/i18n'
import { computeTextDiff, type TextDiff } from '../../../shared/textDiff'
import { applyUniqueEdit } from '../../../shared/textEdit'

interface Props {
  /** Terminal tab the edit targets (the tool's tab_id argument). */
  tabId: string
  path: string
  /** edit_file: the exact text being replaced. */
  oldString?: string
  /** edit_file: the replacement text. */
  newString?: string
  replaceAll?: boolean
  /** write_file: the full proposed contents. */
  content?: string
}

/** Cap matching the read limit the tools themselves enforce. */
const PREVIEW_MAX_BYTES = 512 * 1024

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'created' }
  | { kind: 'diff'; diff: TextDiff }

/**
 * Show what a pending `edit_file` / `write_file` will actually do, by reading
 * the current remote file and diffing it against the proposed result.
 *
 * A write the user cannot inspect is a write they will never let run
 * unattended, so this is what makes the higher autonomy modes usable: the
 * approval card answers "what exactly changes" instead of showing an opaque
 * blob of arguments.
 */
export default function FileDiffPreview({
  tabId,
  path,
  oldString,
  newString,
  replaceAll,
  content
}: Props): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const t = useT()

  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      const tab = useSessionsStore.getState().sessions.find((tt) => tt.id === tabId)
      if (!tab?.sessionId || tab.kind === 'wsl') {
        if (!cancelled) setState({ kind: 'error', message: t('tool.diff.unavailable') })
        return
      }

      const res = await window.api.sftp.readText(tab.sessionId, path, {
        maxBytes: PREVIEW_MAX_BYTES
      })
      if (cancelled) return

      // A missing file is the normal case for write_file creating something new.
      if (res.error || !res.read) {
        if (content !== undefined) setState({ kind: 'created' })
        else setState({ kind: 'error', message: res.error ?? t('tool.diff.unavailable') })
        return
      }
      if (res.read.truncated) {
        setState({ kind: 'error', message: t('tool.diff.tooLarge') })
        return
      }

      const current = res.read.text
      if (content !== undefined) {
        setState({ kind: 'diff', diff: computeTextDiff(current, content) })
        return
      }
      if (oldString === undefined || newString === undefined) {
        setState({ kind: 'error', message: t('tool.diff.unavailable') })
        return
      }

      // The preview runs the SAME matcher the tool will, so what the card shows
      // is what approving it does — including refusing an ambiguous match.
      const edit = applyUniqueEdit(current, oldString, newString, replaceAll === true)
      if (!edit.ok) {
        const message =
          edit.reason === 'ambiguous'
            ? t('tool.diff.ambiguous', { count: edit.occurrences })
            : edit.reason === 'not_found'
              ? t('tool.diff.noMatch')
              : t('tool.diff.unavailable')
        setState({ kind: 'error', message })
        return
      }
      setState({ kind: 'diff', diff: computeTextDiff(current, edit.text) })
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [tabId, path, oldString, newString, replaceAll, content, t])

  if (state.kind === 'loading') {
    return <div className="tool-diff tool-diff--note">{t('tool.diff.loading')}</div>
  }
  if (state.kind === 'error') {
    return <div className="tool-diff tool-diff--note">{state.message}</div>
  }
  if (state.kind === 'created') {
    const lines = (content ?? '').split('\n')
    return (
      <div className="tool-diff">
        <div className="tool-diff-stat">
          <span className="tool-diff-new">{t('tool.diff.newFile')}</span>
          <span className="tool-diff-add">+{lines.length}</span>
        </div>
        <pre className="tool-diff-body">
          {lines.slice(0, 60).map((line, i) => (
            <div className="tool-diff-line tool-diff-line--add" key={i}>
              <span className="tool-diff-sign">+</span>
              {line}
            </div>
          ))}
        </pre>
      </div>
    )
  }

  const { diff } = state
  if (diff.skipped) {
    return (
      <div className="tool-diff tool-diff--note">
        {t('tool.diff.tooLarge')} (+{diff.added} -{diff.removed})
      </div>
    )
  }
  if (diff.hunks.length === 0) {
    return <div className="tool-diff tool-diff--note">{t('tool.diff.noChange')}</div>
  }

  return (
    <div className="tool-diff">
      <div className="tool-diff-stat">
        <span className="tool-diff-add">+{diff.added}</span>
        <span className="tool-diff-remove">-{diff.removed}</span>
      </div>
      <pre className="tool-diff-body">
        {diff.hunks.map((hunk, hi) => (
          <div className="tool-diff-hunk" key={hi}>
            {hi > 0 && <div className="tool-diff-sep">⋯</div>}
            {hunk.lines.map((line, li) => (
              <div className={`tool-diff-line tool-diff-line--${line.op}`} key={li}>
                <span className="tool-diff-no">{line.oldLine ?? line.newLine ?? ''}</span>
                <span className="tool-diff-sign">
                  {line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' '}
                </span>
                {line.text}
              </div>
            ))}
          </div>
        ))}
      </pre>
    </div>
  )
}
