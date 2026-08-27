/**
 * Learn a model endpoint's REAL context window from what it reports back.
 *
 * The window used to come from Settings alone, and a wrong number there is not
 * a cosmetic problem: every budget in the loop is derived from it, so a limit
 * four times the truth means compaction never fires, the prompt grows past what
 * the server accepts, and the server — not the app — decides what to drop. It
 * drops from the FRONT, which is where the user's instruction lives. The
 * observed failure was a local Ollama whose `num_ctx` had been VRAM-fitted down
 * to 32k while Settings still carried the model's advertised 128k: the task ran
 * until the prompt crossed 32k, then the endpoint rejected the request outright
 * ("no user query found in messages") and every turn after it had a handful of
 * tokens left to answer with.
 *
 * The provider already tells us enough to catch this, on every single turn:
 *
 * - `usage.prompt` smaller than the prompt we handed it means it dropped part
 *   of what we sent, and whatever came back through `usage.total` is what
 *   actually fit.
 * - `usage.total` pinned to the same number across turns while the prompt keeps
 *   moving means the endpoint is clamping the sum — that number IS the window.
 *
 * Both are per endpoint+model, not per chat, so what one task learns the next
 * one starts with. Nothing here ever raises a limit above what Settings says:
 * the user's number stays the ceiling, this only lowers it toward the truth.
 */
import type { AITokenUsage } from '../../shared/types'

/**
 * Windows servers are actually configured with. An observation within 2% of one
 * is reported as that value, so the notice reads "32768" rather than "32,766 —
 * whatever the last turn happened to stop at".
 */
const COMMON_WINDOWS = [4096, 8192, 16384, 32768, 49152, 65536, 131072, 262144]
const SNAP_TOLERANCE = 0.02

/** Two totals within this of each other are the same number for our purposes. */
const CEILING_TOLERANCE = 0.01
/** Turns that must agree before a pinned total is called a ceiling. */
const CEILING_SAMPLES = 2
/**
 * A turn that generated more than this still had room, so its total matching
 * another one's is a coincidence rather than a clamp.
 */
const CEILING_COMPLETION_MAX = 1024
/** Below this a conversation is too small for a repeated total to mean anything. */
const MIN_CEILING_TOKENS = 4096
/**
 * How far below the configured limit a ceiling has to sit before we believe it.
 * A total near the configured number is the budget working as intended.
 */
const CEILING_HEADROOM = 0.9

/** A prompt this much smaller than we sent suggests the server dropped part of it. */
const TRUNCATION_RATIO = 0.85
/** Below this the estimator's own error is larger than the signal. */
const MIN_TRUNCATION_ESTIMATE = 8000

/** Cut applied when the endpoint refuses a request for being over-window. */
const REJECTION_CUT = 0.75

/** Never calibrate below this: the loop cannot run in a smaller window. */
export const MIN_CALIBRATED_WINDOW = 8192

export type CalibrationReason =
  /** The endpoint clamped prompt+completion to a fixed number. */
  | 'ceiling'
  /** It reported back a shorter prompt than we sent. */
  | 'truncated'
  /** It refused the request for exceeding the window. */
  | 'rejected'

export interface Calibration {
  window: number
  reason: CalibrationReason
}

interface Sample {
  total: number
  prompt: number
  completion: number
}

interface EndpointState {
  window?: number
  reason?: CalibrationReason
  samples: Sample[]
}

const endpoints = new Map<string, EndpointState>()

/**
 * Identity of the thing whose window we are learning. Two chats pointed at the
 * same model on the same endpoint share one observation; changing either the
 * model or the base URL starts over, because the old number says nothing about
 * the new server.
 */
export function calibrationKey(profile: string, model: string, baseURL: string): string {
  return `${profile}|${model}|${baseURL}`
}

function state(key: string): EndpointState {
  let entry = endpoints.get(key)
  if (!entry) {
    entry = { samples: [] }
    endpoints.set(key, entry)
  }
  return entry
}

/** The configured window this observation is sitting on, if it is sitting on one. */
function commonWindowNear(value: number): number | undefined {
  for (const window of COMMON_WINDOWS) {
    if (Math.abs(value - window) <= window * SNAP_TOLERANCE) return window
  }
  return undefined
}

/** Report an observation as the round window it is almost certainly meant to be. */
function snap(value: number): number {
  return commonWindowNear(value) ?? value
}

/**
 * True when these turns show the endpoint clamping prompt+completion: the totals
 * agree while the prompts do not, and the model was left too little to say
 * anything with.
 */
