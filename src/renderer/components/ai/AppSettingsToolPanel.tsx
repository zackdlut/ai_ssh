import { useEffect, useMemo, useState } from 'react'
import AppSettingsToolView from './AppSettingsToolView'
import {
  buildCurrentAppSettingsSnapshot,
  mergeAppSettingsUpdates,
  parseAppSettingsSnapshot,
  type AppSettingsSnapshot
} from '../../lib/appSettingsMerge'

interface ReadProps {
  mode: 'read'
  data: Record<string, unknown>
}

interface EditProps {
  mode: 'edit'
  updates: Record<string, unknown>
  onUpdatesChange: (updates: Record<string, unknown>) => void
}

type Props = ReadProps | EditProps

export default function AppSettingsToolPanel(props: Props): JSX.Element {
  const [baseline, setBaseline] = useState<AppSettingsSnapshot | null>(null)

  useEffect(() => {
    if (props.mode === 'edit') {
      void buildCurrentAppSettingsSnapshot().then(setBaseline)
    }
  }, [props.mode])

  const snapshot = useMemo(() => {
    if (props.mode === 'read') {
      return parseAppSettingsSnapshot(props.data)
    }
    if (!baseline) return null
    return mergeAppSettingsUpdates(baseline, props.updates)
  }, [props, baseline])

  if (!snapshot) {
    return <div className="tool-list-empty">…</div>
  }

  if (props.mode === 'read') {
    return <AppSettingsToolView mode="read" snapshot={snapshot} />
  }

  return (
    <AppSettingsToolView
      mode="edit"
      snapshot={snapshot}
      updates={props.updates}
      onUpdatesChange={props.onUpdatesChange}
    />
  )
}
