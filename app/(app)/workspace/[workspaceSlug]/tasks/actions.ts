'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import type { Task } from '@/payload-types'
import { enqueueRun, listActiveRunsForWorkspace, listRunsForTask, listRunEvents, getTaskUsageTotals } from '@/lib/broker'
import { buildTasksWhere, payloadSortString, type TaskFilters, type TaskSort } from '@/lib/task-views/data-layer'
import { guard, raise, type WithFailure } from '@/lib/failures'
import { requireAccess, type Verb } from '@/lib/permissions'

// R12-P1.1 — the failure spine (lib/failures.ts) is adopted here per action,
// not per file, because this module is shared across units. Everything below
// that is reached ONLY from `components/tasks/*` and this route's own pages
// returns `WithFailure<T>` and is `unwrap()`ed by its callers.
//
// `createTask`, `updateTaskFields`, `createQuickTask`, `getTask`,
// `getTaskRuns`, `getRunMessages` and `getActiveRunsForWorkspace` are
// deliberately NOT converted yet: their callers include the command bar
// (`command-bar/actions.ts`, `components/command-bar/command-bar.tsx`), the
// editor's task block (`components/editor/blocks/task/*`) and the
// `active-runs` page, which belong to other units. Changing their return
// type breaks those files' compile without their owners being able to fix
// them in the same pass, which is the flag day the envelope design exists to
// avoid. They still throw, so their messages are still lost in production —
// tracked, not forgotten.

/**
 * PHASE 0 — every action in this file wrote or read with `overrideAccess: true`
 * and no session check of any kind. A server action is a public POST endpoint
 * with a generated URL, not a private function, so naming any `workspaceId` or
 * `taskId` was enough to create, retitle, reassign, bulk-edit or list somebody
 * else's tasks — and, through `updateTaskFields`'s assign-agent side effect, to
 * START A RUN in a workspace you have never been a member of, spending its
 * budget and running a binary on this host.
 *
 * Two helpers, because the actions split cleanly in two. The ones that already
 * carry a `workspaceId` check it directly; the ones that carry only a `taskId`
 * resolve the workspace FROM THE TASK rather than from anything the caller
 * said, which is the difference between a check and a formality.
 */
async function requireWorkspace(workspaceId: number, verb: Verb): Promise<number> {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You are not signed in.')
  await requireAccess({ userId: user.id, workspaceId, verb, objectType: 'workspace' })
  return user.id
}

