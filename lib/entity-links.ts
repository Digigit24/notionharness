// ROADMAP P6.5 - client-safe cross-mode link helpers for the sidebar's
// ModeSwitcher. NO server-only imports allowed in this file - it must
// stay bundled for the browser.
//
// The async activity-entity -> deep-link resolver (`hrefForEntity`,
// uses `getPayloadClient` + the raw `pg` broker) lives in the sibling
// server-only file `lib/entity-links.server.ts`, which carries the
// `.server.ts` suffix so Next.js's bundler excludes it from client
// graphs even if someone tries to import it from a client component.
//
// Imported by:
//   - components/sidebar/sidebar.tsx      (client component)
//   - components/sidebar/mode-switcher.tsx (client component)
//
// Helpers in this file all return paths RELATIVE to
// `/workspace/{workspaceSlug}/`, WITHOUT a leading slash. Callers
// prepend `/workspace/{slug}/` (or build a full URL via Next's
// `Link` from a component that already has the slug).
//
// Per the design doc's "fall back to that mode's default rather than
// erroring when the link doesn't exist" contract, every helper that
// depends on a join field (e.g. `task.page`, `run.taskId`) falls back
// to the mode default when that field is null. Self directions
// (`planHrefForTask` is the only "self" one for tasks, etc.) always
// succeed.

/**
 * Plan-mode default for the workspace root - the workspace landing page
 * (`app/(app)/workspace/[workspaceSlug]/page.tsx`). Per the design doc's
 * Q2 ("Tasks.page not set -> Plan's default (workspace root / last-viewed
 * page), not an error"), the empty tail means the workspace landing,
 * which lists top-level pages for the user to pick from.
 *
 * Distinct from `'inbox'` and `'tasks'`, both of which are Work-mode
 * routes per the design doc's mode table:
 *   Plan = doc editor (/p/[pageId])
 *   Work = inbox + task board (/inbox, /tasks)
 *   Review = review panels (/runs/[runId]/review)
 *
 * Empty string rather than a sentinel string - callers build the href
 * as `/workspace/{slug}` (no trailing tail) directly.
 */
export const PLAN_MODE_DEFAULT = ''

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

/**
 * Task -> Plan: the task's linked page editor (or Plan's default - the
 * workspace landing - when the task has no linked page yet).
 *
 * `task.page` is the Tasks-collection FK to Pages, populated lazily by
 * `ensureTaskPage` the first time an agent run writes into the task's
 * document (P6.1). Most tasks today have no linked page yet, so this
 * falls through to PLAN_MODE_DEFAULT in the common case.
 *
 * Result is always a Plan-mode URL: `/p/{id}` or the workspace root.
 */
export function planHrefForTask(task: { page?: number | null }): string {
  return task.page ? `p/${task.page}` : PLAN_MODE_DEFAULT
}

/**
 * Run -> Plan: the run's task's linked page editor, or - for page-scoped
 * runs - `run.pageId` directly, or Plan's default when neither is set.
 *
 * Per design Q2: "Review (run R) -> Plan: R's taskId's linked page, or -
 * for page-scoped runs - `run.pageId` directly -> that page's editor."
 *
 * Caller is responsible for resolving `run.taskId -> task.page` and
 * passing the result as `taskPageId`; the helper just picks the right
 * Plan-mode URL tail. Result is always a Plan-mode URL: `/p/{id}` or
 * the workspace root.
 */
export function planHrefForRun(run: {
  taskPageId?: number | null
  pageId?: number | null
}): string {
  if (run.taskPageId) return `p/${run.taskPageId}`
  if (run.pageId) return `p/${run.pageId}`
  return PLAN_MODE_DEFAULT
}

/**
 * Page -> Plan: self. The page IS the Plan surface - clicking the Plan
 * pill while on a page keeps you on that page.
 */
export function planHrefForPage(page: { id: number | string }): string {
  return `p/${page.id}`
}

/**
 * Task -> Work: self. The task's drawer over the tasks board, with the
 * row highlighted via the existing `?task=` query convention. The
 * tasks board IS the Work surface for a task - clicking the Work pill
 * while looking at a task keeps you on it.
 */
export function workHrefForTask(task: { id: number | string }): string {
  return `tasks?task=${task.id}`
}

/**
 * Run -> Work: the run's owning task's drawer, or `null` for page-scoped
 * runs (no taskId) to signal "Work has nothing to show this run -
 * falls through to Plan instead".
 *
 * Per design Q2: "Review (run R) -> Work: R's taskId -> that task's
 * drawer. R has no task (a page-scoped run, P6.1/6.2) -> falls through
 * to Plan instead, since Work has nothing to show it."
 *
 * Returning `null` rather than a Plan URL is deliberate - the helper
 * stays in its lane as a Work-mode resolver, and the caller (mode
 * switcher) is responsible for picking the right fallback. The Work
 * segment on a page-scoped run should NOT link to a page editor.
 */
export function workHrefForRun(run: {
  taskId?: number | null
}): string | null {
  return run.taskId ? `tasks?task=${run.taskId}` : null
}

/**
 * Page -> Work: the first Tasks-collection row linked to this page (or
 * Work's default `/inbox` when the page has no linked task yet).
 *
 * Per design Q2: "Plan (page P) -> Work: if the current page has a task
 * pointing at it (`Tasks.page` reverse lookup), land on that task's
 * drawer (`/tasks?task={id}`). No linked task -> land on Work mode's
 * default."
 *
 * Caller pre-fetches the task id (typically by querying
 * `Tasks.where({ page: { equals: pageId } })` and taking the first).
 */
export function workHrefForPage(opts: {
  firstLinkedTaskId?: number | null
}): string {
  return opts.firstLinkedTaskId ? `tasks?task=${opts.firstLinkedTaskId}` : 'inbox'
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
