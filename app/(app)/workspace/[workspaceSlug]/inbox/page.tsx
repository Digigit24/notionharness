import type { ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AlertTriangle, AtSign, FileDiff, ShieldAlert } from 'lucide-react'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { hrefForEntity } from '@/lib/entity-links.server'
import { listPendingApprovalsForUser, type ApprovalDoc } from '@/lib/hermes/approval-helpers'
import { getRun, listFailedRuns, listReviewReadyRuns } from '@/lib/broker'
import type { Run } from '@/lib/broker'
import type { Activity } from '@/payload-types'

// ROADMAP P5.5 — the Inbox home screen. Filters the same underlying data the
// bell already shows into "what needs me" buckets, scoped to the current
// workspace's route (the data itself is cross-workspace — runs and activity
// are attributed per-user, matching the bell's posture; see lib/broker/runs.ts
// for why the inbox reads aren't workspace-filtered).
//
// Four categorized sections:
//   * approvals pending — P5.4's first-class `approvals` collection rows
//     awaiting a human decision, filtered to the current user (source of truth
//     once the producer/deliverable lands; supersedes the run_messages proxy)
//   * failed runs        — broker runs that settled as `failed`
//   * mentions           — activity rows whose action names a mention; no
//     producer emits these yet, so the section reads the spine and lights up
//     the moment a mention-aware producer lands
//   * review-ready       — runs that completed with `file_change` events
//
// Each item deep-links to its source exactly like notifications do (shared
// hrefForEntity): task drawer via `?task=`, page via `/p/`, and a run is
// resolved to its owning task since `run` has no detail route yet (Pillar-4
// territory). Fetch-on-load only — no push, matching the bell's fetch-on-open.
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
        listFailedRuns(userId, 10),
        listReviewReadyRuns(userId, 10),
      ])
    : [[], [], []]

  const mentionActivity = userId
    ? (
        await payload.find({
          collection: 'activity',
          where: { action: { contains: 'mention' } },
          sort: '-createdAt',
          limit: 10,
          overrideAccess: true,
        })
      ).docs
    : []

  const [approvalItems, failedItems, reviewItems, mentionItems] = await Promise.all([
    Promise.all(approvals.map((approval) => approvalToItem(payload, approval))),
    Promise.all(failedRuns.map((run) => runToItem(payload, run))),
    Promise.all(reviewRuns.map((run) => runToItem(payload, run))),
    Promise.all(mentionActivity.map((activity) => activityToItem(payload, activity))),
  ])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
        <header>
          <h1 className="text-2xl font-semibold">Inbox</h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            What needs you across {workspace.name}
          </p>
        </header>

        <InboxSection
          title="Approvals pending"
          icon={<ShieldAlert size={14} />}
          items={approvalItems}
          emptyText="Nothing waiting on your approval."
        />
        <InboxSection
          title="Failed runs"
          icon={<AlertTriangle size={14} />}
          items={failedItems}
          emptyText="No failed runs."
        />
        <InboxSection
          title="Mentions"
          icon={<AtSign size={14} />}
          items={mentionItems}
          emptyText="No mentions yet — someone @mentioning you will show up here."
        />
        <InboxSection
          title="Review-ready"
          icon={<FileDiff size={14} />}
          items={reviewItems}
          emptyText="Nothing ready for review."
        />
      </div>
    </div>
  )
}

interface InboxItem {
  id: string
  headline: string
  subline: string | null
  time: string
  href: string | null
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
    headline: approval.title || 'Approval request',
    subline: approval.detail || options || 'An agent needs your approval to act.',
    time: approval.createdAt,
    href,
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
): Promise<InboxItem> {
  const href = await taskOrNullHref(payload, run)
  const subline =
    run.status === 'failed'
      ? run.error || `Run ${run.id} ended in failure`
      : `Run ${run.id} — files changed, ready for review`
  return {
    id: `run-${run.id}`,
    headline: `Run ${run.id}: ${run.status}`,
    subline,
    time: run.completedAt || run.updatedAt,
    href,
  }
}

async function taskOrNullHref(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  run: { taskId: number | null },
): Promise<string | null> {
  if (run.taskId == null) return null
  return hrefForEntity(payload, 'task', String(run.taskId))
}

async function activityToItem(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  activity: Activity,
): Promise<InboxItem> {
  const actor = activity.actor && typeof activity.actor === 'object' ? activity.actor : null
  const href = await hrefForEntity(payload, activity.entityType, activity.entityId)
  return {
    id: `activity-${activity.id}`,
    headline: `${actor?.name || actor?.email || 'Someone'} ${activity.action} this`,
    subline: `Mentioned you on a ${activity.entityType}`,
    time: activity.createdAt,
    href,
  }
}

function InboxSection({
  title,
  icon,
  items,
  emptyText,
}: {
  title: string
  icon: ReactNode
  items: InboxItem[]
  emptyText: string
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-1.5 text-sm font-medium text-black/60 dark:text-white/60">
        {icon}
        {title}
        {items.length > 0 && (
          <span className="rounded-full bg-black/[.06] px-1.5 py-0.5 text-[10px] font-medium dark:bg-white/[.08]">
            {items.length}
          </span>
        )}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-black/40 dark:text-white/40">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id}>
              {item.href ? (
                <Link
                  href={item.href}
                  className="block rounded-md px-3 py-2 hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                >
                  <InboxRow item={item} />
                </Link>
              ) : (
                <div className="block rounded-md px-3 py-2">
                  <InboxRow item={item} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function InboxRow({ item }: { item: InboxItem }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{item.headline}</p>
        {item.subline && (
          <p className="truncate text-xs text-black/50 dark:text-white/50">{item.subline}</p>
        )}
      </div>
      <span className="shrink-0 text-xs text-black/30 dark:text-white/30">
        {new Date(item.time).toLocaleString()}
      </span>
    </div>
  )
}