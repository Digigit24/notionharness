import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { TaskBoard, type ColumnData } from '@/components/tasks/task-board'
import type { Agent, User } from '@/payload-types'

// ROADMAP P2.5 — first pass at the task/project surfaces: Board view only
// (grouped by individual task-status, ordered by that status's own
// `position` — see task-board.tsx's header comment for why this is a
// per-status grouping and not a collapse-to-category one). List/table views,
// saved views, filter chips and a column picker are a scoped follow-up, not
// built in this pass.
const TASKS_PER_COLUMN_PAGE = 30

export default async function TasksView({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ task?: string; project?: string }>
}) {
  const { workspaceSlug } = await params
  const { task: taskParam, project: projectParam } = await searchParams
  // ROADMAP P2.6 — notifications link to `?task=<id>` so clicking one opens
  // straight into that task's drawer. Only works if the task is already in
  // one of its column's first `TASKS_PER_COLUMN_PAGE` — a task further down
  // (behind "Load more") just won't auto-open; degrades silently rather than
  // adding a dedicated single-task fetch for this pass.
  const initialSelectedTaskId = taskParam ? Number(taskParam) : null
  const payload = await getPayloadClient()

  const [workspace, currentUser] = await Promise.all([
    getWorkspaceBySlug(workspaceSlug),
    getCurrentPayloadUser(),
  ])
  if (!workspace) notFound()

  // Destructured in the SAME order as the promises. It previously read
  // `[statuses, projects, agents]` against `[statuses, agents, projects]`, so
  // the board was handed the agent list as its projects and vice versa — the
  // project filter listed agent names and the assignee picker listed projects.
  const [statuses, agents, projects] = await Promise.all([
    payload.find({
      collection: 'task-statuses',
      where: { workspace: { equals: workspace.id } },
      sort: 'position',
      limit: 100,
      overrideAccess: true,
    }),
    payload.find({ collection: 'agents', where: { workspace: { equals: workspace.id }, enabled: { equals: true } }, sort: 'name', limit: 100, depth: 0, overrideAccess: true }),
    payload.find({
      collection: 'projects',
      where: { workspace: { equals: workspace.id } },
      sort: 'name',
      limit: 200,
      overrideAccess: true,
    }),
  ])

  // Free win 14 — `?project=<id>` narrows the board to one project. Filtered
  // in the query rather than after loading, so a workspace with many tasks
  // does not pay to fetch the ones it is about to discard, and each column's
  // "load more" count stays truthful for the filtered view.
  const projectFilterId = projectParam ? Number(projectParam) : null
  const activeProjectId = Number.isFinite(projectFilterId) ? projectFilterId : null

  const columns: ColumnData[] = await Promise.all(
    statuses.docs.map(async (status) => {
      const result = await payload.find({
        collection: 'tasks',
        where: {
          workspace: { equals: workspace.id },
          status: { equals: status.id },
          ...(activeProjectId ? { project: { equals: activeProjectId } } : {}),
        },
        sort: 'position',
        limit: TASKS_PER_COLUMN_PAGE,
        overrideAccess: true,
      })
      return { status, tasks: result.docs, totalDocs: result.totalDocs }
    }),
  )

  // `workspace.owner`/`workspace.members` come back populated (Payload's
  // default query depth) or as bare ids depending on call site — same
  // depth-agnostic ternary used throughout `actions.ts`/existing routes.
  const memberEntries = [workspace.owner, ...(workspace.members ?? [])]
  const assignableUsers: User[] = []
  const seenIds = new Set<number>()
  for (const entry of memberEntries) {
    if (entry == null) continue
    const user = typeof entry === 'number' ? null : entry
    const id = typeof entry === 'number' ? entry : entry.id
    if (seenIds.has(id)) continue
    seenIds.add(id)
    if (user) assignableUsers.push(user)
  }
  // Any member id that only came back as a bare number (not populated) is
  // fetched in one batched query rather than N individual `findByID` calls.
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

  return (
    <TaskBoard
      workspace={workspace}
      columns={columns}
      projects={projects.docs}
      // Scoping the board to a project should also mean a task created here
      // lands in it, rather than making the person pick the project they are
      // already looking at.
      defaultProjectId={activeProjectId}
      assignableUsers={assignableUsers}
      agents={agents.docs as Agent[]}
      currentUserId={currentUser?.id ?? null}
      pageSize={TASKS_PER_COLUMN_PAGE}
      initialSelectedTaskId={Number.isFinite(initialSelectedTaskId) ? initialSelectedTaskId : null}
    />
  )
}
