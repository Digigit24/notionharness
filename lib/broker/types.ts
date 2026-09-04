import type { RunEvent } from '@/lib/run-events'

export type RunStatus = 'queued' | 'dispatched' | 'running' | 'waiting_directory' | 'completed' | 'failed' | 'cancelled'

export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled']

/** ROADMAP B3.1 (Batch B-2, suggestions mode) — whole-run accept/reject state
 * for a run's page subtree (`pageSubtreeBlockId`). Coarse fallback per the
 * plan's own pre-authorization: a per-block suggestion mark can't be stored
 * durably without either mutating a stock BlockSuite block schema this app
 * doesn't own, or registering a brand-new container block flavour with its
 * own children-rendering BlockComponent — both real BlockSuite-internals work
 * past this repo's lib/blocksuite-*.ts wrapper boundary. See
 * lib/agent-suggestions.ts for the full reasoning and the accept/reject ops
 * themselves. Meaningless (but always 'pending' by column default) for a run
 * that never got a page subtree in the first place. */
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected'

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
  /** The chat session this run belongs to (`chat_sessions.id`), when it was
   * started from a session thread rather than a task or page. */
  sessionId: number | null
  pageSubtreeBlockId: string | null
  suggestionStatus: SuggestionStatus
  /** Serialized prompt for page-scoped runs (taskId is null). */
  prompt: string | null
  nextSeq: number
  leaseExpiresAt: string | null
  startedAt: string | null
  completedAt: string | null
  /** ROADMAP B5.2 (Batch B-5) — set once the user clears this run from the
   * Inbox's failed/review-ready sections (`dismissRun`); null forever for a
   * run the inbox has never shown, or has shown but not yet cleared. Does
   * not affect `status`/`error` — a dismissed failed run is still a failed
   * run, it just no longer needs the user's attention. */
  dismissedAt: string | null
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