function isCeiling(samples: Sample[], configured: number): boolean {
  if (samples.length < CEILING_SAMPLES) return false
  const totals = samples.map((s) => s.total)
  const max = Math.max(...totals)
  const min = Math.min(...totals)
  if (max < MIN_CEILING_TOKENS) return false
  if (max - min > max * CEILING_TOLERANCE) return false
  if (configured > 0 && max >= configured * CEILING_HEADROOM) return false
  if (samples.some((s) => s.completion > CEILING_COMPLETION_MAX)) return false
  // Identical prompts mean the loop repeated a turn, not that the sum is
  // clamped. The repeat guard's job, not ours.
  return new Set(samples.map((s) => s.prompt)).size > 1
}

/**
 * Record a learned window, keeping the tightest one seen. Returns it only when
 * it is news, so the caller can tell the user once instead of every turn.
 */
function learn(
  entry: EndpointState,
  raw: number,
  reason: CalibrationReason,
  configured: number
): Calibration | undefined {
  const window = Math.max(MIN_CALIBRATED_WINDOW, Math.floor(snap(raw)))
  // Nothing to learn from a window at or above what we were already told.
  if (configured > 0 && window >= configured) return undefined
  if (entry.window !== undefined && window >= entry.window) return undefined
  entry.window = window
  entry.reason = reason
  return { window, reason }
}

export interface UsageObservation {
  key: string
  /** The window Settings claims for this endpoint. */
  configured: number
  /** Our own estimate of the prompt we just sent, tools and all. */
  estimatedPrompt: number
  usage: AITokenUsage
}

/**
 * Feed one completed turn's usage in. Returns a calibration when this
 * observation revised the window DOWN, and undefined otherwise (including every
 * healthy turn, which is almost all of them).
 */
export function observeUsage(o: UsageObservation): Calibration | undefined {
  const { total, prompt, completion } = o.usage
  if (!Number.isFinite(total) || total <= 0) return undefined
  const entry = state(o.key)

  // The endpoint dropped part of the prompt: whatever it charged us for is what
  // fit, so that is the window — no second sample needed.
  //
  // Two things have to agree before we believe that from ONE turn, because the
  // cost of being wrong is a window clamped to the current conversation for the
  // rest of the session. Our estimator has to be well above what came back, AND
  // what came back has to land on a window a server would actually be
  // configured with. An estimator running 15% high on dense output satisfies the
  // first and essentially never the second.
  const landedOn = commonWindowNear(total)
  if (
    landedOn !== undefined &&
    o.estimatedPrompt >= MIN_TRUNCATION_ESTIMATE &&
    prompt > 0 &&
    prompt < o.estimatedPrompt * TRUNCATION_RATIO
  ) {
    entry.samples = []
    return learn(entry, total, 'truncated', o.configured)
  }

  entry.samples.push({ total, prompt, completion })
  if (entry.samples.length > CEILING_SAMPLES) {
    entry.samples = entry.samples.slice(-CEILING_SAMPLES)
  }
  if (!isCeiling(entry.samples, o.configured)) return undefined
  return learn(entry, Math.max(...entry.samples.map((s) => s.total)), 'ceiling', o.configured)
}

/**
 * The endpoint refused a request for not fitting. We do not know the window,
 * only that it is below the prompt we sent, so take a cut off whichever bound is
 * tighter and let the usage signals refine it from there.
 */
export function noteContextRejection(
  key: string,
  configured: number,
  /** Our estimate of the prompt that was refused, when known. */
  estimatedPrompt?: number
): Calibration {
  const entry = state(key)
  const bounds = [entry.window ?? configured]
  if (estimatedPrompt && estimatedPrompt > 0) bounds.push(estimatedPrompt)
  const base = Math.min(...bounds.filter((n) => n > 0))
  const window = Math.max(MIN_CALIBRATED_WINDOW, Math.floor(base * REJECTION_CUT))
  entry.samples = []
  entry.window = window
  entry.reason = 'rejected'
  return { window, reason: 'rejected' }
}

/** What this endpoint has been observed to accept, if anything. */
export function calibratedWindow(key: string | undefined): Calibration | undefined {
  if (!key) return undefined
  const entry = endpoints.get(key)
  if (!entry?.window) return undefined
  return { window: entry.window, reason: entry.reason ?? 'ceiling' }
}

/**
 * The window to budget against: the configured one, lowered to what the
 * endpoint has actually been seen to accept.
 */
export function effectiveContextLimit(key: string | undefined, configured: number): number {
  const observed = calibratedWindow(key)
  if (!observed) return configured
  if (configured <= 0) return observed.window
  return Math.min(configured, observed.window)
}

/** Test seam: observations are process-lifetime state. */
export function resetContextCalibration(): void {
  endpoints.clear()
}
