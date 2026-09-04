import type { ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Where } from 'payload'
import { AlertTriangle, AtSign, CircleDollarSign, FileDiff, FileText, ShieldAlert } from 'lucide-react'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { listPendingApprovalsForUser } from '@/lib/hermes/approval-helpers'
import {
  listActiveRunsForWorkspace,
  listFailedRuns,
  listReviewReadyRuns,
  listRecentPageRunsForWorkspace,
  getWorkspaceUsageRollup,
  hasAnyRunForWorkspace,
} from '@/lib/broker'
import type { Run } from '@/lib/broker'
import { formatCount, formatRelativeTime } from '@/lib/relative-time'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { NewPageButton } from '@/components/canvas/new-page-button'
import { RecentPagesSection } from '@/components/home/recent-pages-section'
import { FirstRunChecklist } from '@/components/home/first-run-checklist'
import { SeedStarterWorkspaceButton } from '@/components/home/seed-starter-workspace-button'

// ROADMAP B5.1 — "not a board. The workspace root should answer, in order:
// what needs me, what is happening right now, what I was doing, and what it
// is costing." Replaces the old page-tree landing screen entirely; the
// page-tree browsing job now belongs to the Sidebar alone.
//
// "What needs me" is deliberately a *digest* of the Inbox (one row per
// category with a count), not a reimplementation of it — it reuses the exact
// same data-fetching calls app/(app)/workspace/[workspaceSlug]/inbox/page.tsx
// makes (listPendingApprovalsForUser / listFailedRuns / listReviewReadyRuns /
// the `activity` mention query) rather than re-querying from scratch, and
// every row links into the real Inbox for the full list.
export default async function WorkspaceHome({
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

  const myTasksWhere: Where = {
    and: [
      { workspace: { equals: workspace.id } },
      { or: [{ assignee: { equals: userId } }, { createdBy: { equals: userId } }] },
    ],
  }

  const [
    approvals,
    failedRuns,
    reviewRuns,
    mentionActivity,
    activeRuns,
    recentTasks,
    recentThreadRuns,
    usage7d,
    pageCount,
    taskCount,
    enabledAgentCount,
    enabledRuntimeProfileCount,
    hasAnyRun,
  ] = await Promise.all([
    userId ? listPendingApprovalsForUser(userId).catch(() => []) : Promise.resolve([]),
    userId ? listFailedRuns(userId, 5) : Promise.resolve([]),
    userId ? listReviewReadyRuns(userId, 5) : Promise.resolve([]),
    userId
      ? payload
          .find({
            collection: 'activity',
            where: { action: { contains: 'mention' } },
            sort: '-createdAt',
            limit: 5,
            overrideAccess: true,
          })
          .then((r) => r.docs)
      : Promise.resolve([]),
    listActiveRunsForWorkspace(workspace.id),
    userId
      ? payload
          .find({ collection: 'tasks', where: myTasksWhere, sort: '-updatedAt', limit: 5, overrideAccess: true })
          .then((r) => r.docs)
      : Promise.resolve([]),
    listRecentPageRunsForWorkspace(workspace.id, 5),
    getWorkspaceUsageRollup(workspace.id, 7),
    // ROADMAP B8.5 — "a fresh workspace currently shows nothing" detection.
    // Real existence counts (`totalDocs` from a 1-row find, the standard
    // cheap-count pattern the rest of this file already uses), not a guess.
    payload.find({ collection: 'pages', where: { workspace: { equals: workspace.id } }, limit: 1, overrideAccess: true }).then((r) => r.totalDocs),
    payload.find({ collection: 'tasks', where: { workspace: { equals: workspace.id } }, limit: 1, overrideAccess: true }).then((r) => r.totalDocs),
    payload.find({ collection: 'agents', where: { workspace: { equals: workspace.id }, enabled: { equals: true } }, limit: 1, overrideAccess: true }).then((r) => r.totalDocs),
    payload.find({ collection: 'runtime-profiles', where: { workspace: { equals: workspace.id }, enabled: { equals: true } }, limit: 1, overrideAccess: true }).then((r) => r.totalDocs),
    hasAnyRunForWorkspace(workspace.id),
  ])

  // Genuinely empty = no pages, no tasks, and no runs ever — not merely
  // "nothing needs *this* user right now" (that's already handled per-section
  // above). A workspace with real content but nothing currently needing
  // attention should keep seeing its normal home, not an onboarding checklist.
  const isGenuinelyEmpty = pageCount === 0 && taskCount === 0 && !hasAnyRun

  // Batch-resolve display names for the live-runs and recent-threads rows —
  // one query per entity kind across every run, not one query per row.
  const agentIds = uniqueIds(activeRuns.map((r) => r.agentId))
  const taskIds = uniqueIds(activeRuns.map((r) => r.taskId))
  const pageIds = uniqueIds([...activeRuns.map((r) => r.pageId), ...recentThreadRuns.map((r) => r.pageId)])

  const [agents, tasksForRuns, pagesForRuns] = await Promise.all([
    agentIds.length
      ? payload.find({ collection: 'agents', where: { id: { in: agentIds } }, limit: agentIds.length, depth: 0, overrideAccess: true }).then((r) => r.docs)
      : Promise.resolve([]),
    taskIds.length
      ? payload.find({ collection: 'tasks', where: { id: { in: taskIds } }, limit: taskIds.length, depth: 0, overrideAccess: true }).then((r) => r.docs)
      : Promise.resolve([]),
    pageIds.length
      ? payload.find({ collection: 'pages', where: { id: { in: pageIds } }, limit: pageIds.length, depth: 0, overrideAccess: true }).then((r) => r.docs)
      : Promise.resolve([]),
  ])

  const agentById = new Map(agents.map((a) => [a.id, a]))
  const taskById = new Map(tasksForRuns.map((t) => [t.id, t]))
  const pageById = new Map(pagesForRuns.map((p) => [p.id, p]))

  const needsMeCategories = [
    {
      key: 'approvals',
      label: 'Approvals pending',
      icon: <ShieldAlert size={14} />,
      count: approvals.length,
      latest: approvals[0]?.title ?? null,
    },
    {
      key: 'failed',
      label: 'Failed runs',
      icon: <AlertTriangle size={14} />,
      count: failedRuns.length,
      latest: failedRuns[0] ? `Run ${failedRuns[0].id}: ${failedRuns[0].error || 'ended in failure'}` : null,
    },
    {
      key: 'review',
      label: 'Review-ready',
      icon: <FileDiff size={14} />,
      count: reviewRuns.length,
      latest: reviewRuns[0] ? `Run ${reviewRuns[0].id} — files changed` : null,
    },
    {
      key: 'mentions',
      label: 'Mentions',
      icon: <AtSign size={14} />,
      count: mentionActivity.length,
      latest: mentionActivity[0] ? `Someone mentioned you` : null,
    },
  ]
  const totalNeedsMe = needsMeCategories.reduce((sum, c) => sum + c.count, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full flex-col gap-8 px-5 py-8">
        <header>
          <h1 className="text-2xl font-semibold">{workspace.name}</h1>
        </header>

        {/* ROADMAP B8.5 — first-run checklist, only on a genuinely empty
            workspace (see `isGenuinelyEmpty` above). An active workspace
            with real content doesn't need to be told how to get started,
            even on a day nothing happens to need this user's attention. */}
        {isGenuinelyEmpty && (
          <div className="flex flex-col gap-2">
            <FirstRunChecklist
              workspaceSlug={workspace.slug}
              status={{
                hasEnabledRuntimeProfile: enabledRuntimeProfileCount > 0,
                hasEnabledAgent: enabledAgentCount > 0,
                hasAnyRun,
              }}
            />
            <SeedStarterWorkspaceButton workspaceId={workspace.id} workspaceSlug={workspace.slug} />
          </div>
        )}

        {/* What needs me */}
        <Section title="What needs me" href={`/workspace/${workspace.slug}/inbox`} hrefLabel="Open Inbox">
          {totalNeedsMe === 0 ? (
            <EmptyState
              title="Nothing needs you right now."
              description="Approvals, failed runs, review-ready work, and mentions will show up here the moment something does."
              action={{ label: 'Open Inbox', href: `/workspace/${workspace.slug}/inbox` }}
              className="py-6"
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {needsMeCategories.map((cat) => (
                <li key={cat.key}>
                  <Link
                    href={`/workspace/${workspace.slug}/inbox`}
                    className="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <span className="shrink-0 text-black/50 dark:text-white/50">{cat.icon}</span>
                      <span className="font-medium">{cat.label}</span>
                      {cat.latest && <span className="truncate text-black/40 dark:text-white/40">— {cat.latest}</span>}
                    </span>
                    <Badge variant={cat.count > 0 ? 'destructive' : 'outline'} className="shrink-0">
                      {cat.count}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* What is happening right now */}
        <Section title="What is happening right now" href={`/workspace/${workspace.slug}/active-runs`} hrefLabel="View active runs">
          {activeRuns.length === 0 ? (
            <EmptyState
              title="Nothing running right now."
              description="Start a run from a task or a page and it'll show up here while it works."
              action={{ label: 'Go to Tasks', href: `/workspace/${workspace.slug}/tasks` }}
              className="py-6"
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {activeRuns.map((run) => {
                const agentName = run.agentId != null ? agentById.get(run.agentId)?.name : null
                const target = describeRunTarget(run, taskById, pageById)
                return (
                  <li key={run.id}>
                    <Link
                      href={`/workspace/${workspace.slug}/runs/${run.id}/review`}
                      className="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                    >
                      <span className="flex min-w-0 items-center gap-2 text-sm">
                        <span className="inline-flex size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                        <span className="font-medium">{agentName || 'Agent'}</span>
                        <span className="truncate text-black/40 dark:text-white/40">
                          {target ? `— ${target}` : `— run ${run.id}`}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-black/40 dark:text-white/40">
                        {formatRelativeTime(run.startedAt || run.createdAt)}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>

        {/* What I was doing */}
        <Section title="What I was doing">
          <div className="flex flex-col gap-5">
            <SubSection title="Recent pages">
              <RecentPagesSection workspaceSlug={workspace.slug} workspaceId={workspace.id} />
            </SubSection>

            <SubSection title="Recent tasks">
              {recentTasks.length === 0 ? (
                <EmptyState
                  title="No tasks assigned to you yet."
                  description="Tasks you're assigned to or created will show up here."
                  action={{ label: 'Go to Tasks', href: `/workspace/${workspace.slug}/tasks` }}
                  className="py-6"
                />
              ) : (
                <ul className="flex flex-col gap-1">
                  {recentTasks.map((task) => (
                    <li key={task.id}>
                      <Link
                        href={`/workspace/${workspace.slug}/tasks?task=${task.id}`}
                        className="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                      >
                        <span className="truncate text-sm">{task.title || 'Untitled'}</span>
                        <span className="shrink-0 text-xs text-black/30 dark:text-white/30">
                          {formatRelativeTime(task.updatedAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </SubSection>

            <SubSection title="Recent Ask threads">
              {recentThreadRuns.length === 0 ? (
                <EmptyState
                  title="No Ask threads yet."
                  description="Ask a question from inside any page and the thread will show up here."
                  className="py-6"
                >
                  <NewPageButton workspaceId={workspace.id} workspaceSlug={workspace.slug} />
                </EmptyState>
              ) : (
                <ul className="flex flex-col gap-1">
                  {recentThreadRuns.map((run) => {
                    const page = run.pageId != null ? pageById.get(run.pageId) : null
                    return (
                      <li key={run.id}>
                        <Link
                          href={run.pageId != null ? `/workspace/${workspace.slug}/p/${run.pageId}` : `/workspace/${workspace.slug}/runs/${run.id}/review`}
                          className="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                        >
                          <span className="flex min-w-0 items-center gap-2 truncate text-sm">
                            <FileText size={14} className="shrink-0 text-black/40 dark:text-white/40" />
                            {page?.title || 'Untitled page'}
                          </span>
                          <span className="shrink-0 text-xs text-black/30 dark:text-white/30">
                            {formatRelativeTime(run.updatedAt)}
                          </span>
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              )}
            </SubSection>
          </div>
        </Section>

        {/* What it is costing */}
        <section id="what-it-is-costing" className="flex flex-col gap-2 scroll-mt-8">
          <h2 className="text-sm font-medium text-black/60 dark:text-white/60">
            <Link href={`/workspace/${workspace.slug}/settings/health`} className="hover:underline">
              What it is costing
            </Link>
          </h2>
          <Card>
            <CardContent className="flex items-center gap-3 py-2">
              <CircleDollarSign size={18} className="shrink-0 text-black/40 dark:text-white/40" />
              <div>
                <p className="text-lg font-semibold tabular-nums">${(usage7d.totalCostTicks / 100).toFixed(2)}</p>
                {/* `runCount` and `totalTokens` were already fetched and
                    thrown away. A cost with no denominator answers "how
                    much" but never "how much per run", which is the
                    question anyone actually asks next. */}
                <p className="text-xs text-black/40 dark:text-white/40">
                  {formatCount(usage7d.runCount)} run{usage7d.runCount === 1 ? '' : 's'} ·{' '}
                  {formatCount(usage7d.totalTokens)} tokens · last 7 days
                </p>
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  )
}

function Section({
  title,
  href,
  hrefLabel,
  children,
}: {
  title: string
  href?: string
  hrefLabel?: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-black/60 dark:text-white/60">{title}</h2>
        {href && (
          <Link href={href} className="text-xs text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70">
            {hrefLabel ?? 'View all'}
          </Link>
        )}
      </div>
      <Card>
        <CardContent className="py-1">{children}</CardContent>
      </Card>
    </section>
  )
}

function SubSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="px-1 text-xs font-medium text-black/40 dark:text-white/40">{title}</h3>
      {children}
    </div>
  )
}

function uniqueIds(ids: Array<number | null>): number[] {
  return [...new Set(ids.filter((id): id is number => id != null))]
}

function describeRunTarget(
  run: Run,
  taskById: Map<number, { title: string }>,
  pageById: Map<number, { title: string }>,
): string | null {
  if (run.taskId != null) {
    return taskById.get(run.taskId)?.title || `Task #${run.taskId}`
  }
  if (run.pageId != null) {
    return pageById.get(run.pageId)?.title || `Page #${run.pageId}`
  }
  return null
}


