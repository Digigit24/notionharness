'use client'

import { useState } from 'react'
import { FileText, FolderOpen } from 'lucide-react'
import { DetailLayout, type DetailLayoutTab } from '@/components/layout/detail-layout'
import { EmptyState } from '@/components/ui/empty-state'
import { TaskBoard, type ColumnData } from '@/components/tasks/task-board'
import { NewProjectTaskButton } from './new-project-task-button'
import { ProjectOverviewTab, type ProjectStatusCount } from './project-overview-tab'
import { ProjectRunsTab } from './project-runs-tab'
import { ProjectSettingsTab } from './project-settings-tab'
import type { ProjectRunRow } from '@/app/(app)/workspace/[workspaceSlug]/projects/[projectId]/actions'
import type { Agent, Project, User, Workspace } from '@/payload-types'

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
      content: (
        <div className="p-6">
          {/* ROADMAP B-1 — `collections/Pages.ts` has no `project`
              relationship (only `parentPage`); confirmed again this batch,
              same finding B-0's navigation investigation already made. A
              migration exists (migrations/20260902_100000_pages_project.ts)
              but is NOT applied — see this batch's final report. Until a
              human applies it and adds the field, there is no real
              project-scoped page tree to show; this is an honest placeholder,
              not a faked one. */}
          <EmptyState
            icon={<FileText />}
            title="Pages aren't linked to projects yet"
            description="There's no way to scope a page to a project in the current schema — only a page's parent page. A migration is written and waiting for a human to apply it."
          />
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
