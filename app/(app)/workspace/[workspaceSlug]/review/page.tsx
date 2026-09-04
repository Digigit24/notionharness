import Link from 'next/link'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { listReviewReadyRuns } from '@/lib/broker/runs'
import type { Run, RunStatus } from '@/lib/broker/types'
import { formatRelativeTime } from '@/lib/relative-time'

/**
 * ROADMAP P6.5 - Review mode's workspace-root landing list.
 *
 * Lists every review-ready run for the current user in a single page so
 * the Review mode pill has somewhere to land when you click it from
 * /inbox, /tasks, /active-runs, or any non-Review surface. Each row
 * deep-links into the existing `/runs/:runId/review` review panel
 * (unchanged by P6.5 - reused per the design).
 *
 * Built on the same `listReviewReadyRuns` primitive the Inbox page
 * already uses, but with a higher limit and no per-row "first 12"
 * truncation. Status badge + task title + agent name + branch are
 * mirrored from the Inbox card so users see the same information in
 * both surfaces.
 *
 * Auth + workspace validity are enforced by the parent WorkspaceLayout;
 * by the time this page renders, `workspaceSlug` is valid and the
 * current user is non-null.
 */

// 50 is generous for the visible viewport but keeps the page useful as
// a backlog without forcing pagination yet. P6.5 is intentionally not
// adding pagination here - revisit when review-ready counts per user
// cross ~50 in practice.
const REVIEW_PAGE_LIMIT = 50

