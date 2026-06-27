import { useId, type CSSProperties } from 'react'

interface Props {
  className?: string
  size?: 'sm' | 'md' | 'lg'
  /** Muted, menu-sized variant that follows menu-item-icon currentColor. */
  tone?: 'default' | 'menu'
}

const SIZE_PX = { sm: 16, md: 20, lg: 24 } as const
const MENU_SIZE_PX = 18

/** Gemini-style 4-point sparkle — crisp SVG with staggered twinkle. */
export default function CopilotSparkleIcon({
  className,
  size = 'md',
  tone = 'default'
}: Props): JSX.Element {
  const uid = useId().replace(/:/g, '')
  const px = tone === 'menu' ? MENU_SIZE_PX : SIZE_PX[size]
  const cls = [
    'copilot-sparkle-icon',
    tone === 'menu' ? 'copilot-sparkle-icon--menu' : null,
    className
  ]
    .filter(Boolean)
    .join(' ')

  const gradMain = `copilot-main-${uid}`
  const gradA = `copilot-a-${uid}`
  const gradB = `copilot-b-${uid}`

  return (
    <span
      className={cls}
      style={{ ['--copilot-size' as string]: `${px}px` } as CSSProperties}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id={gradMain} x1="3" y1="3" x2="20" y2="20" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="var(--copilot-star-highlight)" />
            <stop offset="50%" stopColor="var(--copilot-star-mid)" />
            <stop offset="100%" stopColor="var(--copilot-star-deep)" />
          </linearGradient>
          <linearGradient id={gradA} x1="15" y1="1" x2="22" y2="10" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="var(--copilot-star-highlight)" />
            <stop offset="100%" stopColor="var(--copilot-star-mid)" />
          </linearGradient>
          <linearGradient id={gradB} x1="1" y1="15" x2="9" y2="23" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="var(--copilot-star-mid)" />
            <stop offset="100%" stopColor="var(--copilot-star-deep)" />
          </linearGradient>
        </defs>

        <path
          className="copilot-sparkle-star copilot-sparkle-star--main"
          d="M10.5 5.5 12.4 10.2 17.5 11.5 12.4 12.8 10.5 17.5 8.6 12.8 3.5 11.5 8.6 10.2Z"
          fill={`url(#${gradMain})`}
        />
        <path
          className="copilot-sparkle-flare"
          d="M10.5 8.8v5.4M7.8 11.5h5.4"
          stroke="var(--copilot-flare)"
          strokeWidth="1"
          strokeLinecap="round"
        />
        <path
          className="copilot-sparkle-star copilot-sparkle-star--a"
          d="M18.8 2.8 19.5 4.9 21.5 5.5 19.5 6.1 18.8 8.2 18.1 6.1 16.1 5.5 18.1 4.9Z"
          fill={`url(#${gradA})`}
        />
        <path
          className="copilot-sparkle-star copilot-sparkle-star--b"
          d="M5.2 16.2 5.8 17.9 7.5 18.4 5.8 18.9 5.2 20.6 4.6 18.9 2.9 18.4 4.6 17.9Z"
          fill={`url(#${gradB})`}
        />
      </svg>
    </span>
  )
}
