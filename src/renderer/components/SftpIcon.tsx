import { type CSSProperties } from 'react'

interface Props {
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

const SIZE_PX = { sm: 16, md: 20, lg: 24 } as const

/** Folder + SFTP label over a secured shield — theme-aware line art. */
export default function SftpIcon({ className, size = 'md' }: Props): JSX.Element {
  const px = SIZE_PX[size]
  const cls = ['sftp-icon', className].filter(Boolean).join(' ')

  return (
    <span
      className={cls}
      style={{ ['--sftp-size' as string]: `${px}px` } as CSSProperties}
      aria-hidden
    >
      <svg viewBox="0 0 28 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Folder */}
        <path
          d="M5 8.5h5.5V6.5h7V8.5H23a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V10a1.5 1.5 0 0 1 1.5-1.5Z"
          stroke="var(--sftp-folder-stroke)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <text
          x="14"
          y="15.5"
          textAnchor="middle"
          fill="var(--sftp-label)"
          fontSize="5.2"
          fontWeight="700"
          fontFamily="var(--font-ui)"
          letterSpacing="0.2"
        >
          SFTP
        </text>

        {/* Connection neck */}
        <path
          d="M11.5 21v3.5M16.5 21v3.5"
          stroke="var(--sftp-connector)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />

        {/* Side network bars */}
        <path
          d="M1.5 30.5h5.5M21 30.5h5.5"
          stroke="var(--sftp-connector)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />

        {/* Shield */}
        <path
          d="M14 25.5 8.5 27.5v5.2c0 3.6 2.4 5.6 5.5 7.1 3.1-1.5 5.5-3.5 5.5-7.1v-5.2L14 25.5Z"
          stroke="var(--sftp-shield-stroke)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />

        {/* Checkmark */}
        <path
          d="M11.2 31.8 13.1 33.6 16.8 29.8"
          stroke="var(--sftp-check)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}
