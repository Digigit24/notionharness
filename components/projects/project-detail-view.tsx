'use client'

import { useState } from 'react'
import Link from 'next/link'
import { FileText, FolderOpen } from 'lucide-react'
import { DetailLayout, type DetailLayoutTab } from '@/components/layout/detail-layout'
import { EmptyState } from '@/components/ui/empty-state'
import { TaskBoard, type ColumnData } from '@/components/tasks/task-board'
import { NewProjectTaskButton } from './new-project-task-button'
import { ProjectOverviewTab, type ProjectStatusCount } from './project-overview-tab'
import { ProjectRunsTab } from './project-runs-tab'
import { ProjectSettingsTab } from './project-settings-tab'
import type { ProjectRunRow } from '@/app/(app)/workspace/[workspaceSlug]/projects/[projectId]/actions'
import type { Agent, Page, Project, User, Workspace } from '@/payload-types'

// ROADMAP B-1 — the project detail page's own DetailLayout wiring. Header
// and right rail persist across tabs (DetailLayout's own contract); tab
// state lives in the URL via DetailLayout's built-in `?tab=` handling, not
// reinvented here. Overview/Tasks/Runs are the three real tabs this batch
// was asked to build for real; Pages and Files are honest degraded states
// (see each tab's own comment for exactly why), not faked trees/browsers.
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
}: {
  workspace: Workspace
  project: Project
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
    {
      key: 'files',
      label: 'Files',
      content: (
        <div className="p-6">
          {/* ROADMAP B-1 — `lib/run-worktrees/*` only knows how to browse
              ONE run's worktree at a time, scoped by `runId` against a
              single global repo (`RUN_WORKTREE_SOURCE_REPO`, this app's own
              codebase per `lib/run-worktrees/config.ts`). Projects have no
              repo/directory binding field at all (confirmed:
              collections/Projects.ts has name/workspace/icon/description
              only), so there's no "this project's repo" to browse — building
              that binding plus a real file browser is out of scope for one
              pass of one batch. */}
          <EmptyState
            icon={<FolderOpen />}
            title="File browsing isn't available yet"
            description="Projects don't have a repo or directory binding today, and the run-worktree tooling only browses one run's files at a time. Add a repo binding in Settings once that field exists."
          />
        </div>
      ),
    },
    {
      key: 'settings',
      label: 'Settings',
      content: <ProjectSettingsTab project={currentProject} workspaceSlug={workspace.slug} onUpdated={setCurrentProject} />,
    },
  ]

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
      defaultTab="overview"
    />
  )
}
