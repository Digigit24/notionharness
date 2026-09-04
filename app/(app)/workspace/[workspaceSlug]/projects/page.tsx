import { notFound } from 'next/navigation'
import Link from 'next/link'
import { FolderKanban } from 'lucide-react'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getBrokerPool, getProjectUsageRollup } from '@/lib/broker'
import { EmptyState } from '@/components/ui/empty-state'
import { AddProjectForm } from '@/components/projects/add-project-form'
import { formatRelativeTime } from '@/lib/relative-time'

// ROADMAP B-1 (project detail) — a minimal list route, added specifically so
// the new `/projects/[projectId]` detail page isn't an orphan: previously no
// `/projects` route existed at all (only a project *filter* inside the Tasks
// page). Deliberately simple linked rows, not a second board/kanban surface
// — that's out of scope for this pass; this page exists to make the detail
// route reachable, not to compete with Tasks.
export default async function ProjectsListPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'projects',
    where: { workspace: { equals: workspace.id } },
    sort: 'name',
    limit: 200,
    depth: 0,
    overrideAccess: true,
  })

  // ROADMAP B7.2 (Batch B-6 "Finish") — this list previously showed no
  // per-project spend at all, even though `getProjectUsageRollup` (built for
  // the project detail Overview tab in B-1) already exists and needs no new
  // query infrastructure to reuse here. Bounded by this workspace's own
  // project count, same "small enough for N queries" reasoning task-detail's
  // per-run usage loop already uses.
  const spendByProjectId = new Map<number, number>()
  await Promise.all(
    result.docs.map(async (project) => {
      const rollup = await getProjectUsageRollup(project.id, 30)
      spendByProjectId.set(project.id, rollup.totalCostTicks)
    }),
  )

  // Free win 9 — a project row said only what it cost, which is the least
  // useful thing about it. Task count, whether anything is running, and when
  // it was last touched are what actually distinguish one row from another.
  //
  // ONE query for the whole list rather than three per project: this list is
  // bounded but the pattern is not, and N+1 against a remote database is
  // exactly what D0 forbids.
  const projectIds = result.docs.map((project) => project.id)
  const stats = new Map<number, { tasks: number; activeRuns: number; lastActivity: string | null }>()
  if (projectIds.length > 0) {
    try {
      const pool = getBrokerPool()
      const { rows } = await pool.query<{
        project_id: string
        task_count: string
        active_runs: string
        last_activity: Date | null
      }>(
        `SELECT t.project_id,
                COUNT(DISTINCT t.id)                                   AS task_count,
                COUNT(DISTINCT r.id) FILTER (
                  WHERE r.status IN ('queued','dispatched','running','waiting_directory')
                )                                                       AS active_runs,
                MAX(GREATEST(t.updated_at, COALESCE(r.updated_at, t.updated_at))) AS last_activity
           FROM tasks t
           LEFT JOIN runs r ON r.task_id = t.id
          WHERE t.project_id = ANY($1::int[])
          GROUP BY t.project_id`,
        [projectIds],
      )
      for (const row of rows) {
        stats.set(Number(row.project_id), {
          tasks: Number(row.task_count),
          activeRuns: Number(row.active_runs),
          lastActivity: row.last_activity ? new Date(row.last_activity).toISOString() : null,
        })
      }
    } catch {
      // A stats query must never stop the list rendering. Rows fall back to
      // showing no counts, which is honest, rather than the page failing.
    }
  }

  return (
    <main className="w-full px-5 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            The grouping unit above tasks — every project&apos;s brief, tasks, pages, runs, files, and settings live on its own page.
          </p>
        </div>
        <AddProjectForm workspaceId={workspace.id} workspaceSlug={workspace.slug} />
      </div>

      {result.docs.length === 0 ? (
        <EmptyState
          icon={<FolderKanban />}
          title="No projects yet"
          description="A project groups tasks, pages and runs, and gives agents a repository to work in."
        >
          {/* The form is right here rather than only in the header, so the
              empty state offers the action it is describing. */}
          <AddProjectForm workspaceId={workspace.id} workspaceSlug={workspace.slug} />
        </EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
          {result.docs.map((project) => (
            <li key={project.id}>
              <Link
                href={`/workspace/${workspace.slug}/projects/${project.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-black/[.03] dark:hover:bg-white/[.04]"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-black/[.06] text-base dark:bg-white/10">
                  {project.icon || <FolderKanban size={16} className="text-black/40 dark:text-white/40" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{project.name || 'Untitled'}</span>
                  {project.description && (
                    <span className="block truncate text-xs text-black/40 dark:text-white/40">{project.description}</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-black/50 dark:text-white/50">
                  {stats.get(project.id)?.activeRuns ? (
                    <span className="flex items-center gap-1 text-primary" title="Runs in flight">
                      <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                      {stats.get(project.id)?.activeRuns} running
                    </span>
                  ) : null}
                  <span title="Tasks in this project">
                    {stats.get(project.id)?.tasks ?? 0} {stats.get(project.id)?.tasks === 1 ? 'task' : 'tasks'}
                  </span>
                  {stats.get(project.id)?.lastActivity && (
                    <span className="hidden text-black/35 sm:inline dark:text-white/35" title="Last activity">
                      {formatRelativeTime(stats.get(project.id)!.lastActivity!)}
                    </span>
                  )}
                  <span title="Spend, last 30 days">
                    ${((spendByProjectId.get(project.id) ?? 0) / 100).toFixed(2)}
                    <span className="text-black/30 dark:text-white/30"> /30d</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
