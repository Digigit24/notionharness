import type { Payload } from 'payload'
import { listRunsForPage, listRunEvents, type Run } from '@/lib/broker'

/**
 * ROADMAP B-2 "Moat" — provenance surfacing. This module resolves "who/what
 * wrote this block" from data that already exists (per the batch's own
 * instruction to check before inventing a new tracking system):
 *
 * - **Which run wrote a block, and when** — real, from `run_messages`' own
 *   `page_write` `RunEvent`s (`lib/run-events.ts`), joined to `runs` via
 *   `listRunsForPage` (see that function's doc comment for why `page_id`
 *   alone is the right join key for both task-scoped and page-scoped runs).
 *   `committedAt` is that event's own `created_at`, not the run's
 *   `createdAt`/`completedAt` — a long-running run's block written on step 2
 *   should show *that* block's own write time, not the run's start/end.
 * - **Which agent** — real, `runs.agent_id` resolved against the `agents`
 *   collection.
 * - **Which task, if any** — real, `runs.task_id` resolved against `tasks`.
 *   Null for a page-scoped run (`enqueuePageRun`), which is the honest
 *   answer for those — there is no task to reference.
 * - **Which comment, if any, triggered the run** — investigated and found
 *   genuinely absent, not just unresolved: `collections/Comments.ts` only
 *   relates a comment to a `task`, never to a `run`; `enqueueRun`'s input
 *   (`lib/broker/runs.ts`) and the `runs` table itself (see
 *   `lib/broker/migrations/0001_runs_run_messages_run_usage.sql`) have no
 *   comment/trigger column of any kind; and the task-detail composer's two
 *   verbs — "Enter comments" (`createTaskComment`) vs. "⌘/Ctrl+Enter runs"
 *   (`startTaskRun`) — are two independent server actions that never pass a
 *   comment id to each other (`app/(app)/workspace/[workspaceSlug]/tasks/
 *   [taskId]/actions.ts`). Guessing "the most recent comment before this run
 *   started" would be a fabrication, not a derivation, so this module does
 *   not model a comment/trigger field at all — the plan's own "· from your
 *   comment on TASK-6" clause is honestly degraded to omitted, not guessed.
 *   `taskId`/`taskTitle` below cover the "a task reference" half of that
 *   clause, which *is* real.
 *
 * Human-authored blocks (including a human editing an agent-authored block
 * afterward) have no entry here at all — there is no per-block human
 * authorship tracked anywhere in this codebase (`collections/Pages.ts` has
 * no `createdBy`, and BlockSuite's Yjs updates carry no stable per-edit user
 * identity today) — callers must treat "no entry" as "no provenance to
 * show," never as "human-authored" in a way that implies a specific person.
 */
export interface BlockProvenance {
  blockId: string
  runId: number
  agentId: number | null
  agentName: string | null
  /** ISO timestamp of the `page_write` event's own `run_messages.created_at`. */
  committedAt: string
  taskId: number | null
  taskTitle: string | null
}

export type PageProvenanceMap = Record<string, BlockProvenance>

/**
 * Resolves provenance for every block on a page in one pass — the hover
 * chip, the "written by" strip, and the time filter all read from the same
 * map, per the batch's "one data source" instruction, rather than each
 * re-deriving it. Runs with no committed `page_write` events (queued,
 * still running with nothing written yet, or failed before a first write)
 * contribute nothing, which is correct — they haven't written anything to
 * attribute.
 */
export async function getPageProvenance(payload: Payload, pageId: number): Promise<PageProvenanceMap> {
  const runs = await listRunsForPage(pageId)
  if (runs.length === 0) return {}

  const eventsByRun = await Promise.all(runs.map((run) => listRunEvents(run.id)))

  const agentIds = Array.from(new Set(runs.map((run) => run.agentId).filter((id): id is number => id !== null)))
  const taskIds = Array.from(new Set(runs.map((run) => run.taskId).filter((id): id is number => id !== null)))

  const [agentDocs, taskDocs] = await Promise.all([
    agentIds.length > 0
      ? payload.find({ collection: 'agents', where: { id: { in: agentIds } }, limit: agentIds.length, depth: 0, overrideAccess: true })
      : null,
    taskIds.length > 0
      ? payload.find({ collection: 'tasks', where: { id: { in: taskIds } }, limit: taskIds.length, depth: 0, overrideAccess: true })
      : null,
  ])

  const agentNameById = new Map<number, string>()
  for (const agent of agentDocs?.docs ?? []) agentNameById.set(agent.id, agent.name)
  const taskTitleById = new Map<number, string>()
  for (const task of taskDocs?.docs ?? []) taskTitleById.set(task.id, task.title || 'Untitled')

  const map: PageProvenanceMap = {}
  runs.forEach((run: Run, idx) => {
    for (const row of eventsByRun[idx]) {
      // Defensive on `pageId`/`status` even though every `page_write` event
      // this run recorded should already match both — `listRunEvents`
      // returns a run's *whole* transcript, not just its page writes, so
      // this is really just the `event.type` narrow plus belt-and-braces.
      if (row.event.type !== 'page_write' || row.event.status !== 'committed' || row.event.pageId !== pageId) continue
      map[row.event.blockId] = {
        blockId: row.event.blockId,
        runId: run.id,
        agentId: run.agentId,
        agentName: run.agentId !== null ? agentNameById.get(run.agentId) ?? null : null,
        committedAt: row.createdAt,
        taskId: run.taskId,
        taskTitle: run.taskId !== null ? taskTitleById.get(run.taskId) ?? null : null,
      }
    }
  })
  return map
}

/** Single-block convenience wrapper around `getPageProvenance` for callers
 * that only need one block's provenance (e.g. an API route backing a
 * client that doesn't already hold the whole page's map). Prefer
 * `getPageProvenance` directly when resolving more than one block on the
 * same page — this still does the full page-scoped run/event read
 * underneath, just discards everything but one entry. */
export async function getBlockProvenance(payload: Payload, pageId: number, blockId: string): Promise<BlockProvenance | null> {
  const map = await getPageProvenance(payload, pageId)
  return map[blockId] ?? null
}
