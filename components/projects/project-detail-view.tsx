'use client'

import { useState } from 'react'
import Link from 'next/link'
import { FileText } from 'lucide-react'
import { DetailLayout, type DetailLayoutTab } from '@/components/layout/detail-layout'
import { ProjectWorktreesTab } from '@/components/projects/project-worktrees-tab'
import type { ProjectGitOverview } from '@/app/(app)/workspace/[workspaceSlug]/projects/[projectId]/worktree-actions'
import { EmptyState } from '@/components/ui/empty-state'
import { TaskBoard, type ColumnData } from '@/components/tasks/task-board'
import { NewProjectTaskButton } from './new-project-task-button'
import { ProjectOverviewTab, type ProjectStatusCount } from './project-overview-tab'
import { ProjectRunsTab } from './project-runs-tab'
import { ProjectSettingsTab } from './project-settings-tab'
import { ProjectResourcesTab } from './project-resources-tab'
import { ProjectFilesTab } from '@/components/repo/project-files-tab'
import type { ProjectRunRow } from '@/app/(app)/workspace/[workspaceSlug]/projects/[projectId]/actions'
import type { Agent, Page, Project, ProjectResource, User, Workspace } from '@/payload-types'

// ROADMAP B-1 — the project detail page's own DetailLayout wiring. Header
// and right rail persist across tabs (DetailLayout's own contract); tab
// state lives in the URL via DetailLayout's built-in `?tab=` handling, not
// reinvented here. Overview/Tasks/Runs/Resources are real tabs; Pages is an
// honest degraded state (see its own comment for exactly why), not a faked
// tree. Resources (Phase C, closing the C1.1/C3 gap once
// `project_resources` was actually migrated+registered — see AGENTS.md)
// stays deliberately separate from Files: Resources declares WHICH
// repo/directory a project is bound to (a `project_resources` row), and
// Files — added by R9 — reads that binding's contents through git.
export function ProjectDetailView({
  workspace,
  project,
  columns,
  taskProjects,
  assignableUsers,
  agents,
  currentUserId,
  pageSize,
  statusCounts,
  activeRunCount,
  totalCostTicks30d,
  lastActivityAt,
  initialRuns,
  defaultStatusId,
  projectPages,
  gitOverview,
  initialResources,
}: {
  workspace: Workspace
  project: Project
  /** Bindings, worktrees and their live git status; null when git could not
   * be read on this machine. */
  gitOverview: ProjectGitOverview | null
  columns: ColumnData[]
  taskProjects: Project[]
  assignableUsers: User[]
  agents: Agent[]
  currentUserId: number | null
  pageSize: number
  statusCounts: ProjectStatusCount[]
  activeRunCount: number
  totalCostTicks30d: number
  lastActivityAt: string | null
  initialRuns: ProjectRunRow[]
  defaultStatusId: number | null
  projectPages: Page[]
  initialResources: ProjectResource[]
}) {
  const [currentProject, setCurrentProject] = useState(project)
  const totalTasks = columns.reduce((sum, c) => sum + c.totalDocs, 0)

  const tabs: DetailLayoutTab[] = [
    {
      key: 'overview',
      label: 'Overview',
      content: (
        <ProjectOverviewTab
          projectId={currentProject.id}
          workspaceSlug={workspace.slug}
          initialDescription={currentProject.description ?? null}
          statusCounts={statusCounts}
          activeRunCount={activeRunCount}
          totalCostTicks={totalCostTicks30d}
          lastActivityAt={lastActivityAt}
        />
      ),
    },
    {
      key: 'tasks',
      label: 'Tasks',
      count: totalTasks,
      content: (
        <TaskBoard
          workspace={workspace}
          columns={columns}
          projects={taskProjects}
          assignableUsers={assignableUsers}
          agents={agents}
          currentUserId={currentUserId}
          pageSize={pageSize}
          defaultProjectId={currentProject.id}
        />
      ),
    },
    {
      key: 'pages',
      label: 'Pages',
      count: projectPages.length,
      content: (
        <div className="p-6">
          {/* ROADMAP B-1 — `collections/Pages.ts`'s `project` relationship
              (migrations/20260902_100000_pages_project.ts) is now applied
              and wired: this renders a real, workspace-scoped page list.
              No page-creation flow sets `project` yet (NewPageButton always
              creates a top-level, unscoped page), so the empty state is
              honest about that rather than offering a "create" action that
              wouldn't actually land in this project. */}
          {projectPages.length === 0 ? (
            <EmptyState
              icon={<FileText />}
              title="No pages linked to this project yet"
              description="Open a page and set its project from the page's own settings, or link one from the sidebar's page tree."
            />
          ) : (
            <ul className="divide-y divide-black/5 dark:divide-white/10">
              {projectPages.map((page) => (
                <li key={page.id}>
                  <Link
                    href={`/workspace/${workspace.slug}/p/${page.id}`}
                    className="flex items-center gap-2 rounded-md px-2 py-2.5 text-sm hover:bg-black/[.03] dark:hover:bg-white/[.04]"
                  >
                    <FileText className="h-4 w-4 shrink-0 text-black/40 dark:text-white/40" />
                    <span className="truncate">{page.title || 'Untitled'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ),
    },
    {
      key: 'runs',
      label: 'Runs',
      count: initialRuns.length,
      content: <ProjectRunsTab projectId={currentProject.id} workspaceSlug={workspace.slug} agents={agents} initialRuns={initialRuns} />,
    },
  ]

  // R9.4 — Files is back, and only when there is something in it.
  //
  // The condition is `isRepo`, which `getProjectGitOverview` computes by
  // asking the FILESYSTEM, not by reading the `kind` column: a binding
  // labelled `git_repo` whose clone failed is not a repository, and a folder
  // somebody ran `git init` in is. A project with no repository gets no tab
  // at all rather than an empty state — the previous version of this file
  // removed Files for exactly that reason ("a tab that never has content is
  // worse than no tab"), and that reasoning still holds; what changed is that
  // there is now content when a repository exists.
  if (gitOverview?.resources.some((resource) => resource.isRepo)) {
    tabs.push({
      key: 'files',
      label: 'Files',
      content: <ProjectFilesTab workspaceSlug={workspace.slug} projectId={currentProject.id} />,
    })
  }

  // Four tabs (five with a repository), not eight.
  //
  // Resources, Worktrees and Settings were each a tab holding a short list or
  // a small form — the kind of thing you check while looking at something
  // else, not a place you go. As tabs they hid the project's actual work
  // behind a row of chrome and cost a click to answer "which repo is this?".
  // In the rail they are all visible at once, beside whatever tab is open.
  //
  // Files was an empty state explaining a feature that did not exist yet.
  // A tab that never has content is worse than no tab: it advertises a place
  // to look and then wastes the look. R9 built the content, so it is back —
  // above, and conditionally, which is the same rule stated the other way
  // round.
  const rightRail = (
    <div className="flex flex-col gap-5 text-sm">
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
          Repository
        </h2>
        {gitOverview ? (
          <ProjectWorktreesTab
            workspaceSlug={workspace.slug}
            projectId={currentProject.id}
            overview={gitOverview}
            compact
          />
        ) : (
          <p className="text-xs text-black/50 dark:text-white/50">
            Git information could not be read on this machine.
          </p>
        )}
      </section>

      <section className="border-t border-black/10 pt-4 dark:border-white/10">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
          Resources
        </h2>
        <ProjectResourcesTab
          projectId={currentProject.id}
          workspaceSlug={workspace.slug}
          initialResources={initialResources}
          compact
        />
      </section>

      <section className="border-t border-black/10 pt-4 dark:border-white/10">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
          Settings
        </h2>
        <ProjectSettingsTab
          project={currentProject}
          workspaceSlug={workspace.slug}
          onUpdated={setCurrentProject}
          compact
        />
      </section>
    </div>
  )

  return (
    <DetailLayout
      breadcrumb={[
        { label: 'Projects', href: `/workspace/${workspace.slug}/projects` },
        { label: currentProject.name || 'Untitled' },
      ]}
      title={
        <span className="flex items-center gap-2">
          {currentProject.icon && <span aria-hidden="true">{currentProject.icon}</span>}
          {currentProject.name || 'Untitled'}
        </span>
      }
      primaryAction={
        <NewProjectTaskButton
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          projectId={currentProject.id}
          defaultStatusId={defaultStatusId}
          createdById={currentUserId}
        />
      }
      tabs={tabs}
      rightRail={rightRail}
      defaultTab="overview"
    />
  )
}
