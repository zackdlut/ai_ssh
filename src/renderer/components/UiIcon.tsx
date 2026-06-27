import CopilotSparkleIcon from './CopilotSparkleIcon'
import SftpIcon from './SftpIcon'

export type UiIconName =
  | 'connections'
  | 'settings'
  | 'copilot'
  | 'sftp'
  | 'themes'
  | 'terminal'
  | 'language'
  | 'ai'
  | 'about'
  | 'plus'
  | 'folder-plus'
  | 'panel-close'
  | 'caret-down'
  | 'server'
  | 'clock'
  | 'connect'
  | 'edit'
  | 'delete'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'save'
  | 'folder'
  | 'folder-new'

interface Props {
  name: UiIconName
  className?: string
  size?: 'sm' | 'md' | 'lg'
  tone?: 'default' | 'menu'
}

export default function UiIcon({ name, className, size = 'md', tone = 'default' }: Props): JSX.Element {
  if (name === 'copilot') {
    return <CopilotSparkleIcon className={className} size={size} tone={tone} />
  }

  if (name === 'sftp') {
    return <SftpIcon className={className} size={size} />
  }

  const sizeClass =
    size === 'sm' ? 'ui-icon--sm' : size === 'lg' ? 'ui-icon--lg' : ''
  const cls = ['ui-icon', `ui-icon--${name}`, sizeClass, className].filter(Boolean).join(' ')
  return <span className={cls} aria-hidden />
}
