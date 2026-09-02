'use client'

// ROADMAP B-4.1 — this file is now the shared task-views *container*, not
// the board itself. It owns exactly three things: mounting the single
// `useTaskViewData` hook (the shared data/filter layer every view reads),
// the view switcher + filter bar, and the task drawer. Board/List/Table
// rendering each moved to their own file (`task-board-view.tsx`,
// `task-list-view.tsx`, `task-table-view.tsx`) — this is the extraction the
// plan called out as the real risk of this batch ("the existing 20 KB board
// has its filter logic fused into its rendering"); the board's own
// dnd-kit rendering is unchanged from before the extraction, just fed by
// the hook instead of local component state.
import { useEffect, useMemo, useState } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getActiveRunsForWorkspace, getTaskRuns } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import { TaskDrawer } from './task-drawer'
import { TaskFilterBar } from './task-filter-bar'
import { TaskBoardView } from './task-board-view'
import { TaskListView } from './task-list-view'
import { TaskTableView } from './task-table-view'
import { useTaskViewData, type ColumnData, type TaskViewKind } from './use-task-view-data'
import type { TaskRunMetrics } from './run-metrics'
import type { Agent, Project, Task, User, Workspace } from '@/payload-types'

export type { ColumnData, TaskViewKind } from './use-task-view-data'

const VIEW_LABELS: Record<TaskViewKind, string> = { board: 'Board', list: 'List', table: 'Table' }

export function TaskBoard({
  workspace,
  columns,
  projects,
  assignableUsers,
  agents,
  currentUserId,
  pageSize,
  initialSelectedTaskId = null,
  defaultProjectId = null,
}: {
  workspace: Workspace
  columns: ColumnData[]
  projects: Project[]
  assignableUsers: User[]
  agents: Agent[]
  currentUserId: number | null
  pageSize: number
  initialSelectedTaskId?: number | null
  /** ROADMAP B-1 — when this board is embedded on a project detail page
   * (columns already pre-filtered to that project), new tasks added via
   * "+ Add task" must be scoped to the same project too, or they'd vanish
   * from the board on the next server-scoped refetch. Left null (unset) for
   * the plain, unscoped Tasks page. */
  defaultProjectId?: number | null
}) {
  const data = useTaskViewData({ workspace, columns, pageSize, currentUserId, defaultProjectId })
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(initialSelectedTaskId)
  const [runMetrics, setRunMetrics] = useState<Record<number, TaskRunMetrics>>({})
  const [activeTaskIds, setActiveTaskIds] = useState<Set<number>>(new Set())

  const listTasks = useMemo(() => data.listGroups.flatMap((g) => g.tasks), [data.listGroups])
  const boardTasks = useMemo(() => data.boardColumns.flatMap((c) => c.tasks), [data.boardColumns])

  // Every task currently visible in ANY view (not just the active one) —
  // run metrics/presence stay warm across a view switch instead of
  // re-fetching from zero every time.
  const allTasks = useMemo(() => {
    const byId = new Map<number, Task>()
    for (const task of boardTasks) byId.set(task.id, task)
    for (const task of listTasks) byId.set(task.id, task)
    for (const task of data.tableTasks) byId.set(task.id, task)
    return [...byId.values()]
  }, [boardTasks, listTasks, data.tableTasks])

  const selectedTask = selectedTaskId != null ? data.findTask(selectedTaskId)?.task ?? null : null

  useEffect(() => {
    let active = true
    async function refreshMetrics() {
      const items = await Promise.all(allTasks.map(async (task) => {
      if (!task.agent) return null
      const runs = await getTaskRuns(task.id)
      const run = runs[0]
      if (!run) return null
      const usage = await fetch(`/api/runs/${run.id}`).then((response) => response.ok ? response.json() as Promise<{ totalCostTicks: number; stepCount: number }> : null)
      if (!usage) return null
      return { taskId: task.id, metrics: { runId: run.id, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, totalCostTicks: usage.totalCostTicks, stepCount: usage.stepCount } }
      }))
      if (!active) return
      setRunMetrics(Object.fromEntries(items.filter((item): item is NonNullable<typeof item> => item !== null).map((item) => [item.taskId, item.metrics])))
    }
    void refreshMetrics().catch(() => { /* Metrics are non-critical; cards remain usable if broker data is unavailable. */ })
    const timer = window.setInterval(() => { void refreshMetrics().catch(() => undefined) }, 4000)
    return () => { active = false; window.clearInterval(timer) }
  }, [allTasks])

  useEffect(() => {
    let active = true
    async function refreshPresence() {
      const runs = await getActiveRunsForWorkspace(workspace.id)
      if (active) setActiveTaskIds(new Set(runs.flatMap((run) => run.taskId === null ? [] : [run.taskId])))
    }
    void refreshPresence().catch(() => undefined)
    const timer = window.setInterval(() => { void refreshPresence().catch(() => undefined) }, 4000)
    return () => { active = false; window.clearInterval(timer) }
  }, [workspace.id])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-black/5 px-6 py-3 dark:border-white/10">
        <h1 className="text-lg font-semibold">Tasks</h1>
        <Tabs value={data.view} onValueChange={(v) => data.setView(v as TaskViewKind)}>
          <TabsList>
            {(['board', 'list', 'table'] as const).map((item) => (
              <TabsTrigger key={item} value={item}>{VIEW_LABELS[item]}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <TaskFilterBar
        view={data.view}
        statuses={data.statuses}
        projects={projects}
        assignableUsers={assignableUsers}
        agents={agents}
        filters={data.filters}
        onFiltersChange={data.setFilters}
        sort={data.sort}
        onSortChange={data.setSort}
        groupBy={data.groupBy}
        onGroupByChange={data.setGroupBy}
      />

      {data.error && (
        <div className="border-b border-red-200 bg-red-50 px-6 py-1.5 text-xs text-red-600 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400">
          {data.error}
        </div>
      )}

      {data.view === 'board' ? (
        <TaskBoardView
          columns={data.boardColumns}
          runMetrics={runMetrics}
          activeTaskIds={activeTaskIds}
          onOpenTask={setSelectedTaskId}
          onDragEnd={data.handleDragEnd}
          onAddTask={data.handleAddTask}
          onLoadMore={data.handleLoadMore}
        />
      ) : data.view === 'list' ? (
        <TaskListView
          groups={data.listGroups}
          statuses={data.statuses}
          assignableUsers={assignableUsers}
          runMetrics={runMetrics}
          activeTaskIds={activeTaskIds}
          loading={data.viewLoading}
          onOpenTask={setSelectedTaskId}
          onPatchTask={(taskId, patch) => void data.patchTask(taskId, patch)}
          onArchiveTasks={(taskIds) => void data.archiveTasks(taskIds)}
        />
      ) : (
        <TaskTableView
          tasks={data.tableTasks}
          statuses={data.statuses}
          runMetrics={runMetrics}
          activeTaskIds={activeTaskIds}
          sort={data.sort}
          onSortChange={data.setSort}
          onOpenTask={setSelectedTaskId}
          loading={data.viewLoading}
        />
      )}

      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          workspace={workspace}
          projects={projects}
          statuses={data.statuses}
          assignableUsers={assignableUsers}
          agents={agents}
          onClose={() => setSelectedTaskId(null)}
          onUpdated={data.handleTaskUpdated}
        />
      )}
    </div>
  )
}
