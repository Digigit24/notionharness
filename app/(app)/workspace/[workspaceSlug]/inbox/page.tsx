import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { hrefForEntity } from '@/lib/entity-links.server'
import { listPendingApprovalsForUser, type ApprovalDoc } from '@/lib/hermes/approval-helpers'
import { getRun, listFailedRuns, listReviewReadyRuns } from '@/lib/broker'
import type { Run } from '@/lib/broker'
import type { Activity, Notification } from '@/payload-types'
import { InboxList, type InboxItem } from '@/components/inbox/inbox-list'

// ROADMAP B5.2 (Batch B-5 "Attention") — the Inbox home screen, rebuilt to
// meet the plan's own bar: "Chronological, keyboard-navigable, dismissible,
// zero-able — an email client, not a filtered board." P5.5's original
// version (see git history) grouped items into four always-visible
// sections, which is exactly the "filtered board" shape the plan calls out
// as wrong. This version fetches the same four underlying sources —
// pending approvals, failed runs, review-ready runs, and mentions — but
// merges them into ONE time-ordered list; each row still shows its type via
// an icon (rendered client-side by InboxList), but there are no section
// boundaries a user has to scan past.
//
// Mentions now read the `notifications` collection (filtered to `user` +
// `isRead: false`, matching the bell) instead of querying `activity`
// directly with no user scoping at all — the old query showed literally
// every mention-shaped activity row in the system to every user, which was
// a real bug, not a deliberate simplification. Still honestly empty today:
// no producer anywhere in this codebase emits a `mention`-shaped `action`
// yet (confirmed via a repo-wide grep), so this section lights up the
// moment one does, exactly as the prior version's comment already promised.
//
// Dismissal ("zero-able") differs by item kind, per the plan's own framing:
//   - approval    — already resolved once answered (approve/deny); it simply
//                    stops being 'pending' and drops out of the next fetch.
//   - failed_run / review_run — a run has no prior "acknowledged" concept
//                    (checked lib/broker/types.ts before assuming one), so
//                    this batch adds `runs.dismissed_at` (a real column,
//                    written as lib/broker/migrations/0006_run_dismissed_at.sql,
//                    NOT applied — same discipline as every other schema
//                    change this session) and both broker queries below now
//                    filter it out.
//   - mention     — dismissed by marking its backing notification read,
//                    exactly like opening it does (both call
//                    dismissMentionInbox/markNotificationsRead).
export default async function InboxPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()
  const currentUser = await getCurrentPayloadUser()
  const userId = currentUser?.id ?? null

  const [approvals, failedRuns, reviewRuns] = userId
    ? await Promise.all([
        listPendingApprovalsForUser(userId).catch(() => []),
        listFailedRuns(userId, 25),
        listReviewReadyRuns(userId, 25),
      ])
    : [[], [], []]

  const mentionNotifications = userId
    ? (
        await payload.find({
          collection: 'notifications',
          where: { user: { equals: userId }, isRead: { equals: false } },
          sort: '-createdAt',
          limit: 50,
          depth: 1,
          overrideAccess: true,
        })
      ).docs.filter((n) => {
        const activity = typeof n.activity === 'object' && n.activity ? n.activity : null
        return Boolean(activity?.action?.toLowerCase().includes('mention'))
      })
    : []

  const [approvalItems, failedItems, reviewItems, mentionItems] = await Promise.all([
    Promise.all(approvals.map((approval) => approvalToItem(payload, approval))),
    Promise.all(failedRuns.map((run) => runToItem(payload, run, 'failed_run'))),
    Promise.all(reviewRuns.map((run) => runToItem(payload, run, 'review_run'))),
    Promise.all(mentionNotifications.map((n) => mentionToItem(payload, n))),
  ])

  const items: InboxItem[] = [...approvalItems, ...failedItems, ...reviewItems, ...mentionItems].sort(
    (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime(),
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full flex-col gap-4 px-5 py-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Inbox</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {items.length === 0
                ? `Nothing waiting in ${workspace.name}.`
                : `${items.length} item${items.length === 1 ? '' : 's'} need you across ${workspace.name} — newest first.`}
            </p>
            {/* The list already registers these; nothing told anyone they
                existed. */}
            {items.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                <kbd className="rounded border border-black/10 px-1 dark:border-white/15">j</kbd>/
                <kbd className="rounded border border-black/10 px-1 dark:border-white/15">k</kbd> to move ·{' '}
                <kbd className="rounded border border-black/10 px-1 dark:border-white/15">y</kbd> approve ·{' '}
                <kbd className="rounded border border-black/10 px-1 dark:border-white/15">n</kbd> deny ·{' '}
                <kbd className="rounded border border-black/10 px-1 dark:border-white/15">e</kbd> dismiss
              </p>
            )}
          </div>
          {/* A plain anchor here forced a full document reload out of an app
              that is otherwise entirely client-navigated. */}
          <Link href="/settings/notifications" className="mt-1 shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline">
            Notification settings
          </Link>
        </header>

        <InboxList items={items} workspaceSlug={workspaceSlug} />
      </div>
    </div>
  )
}

async function approvalToItem(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  approval: ApprovalDoc,
): Promise<InboxItem> {
  const href = await taskForApprovalHref(payload, approval)
  const options =
    approval.options.length > 0
      ? approval.options.map((o) => o.label ?? o.optionId).join(' · ')
      : null
  return {
    id: `approval-${approval.id}`,
    kind: 'approval',
    headline: approval.title || 'Approval request',
    subline: approval.detail || options || 'An agent needs your approval to act.',
    time: approval.createdAt,
    href,
    approvalId: approval.id,
    approvalOptions: approval.options,
  }
}

async function taskForApprovalHref(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  approval: ApprovalDoc,
): Promise<string | null> {
  if (approval.runId == null) return null
  const run = await getRun(approval.runId)
  if (!run || run.taskId == null) return null
  return hrefForEntity(payload, 'task', String(run.taskId))
}

async function runToItem(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  run: Run,
  kind: 'failed_run' | 'review_run',
): Promise<InboxItem> {
  const href = await taskOrNullHref(payload, run)
  const subline =
    kind === 'failed_run'
      ? run.error || `Run ${run.id} ended in failure`
      : `Run ${run.id} — files changed, ready for review`
  return {
    id: `run-${kind}-${run.id}`,
    kind,
    headline: `Run ${run.id}: ${run.status}`,
    subline,
    time: run.completedAt || run.updatedAt,
    href,
    runId: run.id,
    canRetry: kind === 'failed_run' && run.agentId != null,
  }
}

async function taskOrNullHref(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  run: { taskId: number | null },
): Promise<string | null> {
  if (run.taskId == null) return null
  return hrefForEntity(payload, 'task', String(run.taskId))
}

async function mentionToItem(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  notification: Notification,
): Promise<InboxItem> {
  const activity: Activity | null = typeof notification.activity === 'object' ? notification.activity : null
  const actor = activity && typeof activity.actor === 'object' && activity.actor ? activity.actor : null
  const href = activity ? await hrefForEntity(payload, activity.entityType, activity.entityId) : null
  return {
    id: `mention-${notification.id}`,
    kind: 'mention',
    headline: `${actor?.name || actor?.email || 'Someone'} ${activity?.action ?? 'mentioned you'}`,
    subline: activity ? `Mentioned you on a ${activity.entityType}` : notification.message || 'You were mentioned.',
    time: notification.createdAt,
    href,
    notificationId: notification.id,
  }
}