export default async function ReviewLandingPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params

  const payload = await getPayloadClient()
  const user = await getCurrentPayloadUser()

  // Defensive: if the user record is gone (expired session, deleted in
  // another tab) fall back to an empty list rather than crashing the
  // route. The layout's auth boundary is the source of truth.
  const userId = typeof user === 'object' && user !== null && 'id' in user ? Number(user.id) : null
  if (userId === null || !Number.isFinite(userId)) {
    return <ReviewEmptyState workspaceSlug={workspaceSlug} />
  }

  // Pull every review-ready run for this user. listReviewReadyRuns is
  // already user-scoped (joins via the agent owner) and ordered by
  // review-ready timestamp desc, so the first page of results is the
  // freshest backlog - exactly what the Review landing should show.
  const runs = await listReviewReadyRuns(userId, REVIEW_PAGE_LIMIT).catch(() => [])

  // Resolve task titles in one batched Payload query rather than N+1.
  // The list of review-ready runs is per-user (broker join), but task
  // titles live in Payload and are loaded in a single `id IN (...)`
  // lookup.
  const taskIds = Array.from(
    new Set(
      runs
        .map((r) => r.taskId)
        .filter((id): id is number => typeof id === 'number'),
    ),
  )
  const tasksRes = taskIds.length > 0
    ? await payload
        .find({
          collection: 'tasks',
          where: { id: { in: taskIds } },
          limit: taskIds.length,
          overrideAccess: true,
          depth: 0,
        })
        .catch(() => null)
    : null
  const taskTitleById = new Map<number, string>(
    (tasksRes?.docs ?? []).map((t) => [t.id, t.title ?? '(untitled)']),
  )

  // Agent and page were being printed as `#12` and `#33` — the raw database
  // ids, which name nothing. The batched-lookup pattern was already right
  // here for task titles; these two just never got the same treatment.
  const agentIds = [...new Set(runs.map((r) => r.agentId).filter((id): id is number => id != null))]
  const pageIds = [...new Set(runs.map((r) => r.pageId).filter((id): id is number => id != null))]
  const [agentsRes, pagesRes] = await Promise.all([
    agentIds.length
      ? payload
          .find({ collection: 'agents', where: { id: { in: agentIds } }, limit: agentIds.length, depth: 0, overrideAccess: true })
          .catch(() => null)
      : Promise.resolve(null),
    pageIds.length
      ? payload
          .find({ collection: 'pages', where: { id: { in: pageIds } }, limit: pageIds.length, depth: 0, overrideAccess: true })
          .catch(() => null)
      : Promise.resolve(null),
  ])
  const agentNameById = new Map<number, string>(
    (agentsRes?.docs ?? []).map((a) => [a.id, a.name ?? '(unnamed agent)']),
  )
  const pageTitleById = new Map<number, string>(
    (pagesRes?.docs ?? []).map((pg) => [pg.id, pg.title ?? 'Untitled']),
  )

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review</h1>
          <p className="text-sm text-[var(--nf-fg-muted,#6b7280)]">
            Runs waiting for human review. Click a row to open the review panel.
          </p>
        </div>
        <div className="text-xs text-[var(--nf-fg-muted,#6b7280)]">
          {runs.length === 0
            ? 'No review-ready runs'
            : `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`}
        </div>
      </header>

      {runs.length === 0 ? (
        <ReviewEmptyState workspaceSlug={workspaceSlug} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {runs.map((run) => (
            <ReviewRunCard
              key={run.id}
              workspaceSlug={workspaceSlug}
              run={run}
              taskTitle={run.taskId ? taskTitleById.get(run.taskId) ?? null : null}
              agentName={run.agentId ? agentNameById.get(run.agentId) ?? null : null}
              pageTitle={run.pageId ? pageTitleById.get(run.pageId) ?? null : null}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ReviewRunCard({
  workspaceSlug,
  run,
  taskTitle,
  agentName,
  pageTitle,
}: {
  workspaceSlug: string
  run: Run
  taskTitle: string | null
  agentName: string | null
  pageTitle: string | null
}) {
  const taskHref = run.taskId
    ? `/workspace/${workspaceSlug}/tasks?task=${run.taskId}`
    : null
  const reviewHref = `/workspace/${workspaceSlug}/runs/${run.id}/review`

  return (
    <li className="group relative flex flex-col gap-2 rounded-lg border border-[var(--nf-border,#e5e7eb)] bg-[var(--nf-surface,#fff)] p-4 transition-colors hover:border-[var(--nf-border-strong,#d1d5db)]">
      <div className="flex items-start justify-between gap-2">
        <RunStatusBadge status={run.status} />
        <span className="text-xs text-[var(--nf-fg-muted,#6b7280)]">
          #{run.id}
        </span>
      </div>

      {taskHref && taskTitle ? (
        <Link
          href={taskHref}
          className="line-clamp-2 text-sm font-medium text-[var(--nf-fg,#111827)] hover:underline"
        >
          {taskTitle}
        </Link>
      ) : (
        <span className="line-clamp-2 text-sm font-medium text-[var(--nf-fg-muted,#9ca3af)]">
          {taskTitle ?? '(no linked task)'}
        </span>
      )}

      <p className="text-xs text-[var(--nf-fg-muted,#9ca3af)]">
        {formatRelativeTime(run.completedAt ?? run.updatedAt)}
      </p>

      <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-[var(--nf-fg-muted,#6b7280)]">
        {run.agentId !== null && run.agentId !== undefined ? (
          <>
            <dt>Agent</dt>
            <dd className="truncate">{agentName ?? `#${run.agentId}`}</dd>
          </>
        ) : null}
        {run.pageId !== null && run.pageId !== undefined ? (
          <>
            <dt>Page</dt>
            <dd className="truncate">
              <Link href={`/workspace/${workspaceSlug}/p/${run.pageId}`} className="hover:underline">
                {pageTitle ?? `#${run.pageId}`}
              </Link>
            </dd>
          </>
        ) : null}
      </dl>

      <Link
        href={reviewHref}
        className="mt-1 inline-flex items-center gap-1 self-start rounded-md border border-[var(--nf-border,#e5e7eb)] bg-[var(--nf-surface,#fff)] px-3 py-1.5 text-xs font-medium text-[var(--nf-fg,#111827)] transition-colors hover:bg-[var(--nf-surface-muted,#f9fafb)]"
      >
        Start review →
      </Link>
    </li>
  )
}

function RunStatusBadge({ status }: { status: RunStatus }) {
  // status is a string literal type from lib/broker/types; fall through
  // to a neutral chip when an unknown status slips through (broker
  // schema evolution).
  const palette: Record<string, string> = {
    review_ready:
      'bg-[var(--nf-accent-soft,#ecfeff)] text-[var(--nf-accent,#0e7490)] border-[var(--nf-accent-border,#a5f3fc)]',
    review_approved:
      'bg-[var(--nf-success-soft,#ecfdf5)] text-[var(--nf-success,#047857)] border-[var(--nf-success-border,#a7f3d0)]',
    review_rejected:
      'bg-[var(--nf-danger-soft,#fef2f2)] text-[var(--nf-danger,#b91c1c)] border-[var(--nf-danger-border,#fecaca)]',
  }
  const colors = palette[status] ?? 'bg-[var(--nf-surface-muted,#f3f4f6)] text-[var(--nf-fg-muted,#6b7280)] border-[var(--nf-border,#e5e7eb)]'
  const label = status.replace(/_/g, ' ')
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${colors}`}
    >
      {label}
    </span>
  )
}

function ReviewEmptyState({ workspaceSlug }: { workspaceSlug: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--nf-border,#e5e7eb)] bg-[var(--nf-surface-muted,#f9fafb)] p-12 text-center">
      <h2 className="text-base font-medium text-[var(--nf-fg,#111827)]">Nothing to review right now</h2>
      <p className="max-w-md text-sm text-[var(--nf-fg-muted,#6b7280)]">
        When an agent run finishes and is ready for human review, it will appear here. In the
        meantime, the inbox and tasks board are good places to find what needs your attention.
      </p>
      <div className="flex gap-2 pt-1">
        <Link
          href={`/workspace/${workspaceSlug}/inbox`}
          className="rounded-md border border-[var(--nf-border,#e5e7eb)] bg-[var(--nf-surface,#fff)] px-3 py-1.5 text-xs font-medium text-[var(--nf-fg,#111827)] hover:bg-[var(--nf-surface-muted,#f9fafb)]"
        >
          Go to inbox
        </Link>
        <Link
          href={`/workspace/${workspaceSlug}/tasks`}
          className="rounded-md border border-[var(--nf-border,#e5e7eb)] bg-[var(--nf-surface,#fff)] px-3 py-1.5 text-xs font-medium text-[var(--nf-fg,#111827)] hover:bg-[var(--nf-surface-muted,#f9fafb)]"
        >
          Go to tasks
        </Link>
      </div>
    </div>
  )
}
