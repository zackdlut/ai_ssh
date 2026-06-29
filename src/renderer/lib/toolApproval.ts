import { isReadonlyTool } from '../../shared/aiTools'
import type { ToolCallView } from '../../shared/types'
import { useAIStore } from '../store/aiStore'

export interface PendingToolCallRef {
  messageId: string
  callId: string
  call: ToolCallView
}

const APPROVE_PHRASES = new Set([
  '确认',
  '确认执行',
  '确认操作',
  '批准',
  '同意',
  '执行',
  '通过',
  '可以',
  '好的',
  '好啊',
  '行',
  'ok',
  'okay',
  'yes',
  'y',
  'approve',
  'approved',
  'confirm',
  'confirmed',
  'proceed',
  'allow',
  'execute',
  'go',
  'go ahead'
])

const REJECT_PHRASES = new Set([
  '拒绝',
  '取消',
  '不要',
  '算了',
  '不行',
  '否决',
  '否',
  'no',
  'n',
  'reject',
  'rejected',
  'cancel',
  'cancelled',
  'canceled',
  'deny',
  'denied',
  'abort',
  'decline',
  'declined',
  'stop'
])

/** Normalize chat input for approval phrase matching. */
export function normalizeApprovalInput(text: string): string {
  return text
    .trim()
    .replace(/[。！!?.，,；;：:]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

export function parseToolApprovalInput(text: string): 'approve' | 'reject' | null {
  const normalized = normalizeApprovalInput(text)
  if (!normalized) return null
  if (APPROVE_PHRASES.has(normalized)) return 'approve'
  if (REJECT_PHRASES.has(normalized)) return 'reject'
  return null
}

/** Collect action tool calls still awaiting user approval in a chat tab. */
export function getPendingToolCalls(tabId: string): PendingToolCallRef[] {
  const tab = useAIStore.getState().chatTabs.find((t) => t.id === tabId)
  if (!tab) return []

  const pending: PendingToolCallRef[] = []
  for (const message of tab.messages) {
    if (message.role !== 'assistant' || !message.toolCalls) continue
    for (const call of message.toolCalls) {
      if (call.status === 'pending' && !isReadonlyTool(call.name)) {
        pending.push({ messageId: message.id, callId: call.id, call })
      }
    }
  }
  return pending
}

export function hasPendingToolCalls(tabId: string): boolean {
  return getPendingToolCalls(tabId).length > 0
}