async function requireTask(taskId: number, verb: Verb): Promise<number> {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You are not signed in.')
  const payload = await getPayloadClient()
  const task = await payload
    .findByID({ collection: 'tasks', id: taskId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  // One sentence for "no such task" and for "not yours", so this cannot be used
  // to enumerate which task ids exist in other workspaces.
  if (!task) raise('not_found', 'That task no longer exists.')
  const workspaceId = typeof task.workspace === 'number' ? task.workspace : task.workspace.id
  await requireAccess({ userId: user.id, workspaceId, verb, objectType: 'workspace' })
  return user.id
}

async function nextColumnPosition(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  workspaceId: number,
  statusId: number,
) {
  const result = await payload.find({
    collection: 'tasks',
    where: { workspace: { equals: workspaceId }, status: { equals: statusId } },
    sort: '-position',
    limit: 1,
    overrideAccess: true,
  })
  return (result.docs[0]?.position ?? 0) + 10
}

export async function createTask({
  workspaceId,
  workspaceSlug,
  statusId,
  title,
  createdById,
  projectId,
}: {
  workspaceId: number
  workspaceSlug: string
  statusId: number
  title: string
  createdById: number
  /** ROADMAP B-1 — project detail page's "New task" primary action pre-fills
   * this instead of leaving the task unscoped. Optional so every other
   * caller (the plain Tasks board) is unaffected. */
  projectId?: number
}): Promise<Task> {
  await requireWorkspace(workspaceId, 'write')
  const payload = await getPayloadClient()
  const position = await nextColumnPosition(payload, workspaceId, statusId)
  const task = await payload.create({
    collection: 'tasks',
    data: {
      title: title || 'Untitled',
      workspace: workspaceId,
      status: statusId,
      createdBy: createdById,
      position,
      ...(projectId ? { project: projectId } : {}),
    },
    overrideAccess: true,
  })
  revalidatePath(`/workspace/${workspaceSlug}/tasks`)
  if (projectId) revalidatePath(`/workspace/${workspaceSlug}/projects/${projectId}`)
  return task
}

// Drag-and-drop only moves a card between columns (status change), matching
// this codebase's one existing dnd-kit precedent (`components/database/
// kanban-board.tsx`) which is also column-level-only — dnd-kit/core alone
// (no `@dnd-kit/sortable`, not a dependency here) doesn't give a drop target
// more precise than "which column," so a dropped card is appended to the end
// of its new column rather than inserted at a specific index. Fine-grained
// intra-column reordering is a scoped follow-up if it turns out to matter.
export async function moveTaskToStatus({
  taskId,
  workspaceId,
  workspaceSlug,
  statusId,
}: {
  taskId: number
  workspaceId: number
  workspaceSlug: string
  statusId: number
}): Promise<WithFailure<Task>> {
  return guard(async () => {
    // The task decides the workspace. `workspaceId` is still used below to find
    // the next position in the target column, but it no longer decides who may
    // move the card — pairing your own workspace with somebody else's task id
    // was exactly the hole.
    await requireTask(taskId, 'write')
    const payload = await getPayloadClient()
    const [position, user] = await Promise.all([
      nextColumnPosition(payload, workspaceId, statusId),
      getCurrentPayloadUser(),
    ])
    const task = await payload.update({
      collection: 'tasks',
      id: taskId,
      data: { status: statusId, position },
      overrideAccess: true,
      // ROADMAP P2.6 — read by Tasks.ts's afterChange hook to attribute the
      // status_changed activity row to whoever dragged the card.
      context: { actorId: user?.id },
    })
    revalidatePath(`/workspace/${workspaceSlug}/tasks`)
    return task
  })
}

export async function updateTaskFields({
  taskId,
  workspaceSlug,
  data,
}: {
  taskId: number
  workspaceSlug: string
  data: Partial<Pick<Task, 'title' | 'status' | 'assignee' | 'agent' | 'project'>>
}): Promise<Task> {
  // `execute`, not `write`: setting `agent` enqueues a run below, which spends
  // the workspace's budget and runs a binary on this host. `lib/permissions/
  // model.ts` separates the two verbs for precisely this case.
  await requireTask(taskId, 'execute')
  const payload = await getPayloadClient()
  const user = await getCurrentPayloadUser()
  const before = await payload.findByID({ collection: 'tasks', id: taskId, depth: 0, overrideAccess: true })
  const task = await payload.update({
    collection: 'tasks',
    id: taskId,
    data,
    overrideAccess: true,
    context: { actorId: user?.id },
  })
  const beforeAgent = typeof before.agent === 'number' ? before.agent : before.agent?.id ?? null
  const afterAgent = typeof task.agent === 'number' ? task.agent : task.agent?.id ?? null
  if (afterAgent !== null && afterAgent !== beforeAgent && user?.id) {
    await enqueueRun({ taskId, agentId: afterAgent, originatorUser: user.id, accountableUser: user.id })
  }
  revalidatePath(`/workspace/${workspaceSlug}/tasks`)
  return task
}

/**
 * ROADMAP B-4 "Work" (bulk actions) — a bulk-select action (change status /
 * assign agent / add to project / archive) is always exactly one field write
 * across N tasks, so this is a genuine single new server action rather than
 * the client calling `updateTaskFields` N times: the whole point is
 * collapsing N client→server round trips into one. It is NOT a single bulk
 * SQL statement, deliberately — this app's Payload-vs-raw-pg boundary
 * (AGENTS.md) routes every `tasks` write through Payload's Local API so
 * `Tasks.ts`'s `beforeChange`/`afterChange` hooks (revision bump,
 * `lastActivityAt`, activity-log rows, the assign-agent `enqueueRun` side
 * effect) fire correctly for every affected row; a `payload.update({ where
 * })` bulk write only returns after-state docs with no per-row `previousDoc`
 * the caller can compare against, which is exactly what the agent-changed
 * enqueue check below needs. So this still issues one `payload.update` per
 * task, just from one server action call instead of N.
 */
export async function bulkUpdateTaskFields({
  taskIds,
  workspaceSlug,
  data,
}: {
  taskIds: number[]
  workspaceSlug: string
  data: Partial<Pick<Task, 'status' | 'assignee' | 'agent' | 'project'>>
}): Promise<WithFailure<Task[]>> {
  return guard(async () => {
    // Checked per task rather than once for the set: a bulk call is a list of
    // ids the caller supplied, and one id from another workspace hidden among
    // fifty of their own is the obvious way to abuse a single up-front check.
    // `execute` for the same reason `updateTaskFields` uses it.
    for (const taskId of taskIds) await requireTask(taskId, 'execute')
    const payload = await getPayloadClient()
    const user = await getCurrentPayloadUser()
    const changesAgent = Object.prototype.hasOwnProperty.call(data, 'agent')

    const updated = await Promise.all(
      taskIds.map(async (taskId) => {
        const before = changesAgent
          ? await payload.findByID({ collection: 'tasks', id: taskId, depth: 0, overrideAccess: true })
          : null
        const task = await payload.update({
          collection: 'tasks',
          id: taskId,
          data,
          overrideAccess: true,
          context: { actorId: user?.id },
        })
        if (changesAgent && user?.id) {
          const beforeAgent = before ? (typeof before.agent === 'number' ? before.agent : before.agent?.id ?? null) : null
          const afterAgent = typeof task.agent === 'number' ? task.agent : task.agent?.id ?? null
          if (afterAgent !== null && afterAgent !== beforeAgent) {
            await enqueueRun({ taskId, agentId: afterAgent, originatorUser: user.id, accountableUser: user.id })
          }
        }
        return task
      }),
    )
    revalidatePath(`/workspace/${workspaceSlug}/tasks`)
    return updated
  })
}

export interface TaskAgentColumnData {
  /** Total runs ever queued against this task — `getTaskUsageTotals`'s own `runCount`, not a second query (ROADMAP B-1's function, reused exactly per this batch's brief). */
  runCount: number
  /** Lifetime spend across every run, in the same fixed-point cost-tick unit `RunMetrics`/the run-card block already use (`(ticks / 100).toFixed(2)` => dollars). */
  totalCostTicks: number
  /** The most recently created run's status, or null if the task has never had one. */
  lastRunStatus: string | null
}

/** ROADMAP B-4 "Work" (agent columns: Runs / Last run outcome / Spend) —
 * batched across a whole board's worth of tasks in one server-action round
 * trip (same shape as `getActiveRunsForWorkspace`'s one-call-for-the-board
 * pattern), rather than the board polling once per task the way its
 * existing `runMetrics` effect does. Internally still one broker read pair
 * per task (`getTaskUsageTotals` + `listRunsForTask`, both ROADMAP B-1/P2.5
 * functions reused as-is, not reimplemented) — a real per-task rollup query
 * would be a good follow-up if this ever shows up as a hot path, but is out
 * of scope for this pass. */
export async function getTaskAgentColumnsData(taskIds: number[]): Promise<WithFailure<Record<number, TaskAgentColumnData>>> {
  return guard(async () => {
    for (const taskId of taskIds) await requireTask(taskId, 'read')
    const entries = await Promise.all(
      taskIds.map(async (taskId) => {
        const [usage, runs] = await Promise.all([getTaskUsageTotals(taskId), listRunsForTask(taskId)])
        return [taskId, { runCount: usage.runCount, totalCostTicks: usage.totalCostTicks, lastRunStatus: runs[0]?.status ?? null }] as const
      }),
    )
    return Object.fromEntries(entries)
  })
}

/**
 * ROADMAP B3.4/B3.5 — the `/task` slash-menu item's one action: "creates a
 * new real task row ... AND inserts this block referencing it, in one
 * action." Resolves `statusId`/`createdById` server-side (the workspace's
 * first status by position, and the logged-in user via
 * `getCurrentPayloadUser()`) rather than asking the caller to supply them —
 * unlike the task board or command bar, the BlockSuite editor has no
 * already-resolved `currentUserId`/status-column context threaded down to
 * it, and plumbing that through `BlockSuiteEditor.tsx`'s whole prop chain
 * for one slash item isn't worth it when this action can resolve both
 * itself, the same way `enqueuePageRun`/`startTaskRun` already resolve the
 * user server-side. Delegates to `createTask` (this file) for the actual
 * write — one source of truth for task creation, not a second path.
 */
export async function createQuickTask({
  workspaceId,
  workspaceSlug,
  title,
}: {
  workspaceId: number
  workspaceSlug: string
  title: string
}): Promise<Task> {
  const [user, payload] = await Promise.all([getCurrentPayloadUser(), getPayloadClient()])
  if (!user) throw new Error('You must be logged in to create a task.')
  await requireAccess({ userId: user.id, workspaceId, verb: 'write', objectType: 'workspace' })

  const statuses = await payload.find({
    collection: 'task-statuses',
    where: { workspace: { equals: workspaceId } },
    sort: 'position',
    limit: 1,
    overrideAccess: true,
  })
  const statusId = statuses.docs[0]?.id
  if (!statusId) throw new Error('This workspace has no task statuses configured yet.')

  return createTask({ workspaceId, workspaceSlug, statusId, title, createdById: user.id })
}

/** Task block's live fetch (`components/editor/blocks/task/task-block-view.tsx`)
 * — `depth: 1` so `status`/`assignee` come back populated for display, not
 * just raw relationship ids. */
export async function getTask(taskId: number): Promise<Task | null> {
  // Null rather than a raise for a task the caller may not see: this feeds the
  // editor's task block, which already renders a "no longer exists" state, and
  // a permission error inside a document reads as a broken document. It also
  // keeps the two cases indistinguishable to somebody probing ids.
  try {
    await requireTask(taskId, 'read')
  } catch {
    return null
  }
  const payload = await getPayloadClient()
  return payload.findByID({ collection: 'tasks', id: taskId, depth: 1, overrideAccess: true, disableErrors: true }).catch(() => null)
}

export async function getTaskRuns(taskId: number) {
  await requireTask(taskId, 'read')
  return listRunsForTask(taskId)
}

export async function getActiveRunsForWorkspace(workspaceId: number) {
  await requireWorkspace(workspaceId, 'read')
  return listActiveRunsForWorkspace(workspaceId)
}

export async function getRunMessages(runId: number) {
  return listRunEvents(runId)
}

export async function loadMoreTasks({
  workspaceId,
  statusId,
  offset,
  limit,
}: {
  workspaceId: number
  statusId: number
  offset: number
  limit: number
}): Promise<WithFailure<Task[]>> {
  return guard(async () => {
    await requireWorkspace(workspaceId, 'read')
    const payload = await getPayloadClient()
    const result = await payload.find({
      collection: 'tasks',
      where: { workspace: { equals: workspaceId }, status: { equals: statusId } },
      sort: 'position',
      limit,
      page: Math.floor(offset / limit) + 1,
      overrideAccess: true,
    })
    return result.docs
  })
}

/**
 * ROADMAP B-4.1 — the shared data layer's real cross-column query. Board
 * keeps its own per-status/per-page fetch (`loadMoreTasks`, unchanged) since
 * its columns ARE the status grouping; List and Table need a flat,
 * filtered, sorted view across every status at once, which no existing
 * action produced. `depth: 1` so assignee/project/status/agent come back
 * populated — List/Table render/inline-edit those directly, and `data-layer`
 * .ts's field helpers accept either populated objects or bare ids.
 *
 * Capped at `limit` (default below) rather than true infinite pagination —
 * a deliberate scope line for this pass, called out in the batch summary.
 */
const VIEW_QUERY_LIMIT = 500

export async function getTasksForView({
  workspaceId,
  filters,
  sort,
  limit = VIEW_QUERY_LIMIT,
}: {
  workspaceId: number
  filters: TaskFilters
  sort: TaskSort
  limit?: number
}): Promise<WithFailure<{ docs: Task[]; totalDocs: number }>> {
  return guard(async () => {
    await requireWorkspace(workspaceId, 'read')
    const payload = await getPayloadClient()
    const result = await payload.find({
      collection: 'tasks',
      where: buildTasksWhere(workspaceId, filters),
      sort: payloadSortString(sort),
      limit,
      depth: 1,
      overrideAccess: true,
    })
    return { docs: result.docs, totalDocs: result.totalDocs }
  })
}

// Read-only — the task detail drawer's Activity tab. Not exported from the
// top-level `app/(app)/actions.ts` since it's scoped to this surface only.
export async function getTaskActivity(taskId: number) {
  return guard(async () => {
    await requireTask(taskId, 'read')
    const payload = await getPayloadClient()
    const result = await payload.find({
      collection: 'activity',
      where: { entityType: { equals: 'task' }, entityId: { equals: String(taskId) } },
      sort: '-createdAt',
      limit: 100,
      overrideAccess: true,
    })
    return result.docs
  })
}
