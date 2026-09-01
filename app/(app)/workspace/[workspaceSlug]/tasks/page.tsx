import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { TaskBoard, type ColumnData } from '@/components/tasks/task-board'
import type { User } from '@/payload-types'

// ROADMAP P2.5 — first pass at the task/project surfaces: Board view only
// (grouped by individual task-status, ordered by that status's own
// `position` — see task-board.tsx's header comment for why this is a
// per-status grouping and not a collapse-to-category one). List/table views,
// saved views, filter chips and a column picker are a scoped follow-up, not
// built in this pass.
const TASKS_PER_COLUMN_PAGE = 30

export default async function TasksView({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params
  const payload = await getPayloadClient()

  const [workspace, currentUser] = await Promise.all([
    getWorkspaceBySlug(workspaceSlug),
    getCurrentPayloadUser(),
  ])
  if (!workspace) notFound()

  const [statuses, projects] = await Promise.all([
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
  ])

  const columns: ColumnData[] = await Promise.all(
    statuses.docs.map(async (status) => {
      const result = await payload.find({
        collection: 'tasks',
        where: { workspace: { equals: workspace.id }, status: { equals: status.id } },
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
      assignableUsers={assignableUsers}
      currentUserId={currentUser?.id ?? null}
      pageSize={TASKS_PER_COLUMN_PAGE}
    />
  )
}
