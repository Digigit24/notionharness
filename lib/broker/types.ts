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

// Mirrors docs/ROADMAP.html §3.1's RunEvent contract verbatim. Every event is
// ordered by the `seq` `lib/broker/messages.ts` assigns on append, never by
// `created_at` or insertion order.
export type RunEvent =
  | { type: 'message'; role: string; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; status: string }
  | { type: 'tool_result'; id: string; output: unknown; isError: boolean }
  | { type: 'permission'; id: string; title: string; detail: string; options: unknown }
  | { type: 'file_change'; path: string; diff: string }
  | { type: 'terminal'; id: string; chunk: string }
  | { type: 'usage'; provider: string; model: string; tokens: number; costTicks: number }
  | { type: 'session'; externalId: string }
  | { type: 'done'; status: 'ok' | 'error' | 'cancelled' }

export interface RunMessageRow {
  seq: number
  event: RunEvent
  createdAt: string
}
