import { notFound } from 'next/navigation'
import Link from 'next/link'
import { FolderKanban } from 'lucide-react'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getProjectUsageRollup } from '@/lib/broker'
import { EmptyState } from '@/components/ui/empty-state'

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

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">
          The grouping unit above tasks — every project&apos;s brief, tasks, pages, runs, files, and settings live on its own page.
        </p>
      </div>

      {result.docs.length === 0 ? (
        <EmptyState
          icon={<FolderKanban />}
          title="No projects yet"
          description="Create a project from a task&apos;s Project field, or via the Payload admin, to see it here."
        />
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
                <span className="shrink-0 text-xs tabular-nums text-black/50 dark:text-white/50" title="Spend, last 30 days">
                  ${((spendByProjectId.get(project.id) ?? 0) / 100).toFixed(2)}<span className="text-black/30 dark:text-white/30"> /30d</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
