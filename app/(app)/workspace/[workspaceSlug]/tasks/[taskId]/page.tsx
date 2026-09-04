import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getChannelMessage, getRunUsageTotals, getTaskUsageTotals, listRunsForTask } from '@/lib/broker'
import { loadRunReview } from '@/lib/run-worktrees/review'
import { TaskDetailView, type ChangeSummary } from '@/components/tasks/task-detail-view'
import { getTaskActivity } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import { listSubtasks, listTaskComments } from './actions'
import { unwrap } from '@/lib/failures'
import type { Agent, Page, Project, TaskStatus, User } from '@/payload-types'

// ROADMAP B-1 "Detail" — full-bleed task detail. The drawer (task-drawer.tsx)
// stays exactly as-is for a quick peek from the board; this route is the
// destination for "give this content more room" per the plan text
// ("drawer retained for quick peek from board"). Built on `<DetailLayout>`
// (B-0), same pattern as the run review page.
export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; taskId: string }>
}) {
  const { workspaceSlug, taskId: taskIdParam } = await params
  const taskId = Number(taskIdParam)
  if (!Number.isFinite(taskId)) notFound()

  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()
  const task = await payload.findByID({
    collection: 'tasks',
    id: taskId,
    depth: 1,
    overrideAccess: true,
    disableErrors: true,
  })
  if (!task) notFound()

  // The task's document (ROADMAP 6.1) — populated as an object at depth: 1
  // when linked, a bare id in the rare case it isn't; null until
  // `ensureTaskPage` first links one (see task-pages.ts).
  const pageField = task.page
  const pagePromise: Promise<Page | null> =
    pageField && typeof pageField === 'object'
      ? Promise.resolve(pageField)
      : pageField
        ? payload.findByID({ collection: 'pages', id: pageField, overrideAccess: true, disableErrors: true })
        : Promise.resolve(null)

  const [statuses, projects, agents, runs, usageTotals, subtasks, comments, activity, page] = await Promise.all([
    payload.find({
      collection: 'task-statuses',
      where: { workspace: { equals: workspace.id } },
      sort: 'position',
      limit: 100,
      overrideAccess: true,
    }),
    payload.find({
      collection: 'projects',
      where: { workspace: { equals: workspace.id } },
      sort: 'name',
      limit: 200,
      overrideAccess: true,
    }),
    payload.find({
      collection: 'agents',
      where: { workspace: { equals: workspace.id } },
      sort: 'name',
      limit: 100,
      depth: 0,
      overrideAccess: true,
    }),
    listRunsForTask(taskId),
    getTaskUsageTotals(taskId),
    // A server component is one of the three places a throw DOES reach the
    // reader (lib/failures.ts's header), so `unwrap` here is not ceremony: it
    // hands the route's error boundary the real sentence instead of an
    // envelope this page would otherwise try to render as data.
    listSubtasks(taskId).then(unwrap),
    listTaskComments(taskId).then(unwrap),
    getTaskActivity(taskId).then(unwrap),
    pagePromise,
  ])

  // `workspace.owner`/`workspace.members` come back populated or as bare ids
  // depending on call site — same depth-agnostic handling as tasks/page.tsx.
  const memberEntries = [workspace.owner, ...(workspace.members ?? [])]
  const assignableUsers: User[] = []
  const seenIds = new Set<number>()
  for (const entry of memberEntries) {
    if (entry == null) continue
    const id = typeof entry === 'number' ? entry : entry.id
    if (seenIds.has(id)) continue
    seenIds.add(id)
    if (typeof entry !== 'number') assignableUsers.push(entry)
  }
  const unresolvedIds = memberEntries
    .map((entry) => (typeof entry === 'number' ? entry : null))
    .filter((id): id is number => id !== null && !assignableUsers.some((u) => u.id === id))
  if (unresolvedIds.length > 0) {
    const resolved = await payload.find({
      collection: 'users',
      where: { id: { in: unresolvedIds } },
      limit: unresolvedIds.length,
      overrideAccess: true,
    })
    assignableUsers.push(...resolved.docs)
  }

  // Runs tab needs per-run cost; the aggregate query above only sums across
  // all runs. Bounded by this task's own run count (small in practice).
  const runUsageByRunId: Record<number, { totalTokens: number; totalCostTicks: number }> = {}
  await Promise.all(
    runs.map(async (run) => {
      runUsageByRunId[run.id] = await getRunUsageTotals(run.id)
    }),
  )

  // Changes tab — simplification (see final report): rather than merging
  // diffs across runs, list each completed run's worktree file count and
  // link out to its own review page. Bounded by this task's own run count.
  const changes: ChangeSummary[] = await Promise.all(
    runs
      .filter((run) => run.status === 'completed')
      .map(async (run) => {
        const review = await loadRunReview(run.id)
        return { run, fileCount: review.files.length, branchExists: review.state.branchExists }
      }),
  )

  // R14-P0.8.2 — "opening a task shows its thread." `tasks.channelThreadRootId`
  // stores only the broker `team_messages.id` (see that field's own comment
  // in `collections/Tasks.ts` for why it is not a Payload relationship); the
  // team/channel id the "View thread" link needs is resolved here, server-side,
  // from the broker rather than adding a second stored column for it.
  const threadTeamId =
    task.channelThreadRootId != null ? (await getChannelMessage(task.channelThreadRootId))?.teamId ?? null : null

  return (
    <TaskDetailView
      workspace={workspace}
      task={task}
      statuses={statuses.docs as TaskStatus[]}
      projects={projects.docs as Project[]}
      assignableUsers={assignableUsers}
      agents={agents.docs as Agent[]}
      runs={runs}
      usageTotals={usageTotals}
      runUsageByRunId={runUsageByRunId}
      subtasks={subtasks}
      comments={comments}
      activity={activity}
      page={page}
      changes={changes}
      threadTeamId={threadTeamId}
    />
  )
}
