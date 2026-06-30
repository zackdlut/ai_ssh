import { useEffect, useRef, useState } from 'react'

function clampNumber(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function formatStepperValue(n: number, decimals: number): string {
  return decimals > 0 ? n.toFixed(decimals) : String(Math.round(n))
}

export default function StepperNumberInput({
  value,
  min,
  max,
  step,
  decimals,
  onChange,
  disabled = false
}: {
  value: number
  min: number
  max: number
  step: number
  decimals: number
  onChange: (n: number) => void
  disabled?: boolean
}): JSX.Element {
  const [draft, setDraft] = useState(() => formatStepperValue(value, decimals))
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setDraft(formatStepperValue(value, decimals))
  }, [value, decimals])

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    []
  )

  const normalize = (n: number): number => {
    const rounded =
      decimals > 0 ? Math.round(n * 10 ** decimals) / 10 ** decimals : Math.round(n)
    return clampNumber(rounded, min, max)
  }

  const commit = (raw: number): void => {
    const next = normalize(raw)
    setDraft(formatStepperValue(next, decimals))
    onChange(next)
  }

  const scheduleCommit = (raw: number): void => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => commit(raw), 350)
  }

  const stepBy = (delta: number): void => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const parsed = Number(draft)
    const base = Number.isFinite(parsed) ? parsed : value
    commit(base + delta)
  }

  const atMin = value <= min
  const atMax = value >= max

  return (
    <div className={`terminal-stepper${disabled ? ' is-disabled' : ''}`}>
      <button
        type="button"
        className="terminal-stepper-btn"
        aria-label="decrease"
        disabled={disabled || atMin}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => stepBy(-step)}
      >
        −
      </button>
      <input
        type="text"
        inputMode="decimal"
        className="terminal-stepper-input"
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          const parsed = Number(next)
          if (Number.isFinite(parsed)) scheduleCommit(parsed)
        }}
        onBlur={() => {
          if (debounceRef.current) clearTimeout(debounceRef.current)
          const parsed = Number(draft)
          if (Number.isFinite(parsed)) commit(parsed)
          else setDraft(formatStepperValue(value, decimals))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            stepBy(step)
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            stepBy(-step)
          }
        }}
      />
      <button
        type="button"
        className="terminal-stepper-btn"
        aria-label="increase"
        disabled={disabled || atMax}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => stepBy(step)}
      >
        +
      </button>
    </div>
  )
}
