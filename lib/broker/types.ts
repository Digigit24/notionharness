import type { RunEvent } from '@/lib/run-events'

export type RunStatus = 'queued' | 'dispatched' | 'running' | 'waiting_directory' | 'completed' | 'failed' | 'cancelled'

export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled']

export interface Run {
  id: number
  taskId: number | null
  agentId: number | null
  status: RunStatus
  attempt: number
  maxAttempts: number
  retryOf: number | null
  priority: number
  originatorUser: number | null
  accountableUser: number
  workerId: string | null
  externalSessionId: string | null
  pageId: number | null
  pageSubtreeBlockId: string | null
  /** Serialized prompt for page-scoped runs (taskId is null). */
  prompt: string | null
  nextSeq: number
  leaseExpiresAt: string | null
  startedAt: string | null
  completedAt: string | null
  error: string | null
  mcpOverlay: unknown
  runToken: string | null
  createdAt: string
  updatedAt: string
}

// RunEvent itself lives in lib/run-events.ts (the one shared contract every
// producer — broker, daemon, ACP adapter — imports); re-exported here so
// existing `import type { RunEvent } from './types'` call sites keep working.
export type { RunEvent }

export interface RunMessageRow {
  seq: number
  event: RunEvent
  createdAt: string
}
