/**
 * Explicit phase model for the SSH agent loop.
 *
 * The loop is driven by function-calling events rather than a hand-written
 * `while`, so its state used to be implicit — scattered across the `busy` flag,
 * the `loops`/`pending` maps and per-call statuses, with no single place that
 * said "the agent is currently verifying" or "recovering". This module gives the
 * loop an observable phase plus a PURE transition function, so every branch in
 * `onDone` / `maybeContinueLoop` / `runToolCall` maps to a named transition that
 * can be logged, guarded and reasoned about.
 */
export type AgentPhase =
  | 'idle'
  | 'thinking'
  | 'acting'
  | 'observing'
  | 'verifying'
  | 'recovering'
  | 'awaitingUser'
  | 'done'
  | 'failed'

export type AgentEvent =
  | 'prompt' // user sent a new instruction
  | 'toolCalls' // model emitted tool calls
  | 'needApproval' // an action tool awaits user approval
  | 'approved' // user approved a pending action
  | 'rejected' // user rejected a pending action
  | 'toolExecuted' // a tool call finished executing
  | 'observed' // results captured back into the conversation
  | 'continue' // verify says: keep going (goal not yet met)
  | 'finalAnswer' // model produced a tool-call-free answer
  | 'recover' // a recoverable error occurred
  | 'recovered' // recovery produced a next step
  | 'guardTripped' // loop guard limit hit
  | 'unrecoverable' // recovery gave up

/**
 * Pure transition function. Unknown (phase, event) pairs keep the current phase
 * so a stray event can never corrupt the state — the caller decides what to do.
 */
export function transition(phase: AgentPhase, event: AgentEvent): AgentPhase {
  switch (event) {
    case 'guardTripped':
    case 'unrecoverable':
      return 'failed'
    case 'recover':
      return 'recovering'
    case 'prompt':
      return 'thinking'
    case 'finalAnswer':
      return 'done'
    case 'toolCalls':
      return 'acting'
    case 'needApproval':
      return 'awaitingUser'
    case 'approved':
      return 'acting'
    case 'rejected':
      return 'thinking'
    case 'toolExecuted':
      return 'observing'
    case 'observed':
      return 'verifying'
    case 'continue':
    case 'recovered':
      return 'thinking'
    default:
      return phase
  }
}
