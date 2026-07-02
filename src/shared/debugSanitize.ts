const REDACTED = '[REDACTED]'

/** Keys whose string values are replaced with `[REDACTED]` in debug logs. */
const SENSITIVE_KEYS = new Set([
  'apiKey',
  'api_key',
  'password',
  'privateKey',
  'private_key',
  'passphrase',
  'authorization',
  'Authorization'
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Deep-clone a value for debug logging, redacting secrets (apiKey, password,
 * privateKey, passphrase, Authorization).
 */
export function sanitizeForDebug(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDebug(item))
  }
  if (!isPlainObject(value)) return String(value)

  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) {
      out[key] = REDACTED
    } else if (key === 'password' || key === 'privateKey' || key === 'passphrase') {
      out[key] = REDACTED
    } else {
      out[key] = sanitizeForDebug(val)
    }
  }
  return out
}

/** Truncate long strings (e.g. ssh:write payloads) for debug logs. */
export function truncateForDebug(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}… (${text.length} chars)`
}
