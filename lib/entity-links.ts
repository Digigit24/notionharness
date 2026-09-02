import { getPayloadClient } from '@/lib/payload'
import { getRun } from '@/lib/broker/runs'
import type { Activity } from '@/payload-types'

type PayloadClient = Awaited<ReturnType<typeof getPayloadClient>>

// ROADMAP P2.6/P5.5/P6.5 - single shared "activity entity -> deep link" resolver
// plus the Q2 cross-mode href builders for the sidebar's ModeSwitcher.
//
// The notifications bell (app/(app)/notifications/actions.ts) and the Inbox
// home screen (workspace/[workspaceSlug]/inbox) both build hrefs from the
// polymorphic `activity.entityType`/`activity.entityId` pair, so the async
// lookup logic lives here once instead of being duplicated per call site.
// Defaults per docs/p6-5-plan-work-review-design.md Q1:
//   - task -> Plan: the task itself (highlighted in the tasks list)
//   - page -> Work: the page itself
//   - run  -> Review: the run's review panel
//   - project (and other future entityTypes) -> null until a detail route exists
//
// A few extra lookups per notification (task/page/run -> its workspace, for the
// slug in the URL) is an accepted cost for a "fetch when the panel opens, no
// real-time push" pass with a 30-item cap.
export async function hrefForEntity(
  payload: PayloadClient,
  entityType: Activity['entityType'],
  entityId: string,
): Promise<string | null> {
  const id = Number(entityId)
  if (!Number.isFinite(id)) return null

  if (entityType === 'task') {
    const task = await payload.findByID({ collection: 'tasks', id, overrideAccess: true, disableErrors: true }).catch(() => null)
    if (!task) return null
    const workspaceId = typeof task.workspace === 'number' ? task.workspace : task.workspace.id
    const workspace = await payload
      .findByID({ collection: 'workspaces', id: workspaceId, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    return workspace ? `/workspace/${workspace.slug}/tasks?task=${task.id}` : null
  }

  if (entityType === 'page') {
    const page = await payload.findByID({ collection: 'pages', id, overrideAccess: true, disableErrors: true }).catch(() => null)
    if (!page) return null
    const workspaceId = typeof page.workspace === 'number' ? page.workspace : page.workspace.id
    const workspace = await payload
      .findByID({ collection: 'workspaces', id: workspaceId, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    return workspace ? `/workspace/${workspace.slug}/p/${page.id}` : null
  }

  if (entityType === 'run') {
    // Runs live in the broker (raw `pg`), not in Payload. Walk via the owning
    // task to recover the workspace - broker `runs` rows carry `task_id` and
    // `page_id` but not a workspace FK of their own.
    const run = await getRun(id).catch(() => null)
    if (!run?.taskId) return null
    const task = await payload
      .findByID({ collection: 'tasks', id: run.taskId, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    if (!task) return null
    const workspaceId = typeof task.workspace === 'number' ? task.workspace : task.workspace.id
    const workspace = await payload
      .findByID({ collection: 'workspaces', id: workspaceId, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    return workspace ? `/workspace/${workspace.slug}/runs/${run.id}/review` : null
  }

  return null
}

// ---------------------------------------------------------------------------
// Q2 - cross-mode href builders from a known source entity
// ---------------------------------------------------------------------------
//
// Pure sync helpers for the sidebar's ModeSwitcher. Each helper takes the
// source entity (with whatever join fields the caller has already fetched)
// and returns the path tail for the target mode, falling back to the mode
// default when the join field is null rather than erroring (per the design
// doc's "fall back to that mode's default rather than erroring when the
// link doesn't exist").
//
// All return paths RELATIVE to `/workspace/{workspaceSlug}/`, WITHOUT a
// leading slash. Callers prepend `/workspace/{slug}/` (or build a full
// URL via Next's `Link` from a component that already has the slug).
//
// "Self" directions (Task->Plan, Page->Work, Run->Review) always succeed.
// Other directions depend on join fields; the caller is responsible for
// pre-fetching them when the result matters more than the default.

/** Plan-mode default for the workspace root - the tasks list. */
export const PLAN_MODE_DEFAULT = 'tasks'

/** Review-mode default for the workspace root - the review landing list. */
export const REVIEW_MODE_DEFAULT = 'review'

/**
 * Work-mode sub-routes that count as "Work mode" for the purposes of the
 * ModeSwitcher's active-state detection and the sidebar's localStorage
 * "last visited Work sub-route" field. Closed list: adding a new Work
 * surface is a deliberate change, and `workModeDefault` rejects unknown
 * values silently.
 */
export const WORK_MODE_SUBROUTES = ['inbox', 'tasks', 'active-runs'] as const
export type WorkSubRoute = (typeof WORK_MODE_SUBROUTES)[number]

/**
 * Resolve the Work-mode landing route, honoring a remembered preference
 * from the sidebar's localStorage blob when it's one of the known Work
 * sub-routes. Falls back to `inbox` otherwise (or when no preference is
 * supplied). Permissive by design - a stale or tampered localStorage
 * value should never break navigation.
 */
export function workModeDefault(preferred?: string | null): WorkSubRoute {
  return (WORK_MODE_SUBROUTES as readonly string[]).includes(preferred ?? '')
    ? (preferred as WorkSubRoute)
    : 'inbox'
}

/** Task -> Plan: self. The tasks list highlights the row at `?task=:id`. */
export function planHrefForTask(task: { id: number | string }): string {
  return `tasks?task=${task.id}`
}

/**
 * Run -> Plan: the run's owning task (or `tasks` if the run is orphaned).
 * `run.taskId` is the broker-side FK to the Tasks collection.
 */
export function planHrefForRun(run: { taskId?: number | null }): string {
  return run.taskId ? `tasks?task=${run.taskId}` : PLAN_MODE_DEFAULT
}

/**
 * Page -> Plan: the first Tasks-collection row linked to this page (or
 * `tasks`). The caller pre-fetches the task id (typically by querying
 * `Tasks.where({ page: { equals: pageId } })` and taking the first);
 * the helper just shapes the URL.
 */
export function planHrefForPage(opts: {
  firstLinkedTaskId?: number | null
}): string {
  return opts.firstLinkedTaskId ? `tasks?task=${opts.firstLinkedTaskId}` : PLAN_MODE_DEFAULT
}

/**
 * Task -> Work: the task's page (or `inbox`).
 * `task.page` is the optional Tasks-collection FK to Pages.
 */
export function workHrefForTask(task: { page?: number | null }): string {
  return task.page ? `p/${task.page}` : 'inbox'
}

/**
 * Run -> Work: the run's page, then the run's task's page, then `inbox`.
 *
 * - `run.pageId` is populated when the run wrote into a specific page
 *   subtree (see `lib/agent-page-writes.ts`).
 * - `run.taskPageId` is the indirect fallback - the run's task's page,
 *   which is the closest "document this run touched" surrogate when the
 *   run didn't get its own page context. The caller is responsible for
 *   resolving `run.taskId -> task.page` and passing it in.
 */
export function workHrefForRun(run: {
  pageId?: number | null
  taskPageId?: number | null
}): string {
  if (run.pageId) return `p/${run.pageId}`
  if (run.taskPageId) return `p/${run.taskPageId}`
  return 'inbox'
}

/** Page -> Work: self. The page IS the Work surface. */
export function workHrefForPage(page: { id: number | string }): string {
  return `p/${page.id}`
}

/**
 * Task -> Review: the task's latest review-ready run (or `review`).
 * The caller pre-fetches the run id (typically by querying the broker
 * for runs with `task_id = taskId` and `status = 'review_ready'`,
 * newest first); the helper just shapes the URL.
 */
export function reviewHrefForTask(opts: {
  latestReviewReadyRunId?: number | string | null
}): string {
  return opts.latestReviewReadyRunId
    ? `runs/${opts.latestReviewReadyRunId}/review`
    : REVIEW_MODE_DEFAULT
}

/** Run -> Review: self. The review page is the canonical surface for a run. */
export function reviewHrefForRun(run: { id: number | string }): string {
  return `runs/${run.id}/review`
}

/**
 * Page -> Review: the page's latest review-ready run (or `review`).
 * The caller pre-fetches the run id (typically by joining runs to tasks
 * on `Tasks.page = pageId` and filtering to review-ready status).
 */
export function reviewHrefForPage(opts: {
  latestReviewReadyRunId?: number | string | null
}): string {
  return opts.latestReviewReadyRunId
    ? `runs/${opts.latestReviewReadyRunId}/review`
    : REVIEW_MODE_DEFAULT
}
