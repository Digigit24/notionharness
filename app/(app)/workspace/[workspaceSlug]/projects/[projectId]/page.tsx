import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { listActiveRunsForProject, getProjectUsageRollup } from '@/lib/broker'
import { TASK_STATUS_CATEGORIES } from '@/collections/TaskStatuses'
import { ProjectDetailView } from '@/components/projects/project-detail-view'
import { getProjectRuns } from './actions'
import type { ColumnData } from '@/components/tasks/task-board'
import type { Agent, User } from '@/payload-types'

const TASKS_PER_COLUMN_PAGE = 30

const CATEGORY_LABELS: Record<(typeof TASK_STATUS_CATEGORIES)[number], string> = {
  backlog: 'Backlog',
  todo: 'To do',
  inProgress: 'In progress',
  inReview: 'In review',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
}

// ROADMAP B-1 "Detail" — the project detail page. Server component: fetches
// everything up front (Overview/Tasks/Runs are the three real tabs this
// batch built; Pages/Files are honest degraded states rendered inside
// `<ProjectDetailView>`, not built as separate data fetches here since
// there's nothing real to fetch for either yet — see that component's own
// comments for exactly why).
export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; projectId: string }>
}) {
  const { workspaceSlug, projectId: projectIdParam } = await params
  const projectId = Number(projectIdParam)
  if (!Number.isFinite(projectId)) notFound()

  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()
  const project = await payload.findByID({ collection: 'projects', id: projectId, depth: 0, overrideAccess: true, disableErrors: true })
  if (!project) notFound()
  const projectWorkspaceId = typeof project.workspace === 'number' ? project.workspace : project.workspace.id
  if (projectWorkspaceId !== workspace.id) notFound()

  const [statuses, agents, taskProjects, currentUser] = await Promise.all([
    payload.find({ collection: 'task-statuses', where: { workspace: { equals: workspace.id } }, sort: 'position', limit: 100, overrideAccess: true }),
    payload.find({ collection: 'agents', where: { workspace: { equals: workspace.id }, enabled: { equals: true } }, sort: 'name', limit: 100, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'projects', where: { workspace: { equals: workspace.id } }, sort: 'name', limit: 200, overrideAccess: true }),
    getCurrentPayloadUser(),
  ])

  const columns: ColumnData[] = await Promise.all(
    statuses.docs.map(async (status) => {
      const result = await payload.find({
        collection: 'tasks',
        where: { project: { equals: project.id }, status: { equals: status.id } },
        sort: 'position',
        limit: TASKS_PER_COLUMN_PAGE,
        overrideAccess: true,
      })
      return { status, tasks: result.docs, totalDocs: result.totalDocs }
    }),
  )

  const statusCounts = TASK_STATUS_CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    count: columns.filter((c) => c.status.category === category).reduce((sum, c) => sum + c.totalDocs, 0),
  }))

  // workspace.owner/workspace.members can come back populated or as bare
  // ids depending on call site — same depth-agnostic handling as the plain
  // Tasks page.
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
  const unresolvedIds = memberEntries
    .map((entry) => (typeof entry === 'number' ? entry : null))
    .filter((id): id is number => id !== null && !assignableUsers.some((u) => u.id === id))
  if (unresolvedIds.length > 0) {
    const resolved = await payload.find({ collection: 'users', where: { id: { in: unresolvedIds } }, limit: unresolvedIds.length, overrideAccess: true })
    assignableUsers.push(...resolved.docs)
  }

  const [activeRuns, usageRollup, initialRuns, lastActiveTask, projectPages] = await Promise.all([
    listActiveRunsForProject(project.id),
    getProjectUsageRollup(project.id, 30),
    getProjectRuns({ projectId: project.id }),
    payload.find({
      collection: 'tasks',
      where: { project: { equals: project.id } },
      sort: '-lastActivityAt',
      limit: 1,
      depth: 0,
      overrideAccess: true,
    }),
    // ROADMAP B-1 (project detail, Pages tab) — now real: the `project`
    // field/migration landed together (see collections/Pages.ts and
    // migrations/20260902_100000_pages_project.ts's paired comments).
    payload.find({
      collection: 'pages',
      where: { project: { equals: project.id }, isArchived: { equals: false } },
      sort: 'title',
      limit: 100,
      depth: 0,
      overrideAccess: true,
    }),
  ])

  return (
    <ProjectDetailView
      workspace={workspace}
      project={project}
      columns={columns}
      taskProjects={taskProjects.docs}
      assignableUsers={assignableUsers}
      agents={agents.docs as Agent[]}
      currentUserId={currentUser?.id ?? null}
      pageSize={TASKS_PER_COLUMN_PAGE}
      statusCounts={statusCounts}
      activeRunCount={activeRuns.length}
      totalCostTicks30d={usageRollup.totalCostTicks}
      lastActivityAt={lastActiveTask.docs[0]?.lastActivityAt ?? null}
      initialRuns={initialRuns}
      defaultStatusId={statuses.docs[0]?.id ?? null}
      projectPages={projectPages.docs}
    />
  )
}
