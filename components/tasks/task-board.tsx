'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { Plus } from 'lucide-react'
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { statusColorClasses } from '@/lib/status-colors'
import {
  bulkUpdateTaskFields,
  createTask,
  getActiveRunsForWorkspace,
  getTaskAgentColumnsData,
  getTaskRuns,
  loadMoreTasks,
  moveTaskToStatus,
  type TaskAgentColumnData,
} from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import {
  createSavedView,
  deleteSavedView,
  listSavedViews,
  savedViewConfig,
  updateSavedView,
} from '@/app/(app)/workspace/[workspaceSlug]/tasks/saved-views-actions'
import {
  applyTaskViewConfigToSearchParams,
  taskViewConfigFromSearchParams,
  type TaskViewColumns,
  type TaskViewConfig,
  type TaskViewDensity,
  type TaskViewFilters,
  type TaskViewGroupBy,
  type TaskViewSort,
  type TaskViewSortField,
} from '@/lib/task-views/types'
import type { SavedViewScope } from '@/collections/SavedViews'
import { TaskDrawer } from './task-drawer'
import { AgentPresence, RunMetrics, type TaskRunMetrics } from './run-metrics'
import { TaskViewBar } from './task-view-bar'
import { BulkActionBar } from './bulk-action-bar'
import { AgentColumn, LastRunOutcomeColumn, LiveDot, RunsColumn, SpendColumn } from './columns/task-agent-columns'
import type { Agent, Project, SavedView, Task, TaskStatus, User, Workspace } from '@/payload-types'

export interface ColumnData {
  status: TaskStatus
  tasks: Task[]
  totalDocs: number
}

// ROADMAP P2.5 board view. Columns are one per `TaskStatus` document
// (ordered by that status's own `position`), not collapsed to the 7 fixed
// `category` values — a workspace can define several statuses that share a
// category (e.g. two different "blocked" reasons), and collapsing those into
// one column would silently merge workflow stages the workspace explicitly
// created, undermining "workspaces define their own statuses." `category` is
// still carried on each status/column for whatever reads it structurally
// (automation, the broker, later) — it just isn't the *grouping key* here.
//
// Drag-and-drop is column-level only (status change + append-to-end
// position), matching the one dnd-kit precedent already in this codebase
// (`components/database/kanban-board.tsx`) which has the same limitation —
// `@dnd-kit/core` alone has no more precise drop target than "which
// droppable," and adding `@dnd-kit/sortable` for intra-column reordering is
// out of scope for this pass.
const DRAG_PREFIX = 'task-'
const DROP_PREFIX = 'col-'

interface TaskBoardProps {
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
   * the plain, unscoped Tasks page. Also doubles (ROADMAP B-4) as the
   * project a 'project'-scoped saved view is saved against. */
  defaultProjectId?: number | null
}

/**
 * ROADMAP B-4 "Work" — "every view is a URL," which needs `useSearchParams`,
 * which needs a Suspense boundary per Next's App Router rules (same reason
 * `<DetailLayout>` — components/layout/detail-layout.tsx — wraps itself the
 * same way for its own `?tab=` state).
 */
export function TaskBoard(props: TaskBoardProps) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-black/40 dark:text-white/40">
          Loading tasks…
        </div>
      }
    >
      <TaskBoardWithUrlState {...props} />
    </Suspense>
  )
}

// ---------------------------------------------------------------------------
// Filtering/grouping helpers — module-level, pure, shared by board/list/table.
// ---------------------------------------------------------------------------

function statusIdOf(task: Task): number {
  return typeof task.status === 'object' ? task.status.id : task.status
}

function statusCategoryOf(task: Task, statusCategoryById: Map<number, string>): string | null {
  return statusCategoryById.get(statusIdOf(task)) ?? null
}

function matchesFilters(task: Task, filters: TaskViewFilters, statusCategoryById: Map<number, string>): boolean {
  if (filters.statusCategory && statusCategoryOf(task, statusCategoryById) !== filters.statusCategory) return false
  const assigneeId = typeof task.assignee === 'object' ? task.assignee?.id ?? null : task.assignee ?? null
  if (filters.assigneeId != null && assigneeId !== filters.assigneeId) return false
  const agentId = typeof task.agent === 'object' ? task.agent?.id ?? null : task.agent ?? null
  if (filters.agentId != null && agentId !== filters.agentId) return false
  const projectId = typeof task.project === 'object' ? task.project?.id ?? null : task.project ?? null
  if (filters.projectId != null && projectId !== filters.projectId) return false
  // ROADMAP B-4 — hideArchived's real, working meaning today: the bulk
  // Archive action (bulk-action-bar.tsx) moves tasks to this workspace's
  // 'cancelled'-category status, since no dedicated `archived` field exists
  // yet (written, not applied — migrations/20260902_130000_tasks_archived.ts).
  // Filtering that category out is what "hide archived" actually does until
  // that field is migrated and this filter can read it directly instead.
  if (filters.hideArchived && statusCategoryOf(task, statusCategoryById) === 'cancelled') return false
  return true
}

function groupTasksForList(
  tasks: Task[],
  groupBy: TaskViewGroupBy,
  columns: ColumnData[],
): { key: string; label: string; tasks: Task[] }[] {
  if (groupBy === 'none') return tasks.length > 0 ? [{ key: 'all', label: '', tasks }] : []
  if (groupBy === 'status') {
    const byStatus = new Map<number, Task[]>()
    for (const task of tasks) {
      const statusId = statusIdOf(task)
      if (!byStatus.has(statusId)) byStatus.set(statusId, [])
      byStatus.get(statusId)!.push(task)
    }
    return columns
      .filter((c) => byStatus.has(c.status.id))
      .map((c) => ({ key: String(c.status.id), label: c.status.name, tasks: byStatus.get(c.status.id)! }))
  }
  const buckets = new Map<string, { label: string; tasks: Task[] }>()
  for (const task of tasks) {
    let key: string
    let label: string
    if (groupBy === 'project') {
      const project = typeof task.project === 'object' ? task.project : null
      key = project ? String(project.id) : 'none'
      label = project?.name ?? 'No project'
    } else {
      const assignee = typeof task.assignee === 'object' ? task.assignee : null
      key = assignee ? String(assignee.id) : 'none'
      label = assignee?.name || assignee?.email || 'Unassigned'
    }
    if (!buckets.has(key)) buckets.set(key, { label, tasks: [] })
    buckets.get(key)!.tasks.push(task)
  }
  return Array.from(buckets.entries()).map(([key, value]) => ({ key, ...value }))
}

function TaskBoardWithUrlState({
  workspace,
  columns,
  projects,
  assignableUsers,
  agents,
  currentUserId,
  pageSize,
  initialSelectedTaskId = null,
  defaultProjectId = null,
}: TaskBoardProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [tasksByStatus, setTasksByStatus] = useState<Record<number, Task[]>>(() =>
    Object.fromEntries(columns.map((c) => [c.status.id, c.tasks])),
  )
  const [totalsByStatus, setTotalsByStatus] = useState<Record<number, number>>(() =>
    Object.fromEntries(columns.map((c) => [c.status.id, c.totalDocs])),
  )
  const [error, setError] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(initialSelectedTaskId)
  const [runMetrics, setRunMetrics] = useState<Record<number, TaskRunMetrics>>({})
  const [activeTaskIds, setActiveTaskIds] = useState<Set<number>>(new Set())
  const [agentColumnsData, setAgentColumnsData] = useState<Record<number, TaskAgentColumnData>>({})

  // ROADMAP B-4 "Work" — saved views + "every view is a URL." Seeded once
  // from the URL on mount; kept in sync both ways below.
  const [viewConfig, setViewConfig] = useState<TaskViewConfig>(() => taskViewConfigFromSearchParams(searchParams))
  const [selectedSavedViewId, setSelectedSavedViewId] = useState<number | null>(() => {
    const raw = searchParams.get('savedView')
    return raw ? Number(raw) : null
  })
  const [savedViews, setSavedViews] = useState<SavedView[]>([])
  const [savedViewsBusy, setSavedViewsBusy] = useState(false)
  const [savedViewsError, setSavedViewsError] = useState<string | null>(null)

  // ROADMAP B-4 "Work" — bulk actions. See bulk-action-bar.tsx's own comment
  // for why entering multi-select is a dedicated mode toggle rather than a
  // hover checkbox (drag-and-drop shares the same card hit-target).
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  useEffect(() => {
    setTasksByStatus(Object.fromEntries(columns.map((c) => [c.status.id, c.tasks])))
    setTotalsByStatus(Object.fromEntries(columns.map((c) => [c.status.id, c.totalDocs])))
  }, [columns])

  // Reflect viewConfig + the selected saved view into the URL. `replace`,
  // not `push` — a filter tweak shouldn't spam browser history the way a
  // real navigation would. Only known view-state keys are touched (see
  // `applyTaskViewConfigToSearchParams`), so an unrelated param already on
  // the URL (e.g. `?task=` for the notification deep link) survives.
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString())
    applyTaskViewConfigToSearchParams(params, viewConfig)
    if (selectedSavedViewId != null) params.set('savedView', String(selectedSavedViewId))
    else params.delete('savedView')
    const next = params.toString()
    if (next !== searchParams.toString()) {
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false })
    }
  }, [viewConfig, selectedSavedViewId, searchParams, router, pathname])

  useEffect(() => {
    let active = true
    listSavedViews({ workspaceId: workspace.id, projectId: defaultProjectId })
      .then((views) => {
        if (active) setSavedViews(views)
      })
      .catch((err) => {
        if (active) setSavedViewsError(err instanceof Error ? err.message : 'Failed to load saved views.')
      })
    return () => {
      active = false
    }
  }, [workspace.id, defaultProjectId])

  function findTask(taskId: number): { task: Task; statusId: number } | null {
    for (const [statusId, tasks] of Object.entries(tasksByStatus)) {
      const task = tasks.find((t) => t.id === taskId)
      if (task) return { task, statusId: Number(statusId) }
    }
    return null
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const taskId = Number(String(active.id).slice(DRAG_PREFIX.length))
    const targetStatusId = Number(String(over.id).slice(DROP_PREFIX.length))
    const found = findTask(taskId)
    if (!found || found.statusId === targetStatusId) return

    setError(null)
    const { task } = found
    setTasksByStatus((prev) => ({
      ...prev,
      [found.statusId]: prev[found.statusId].filter((t) => t.id !== taskId),
      [targetStatusId]: [...(prev[targetStatusId] ?? []), { ...task, status: targetStatusId }],
    }))

    moveTaskToStatus({ taskId, workspaceId: workspace.id, workspaceSlug: workspace.slug, statusId: targetStatusId }).catch(
      (err) => {
        setError(err instanceof Error ? err.message : 'Failed to move task.')
        setTasksByStatus(Object.fromEntries(columns.map((c) => [c.status.id, c.tasks])))
      },
    )
  }

  async function handleAddTask(statusId: number, title: string) {
    if (!currentUserId) {
      setError('You must be logged in to create a task.')
      return
    }
    try {
      const created = await createTask({
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        statusId,
        title,
        createdById: currentUserId,
        ...(defaultProjectId ? { projectId: defaultProjectId } : {}),
      })
      setTasksByStatus((prev) => ({ ...prev, [statusId]: [...(prev[statusId] ?? []), created] }))
      setTotalsByStatus((prev) => ({ ...prev, [statusId]: (prev[statusId] ?? 0) + 1 }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task.')
    }
  }

  async function handleLoadMore(statusId: number) {
    const current = tasksByStatus[statusId] ?? []
    try {
      const more = await loadMoreTasks({ workspaceId: workspace.id, statusId, offset: current.length, limit: pageSize })
      setTasksByStatus((prev) => ({ ...prev, [statusId]: [...current, ...more] }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more tasks.')
    }
  }

  function handleTaskUpdated(updated: Task) {
    setTasksByStatus((prev) => {
      const next = { ...prev }
      for (const statusId of Object.keys(next)) {
        next[Number(statusId)] = next[Number(statusId)].map((t) => (t.id === updated.id ? updated : t))
      }
      return next
    })
  }

  const selectedTask = selectedTaskId != null ? findTask(selectedTaskId)?.task ?? null : null
  const allTasks = useMemo(() => Object.values(tasksByStatus).flat(), [tasksByStatus])

  const statusCategoryById = useMemo(() => new Map(columns.map((c) => [c.status.id, c.status.category])), [columns])
  const visibleStatusColumns = useMemo(
    () =>
      viewConfig.filters.statusCategory
        ? columns.filter((c) => c.status.category === viewConfig.filters.statusCategory)
        : columns,
    [columns, viewConfig.filters.statusCategory],
  )
  const filteredAllTasks = useMemo(
    () => allTasks.filter((t) => matchesFilters(t, viewConfig.filters, statusCategoryById)),
    [allTasks, viewConfig.filters, statusCategoryById],
  )
  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  /** The workspace's status whose category is 'cancelled' — the bulk
   * Archive action's real, working target until `tasks.archived` exists
   * (see matchesFilters's comment above). Null if the workspace has none
   * configured, in which case the Archive button disables itself. */
  const archiveStatus = useMemo(() => columns.find((c) => c.status.category === 'cancelled')?.status ?? null, [columns])

  const selectedSavedView = useMemo(
    () => savedViews.find((v) => v.id === selectedSavedViewId) ?? null,
    [savedViews, selectedSavedViewId],
  )
  const baselineConfig = useMemo(() => (selectedSavedView ? savedViewConfig(selectedSavedView) : null), [selectedSavedView])

  function handleSelectSavedView(id: number | null) {
    setSelectedSavedViewId(id)
    if (id == null) return
    const view = savedViews.find((v) => v.id === id)
    if (view) setViewConfig(savedViewConfig(view))
  }

  async function handleSaveNewView(name: string, scope: SavedViewScope) {
    setSavedViewsBusy(true)
    setSavedViewsError(null)
    try {
      const created = await createSavedView({ workspaceId: workspace.id, projectId: defaultProjectId, name, scope, config: viewConfig })
      setSavedViews((prev) => [...prev, created])
      setSelectedSavedViewId(created.id)
    } catch (err) {
      setSavedViewsError(err instanceof Error ? err.message : 'Failed to save view.')
    } finally {
      setSavedViewsBusy(false)
    }
  }

  async function handleUpdateView() {
    if (selectedSavedViewId == null) return
    setSavedViewsBusy(true)
    setSavedViewsError(null)
    try {
      const updated = await updateSavedView({ id: selectedSavedViewId, config: viewConfig })
      setSavedViews((prev) => prev.map((v) => (v.id === updated.id ? updated : v)))
    } catch (err) {
      setSavedViewsError(err instanceof Error ? err.message : 'Failed to update view.')
    } finally {
      setSavedViewsBusy(false)
    }
  }

  function handleRevertView() {
    if (baselineConfig) setViewConfig(baselineConfig)
  }

  async function handleDeleteView() {
    if (selectedSavedViewId == null) return
    setSavedViewsBusy(true)
    setSavedViewsError(null)
    try {
      await deleteSavedView(selectedSavedViewId)
      setSavedViews((prev) => prev.filter((v) => v.id !== selectedSavedViewId))
      setSelectedSavedViewId(null)
    } catch (err) {
      setSavedViewsError(err instanceof Error ? err.message : 'Failed to delete view.')
    } finally {
      setSavedViewsBusy(false)
    }
  }

  function toggleSelectMode() {
    setSelectMode((prev) => !prev)
    setSelectedIds(new Set())
  }
  function toggleTaskSelected(taskId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  async function runBulkUpdate(data: Partial<Pick<Task, 'status' | 'assignee' | 'agent' | 'project'>>) {
    if (selectedIds.size === 0) return
    setBulkBusy(true)
    setError(null)
    try {
      const updated = await bulkUpdateTaskFields({ taskIds: Array.from(selectedIds), workspaceSlug: workspace.slug, data })
      setTasksByStatus((prev) => {
        const next: Record<number, Task[]> = {}
        for (const statusId of Object.keys(prev)) next[Number(statusId)] = prev[Number(statusId)]
        for (const task of updated) {
          for (const statusId of Object.keys(next)) {
            next[Number(statusId)] = next[Number(statusId)].filter((t) => t.id !== task.id)
          }
          const taskStatusId = statusIdOf(task)
          next[taskStatusId] = [...(next[taskStatusId] ?? []), task]
        }
        return next
      })
      setSelectedIds(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk update failed.')
    } finally {
      setBulkBusy(false)
    }
  }

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

  // ROADMAP B-4 "Work" (agent columns: Runs / Last run outcome / Spend) —
  // one batched server-action round trip for the whole board, polled on the
  // same 4s cadence as `refreshMetrics`/`refreshPresence` above.
  useEffect(() => {
    let active = true
    async function refreshAgentColumns() {
      const ids = allTasks.map((t) => t.id)
      if (ids.length === 0) {
        if (active) setAgentColumnsData({})
        return
      }
      const data = await getTaskAgentColumnsData(ids)
      if (active) setAgentColumnsData(data)
    }
    void refreshAgentColumns().catch(() => undefined)
    const timer = window.setInterval(() => { void refreshAgentColumns().catch(() => undefined) }, 4000)
    return () => { active = false; window.clearInterval(timer) }
  }, [allTasks])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-black/5 px-6 py-3 dark:border-white/10">
        <h1 className="text-lg font-semibold">Tasks</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleSelectMode}
            className={`rounded-md border px-2 py-1 text-xs font-medium ${
              selectMode
                ? 'border-black bg-black text-white dark:border-white dark:bg-white dark:text-black'
                : 'border-black/10 text-black/60 hover:bg-black/[.06] dark:border-white/10 dark:text-white/60 dark:hover:bg-white/[.08]'
            }`}
          >
            {selectMode ? 'Cancel select' : 'Select'}
          </button>
          <div className="flex rounded-md border border-black/10 p-0.5 text-xs dark:border-white/10">
            {(['board', 'list', 'table'] as const).map((item) => (
              <button key={item} type="button" onClick={() => setViewConfig((prev) => ({ ...prev, view: item }))} className={`rounded px-2 py-1 capitalize ${viewConfig.view === item ? 'bg-black/[.08] font-medium dark:bg-white/[.12]' : 'text-black/50 dark:text-white/50'}`}>
                {item}
              </button>
            ))}
          </div>
        </div>
      </div>

      <TaskViewBar
        config={viewConfig}
        onChange={setViewConfig}
        assignableUsers={assignableUsers}
        agents={agents}
        projects={projects}
        savedViews={savedViews}
        selectedSavedViewId={selectedSavedViewId}
        baselineConfig={baselineConfig}
        busy={savedViewsBusy}
        canSaveProjectScope={defaultProjectId != null}
        onSelectSavedView={handleSelectSavedView}
        onSaveNewView={(name, scope) => void handleSaveNewView(name, scope)}
        onUpdateView={() => void handleUpdateView()}
        onRevertView={handleRevertView}
        onDeleteView={() => void handleDeleteView()}
      />

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-6 py-1.5 text-xs text-red-600 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </div>
      )}
      {savedViewsError && (
        <div className="border-b border-red-200 bg-red-50 px-6 py-1.5 text-xs text-red-600 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400">
          {savedViewsError}
        </div>
      )}

      {viewConfig.view === 'board' ? (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div className="flex flex-1 gap-3 overflow-x-auto p-4">
            {visibleStatusColumns.map((col) => (
              <TaskColumn
                key={col.status.id}
                status={col.status}
                tasks={(tasksByStatus[col.status.id] ?? []).filter((t) => matchesFilters(t, viewConfig.filters, statusCategoryById))}
                totalDocs={totalsByStatus[col.status.id] ?? 0}
                runMetrics={runMetrics}
                activeTaskIds={activeTaskIds}
                agentsById={agentsById}
                agentColumnsData={agentColumnsData}
                columnsVisibility={viewConfig.columns}
                density={viewConfig.density}
                selectMode={selectMode}
                selectedIds={selectedIds}
                onOpenTask={setSelectedTaskId}
                onToggleSelect={toggleTaskSelected}
                onAddTask={(title) => void handleAddTask(col.status.id, title)}
                onLoadMore={() => void handleLoadMore(col.status.id)}
              />
            ))}
          </div>
        </DndContext>
      ) : viewConfig.view === 'list' ? (
        <TaskListView
          tasks={filteredAllTasks}
          groupBy={viewConfig.groupBy}
          columns={columns}
          runMetrics={runMetrics}
          activeTaskIds={activeTaskIds}
          density={viewConfig.density}
          onOpenTask={setSelectedTaskId}
        />
      ) : (
        <TaskTableView
          tasks={filteredAllTasks}
          columns={columns}
          runMetrics={runMetrics}
          activeTaskIds={activeTaskIds}
          density={viewConfig.density}
          sort={viewConfig.sort}
          onSortChange={(sort) => setViewConfig((prev) => ({ ...prev, sort }))}
          visibleColumns={viewConfig.columns}
          agentsById={agentsById}
          agentColumnsData={agentColumnsData}
          onOpenTask={setSelectedTaskId}
        />
      )}

      {selectedIds.size > 0 && (
        <BulkActionBar
          selectedCount={selectedIds.size}
          statuses={columns.map((c) => c.status)}
          agents={agents}
          projects={projects}
          archiveStatus={archiveStatus}
          busy={bulkBusy}
          onChangeStatus={(statusId) => void runBulkUpdate({ status: statusId })}
          onAssignAgent={(agentId) => void runBulkUpdate({ agent: agentId })}
          onAddToProject={(projectId) => void runBulkUpdate({ project: projectId })}
          onArchive={() => archiveStatus && void runBulkUpdate({ status: archiveStatus.id })}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          workspace={workspace}
          projects={projects}
          statuses={columns.map((c) => c.status)}
          assignableUsers={assignableUsers}
          agents={agents}
          onClose={() => setSelectedTaskId(null)}
          onUpdated={handleTaskUpdated}
        />
      )}
    </div>
  )
}

function TaskListView({
  tasks,
  groupBy,
  columns,
  runMetrics,
  activeTaskIds,
  density,
  onOpenTask,
}: {
  tasks: Task[]
  groupBy: TaskViewGroupBy
  columns: ColumnData[]
  runMetrics: Record<number, TaskRunMetrics>
  activeTaskIds: Set<number>
  density: TaskViewDensity
  onOpenTask: (id: number) => void
}) {
  const groups = useMemo(() => groupTasksForList(tasks, groupBy, columns), [tasks, groupBy, columns])
  const rows = useMemo(
    () =>
      groups.flatMap((group) =>
        group.label
          ? [{ kind: 'header' as const, id: `group-${group.key}`, label: group.label }, ...group.tasks.map((task) => ({ kind: 'task' as const, id: `task-${task.id}`, task }))]
          : group.tasks.map((task) => ({ kind: 'task' as const, id: `task-${task.id}`, task })),
      ),
    [groups],
  )
  const parentRef = useMemo(() => ({ current: null as HTMLDivElement | null }), [])
  const headerSize = density === 'compact' ? 28 : 36
  const rowSize = density === 'compact' ? 40 : 52
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: (index) => rows[index].kind === 'header' ? headerSize : rowSize, overscan: 8 })
  return <div ref={parentRef} className="min-h-0 flex-1 overflow-auto p-4"><div className="relative" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map((item) => { const row = rows[item.index]; return <div key={row.id} className="absolute left-0 right-0" style={{ transform: `translateY(${item.start}px)` }}>{row.kind === 'header' ? <div style={{ height: headerSize }} className="flex items-center border-b border-black/10 px-2 text-xs font-semibold text-black/50 dark:border-white/10 dark:text-white/50">{row.label}</div> : <button type="button" onClick={() => onOpenTask(row.task.id)} style={{ height: rowSize }} className="flex w-full items-center justify-between border-b border-black/5 px-3 text-left text-sm hover:bg-black/[.03] dark:hover:bg-white/[.04]"><span className="truncate">{row.task.title || 'Untitled'}</span><span className="flex items-center gap-3"><AgentPresence active={activeTaskIds.has(row.task.id)} /><TaskMeta task={row.task} /><RunMetrics metrics={runMetrics[row.task.id]} /></span></button>}</div> })}</div></div>
}

function TaskMeta({ task }: { task: Task }) { const project = typeof task.project === 'object' ? task.project?.name : null; const assignee = typeof task.assignee === 'object' ? task.assignee?.name : null; return <span className="ml-3 shrink-0 text-xs text-black/40 dark:text-white/40">{project || assignee || ''}</span> }

function TaskTableView({
  tasks,
  columns,
  runMetrics,
  activeTaskIds,
  density,
  sort,
  onSortChange,
  visibleColumns,
  agentsById,
  agentColumnsData,
  onOpenTask,
}: {
  tasks: Task[]
  columns: ColumnData[]
  runMetrics: Record<number, TaskRunMetrics>
  activeTaskIds: Set<number>
  density: TaskViewDensity
  sort: TaskViewSort | null
  onSortChange: (sort: TaskViewSort | null) => void
  visibleColumns: TaskViewColumns
  agentsById: Map<number, Agent>
  agentColumnsData: Record<number, TaskAgentColumnData>
  onOpenTask: (id: number) => void
}) {
  const statusById = useMemo(() => new Map(columns.map((column) => [column.status.id, column.status.name])), [columns])
  const sorting: SortingState = useMemo(() => (sort ? [{ id: sort.field, desc: sort.direction === 'desc' }] : []), [sort])
  const columnDefs = useMemo<ColumnDef<Task>[]>(() => {
    const base: ColumnDef<Task>[] = [
      { accessorKey: 'title', header: 'Title', cell: (info) => info.getValue<string>() || 'Untitled' },
      { id: 'status', accessorFn: (task) => statusById.get(typeof task.status === 'number' ? task.status : task.status.id) || '', header: 'Status' },
      { id: 'assignee', accessorFn: (task) => typeof task.assignee === 'object' ? task.assignee?.name || task.assignee?.email || '' : '', header: 'Assignee' },
      { id: 'project', accessorFn: (task) => typeof task.project === 'object' ? task.project?.name || '' : '', header: 'Project' },
      { accessorKey: 'position', header: 'Position' },
      { accessorKey: 'updatedAt', header: 'Updated' },
    ]
    if (visibleColumns.agent) {
      base.push({
        id: 'agentColumn',
        header: 'Agent',
        cell: ({ row }) => {
          const agentId = typeof row.original.agent === 'object' ? row.original.agent?.id ?? null : row.original.agent ?? null
          return <AgentColumn agent={agentId != null ? agentsById.get(agentId) ?? null : null} />
        },
      })
    }
    if (visibleColumns.runs) {
      base.push({ id: 'runsColumn', header: 'Runs', cell: ({ row }) => <RunsColumn count={agentColumnsData[row.original.id]?.runCount ?? 0} /> })
    }
    if (visibleColumns.lastRunOutcome) {
      base.push({ id: 'lastRunOutcomeColumn', header: 'Last run', cell: ({ row }) => <LastRunOutcomeColumn status={agentColumnsData[row.original.id]?.lastRunStatus ?? null} /> })
    }
    if (visibleColumns.spend) {
      base.push({ id: 'spendColumn', header: 'Spend', cell: ({ row }) => <SpendColumn totalCostTicks={agentColumnsData[row.original.id]?.totalCostTicks ?? 0} /> })
    }
    return base
  }, [statusById, visibleColumns, agentsById, agentColumnsData])

  const table = useReactTable({
    data: tasks,
    columns: columnDefs,
    state: { sorting },
    onSortingChange: (updater) => {
      const nextSorting = typeof updater === 'function' ? updater(sorting) : updater
      const next = nextSorting[0]
      onSortChange(next ? { field: next.id as TaskViewSortField, direction: next.desc ? 'desc' : 'asc' } : null)
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })
  const parentRef = useMemo(() => ({ current: null as HTMLDivElement | null }), [])
  const rowSize = density === 'compact' ? 36 : 48
  const virtualizer = useVirtualizer({ count: table.getRowModel().rows.length, getScrollElement: () => parentRef.current, estimateSize: () => rowSize, overscan: 8 })
  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto p-4">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="sticky top-0 z-10 bg-white dark:bg-[#191919]">
          <tr>
            {table.getFlatHeaders().map((header) => (
              <th key={header.id} className="border-b border-black/10 px-3 py-2 font-medium dark:border-white/10">
                <button type="button" onClick={header.column.getToggleSortingHandler()}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {header.column.getIsSorted() === 'asc' ? ' ↑' : header.column.getIsSorted() === 'desc' ? ' ↓' : ''}
                </button>
              </th>
            ))}
            {visibleColumns.live && <th className="border-b border-black/10 px-3 py-2 font-medium dark:border-white/10">Live</th>}
          </tr>
        </thead>
        <tbody>
          {virtualizer.getVirtualItems().map((item) => {
            const row = table.getRowModel().rows[item.index]
            return (
              <tr key={row.id} style={{ height: rowSize }} onClick={() => onOpenTask(row.original.id)} className="cursor-pointer hover:bg-black/[.03] dark:hover:bg-white/[.04]">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="border-b border-black/5 px-3 py-2 dark:border-white/10">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
                {visibleColumns.live && (
                  <td className="border-b border-black/5 px-3 py-2 dark:border-white/10">
                    <span className="flex items-center gap-2">
                      <LiveDot active={activeTaskIds.has(row.original.id)} />
                      <RunMetrics metrics={runMetrics[row.original.id]} />
                    </span>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TaskColumn({
  status,
  tasks,
  totalDocs,
  runMetrics,
  activeTaskIds,
  agentsById,
  agentColumnsData,
  columnsVisibility,
  density,
  selectMode,
  selectedIds,
  onOpenTask,
  onToggleSelect,
  onAddTask,
  onLoadMore,
}: {
  status: TaskStatus
  tasks: Task[]
  totalDocs: number
  runMetrics: Record<number, TaskRunMetrics>
  activeTaskIds: Set<number>
  agentsById: Map<number, Agent>
  agentColumnsData: Record<number, TaskAgentColumnData>
  columnsVisibility: TaskViewColumns
  density: TaskViewDensity
  selectMode: boolean
  selectedIds: Set<number>
  onOpenTask: (taskId: number) => void
  onToggleSelect: (taskId: number) => void
  onAddTask: (title: string) => void
  onLoadMore: () => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${DROP_PREFIX}${status.id}` })
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  function submitDraft() {
    const title = draft.trim()
    setDraft('')
    setAdding(false)
    if (title) onAddTask(title)
  }

  return (
    <div
      ref={setNodeRef}
      className={`flex w-72 shrink-0 flex-col rounded-lg border ${
        isOver ? 'border-black/30 dark:border-white/30' : 'border-black/10 dark:border-white/10'
      } bg-black/[.015] dark:bg-white/[.02]`}
    >
      <div className="flex items-center justify-between gap-2 px-2 py-2">
        <span className={`truncate rounded px-1.5 py-0.5 text-xs font-medium ${statusColorClasses(status.color)}`}>
          {status.name}
        </span>
        <span className="shrink-0 text-xs text-black/30 dark:text-white/30">{totalDocs}</span>
      </div>
      <div className={`flex min-h-[40px] flex-1 flex-col px-2 pb-2 ${density === 'compact' ? 'gap-1' : 'gap-1.5'}`}>
        {tasks.map((task) => {
          const agentId = typeof task.agent === 'object' ? task.agent?.id ?? null : task.agent ?? null
          return (
            <TaskCard
              key={task.id}
              task={task}
              metrics={runMetrics[task.id]}
              active={activeTaskIds.has(task.id)}
              agent={agentId != null ? agentsById.get(agentId) ?? null : null}
              columnData={agentColumnsData[task.id]}
              columnsVisibility={columnsVisibility}
              density={density}
              selectMode={selectMode}
              selected={selectedIds.has(task.id)}
              onOpen={() => onOpenTask(task.id)}
              onToggleSelect={onToggleSelect}
            />
          )
        })}
        {tasks.length < totalDocs && (
          <button
            type="button"
            onClick={onLoadMore}
            className="rounded px-2 py-1 text-left text-xs text-black/40 hover:bg-black/[.06] dark:text-white/40 dark:hover:bg-white/[.08]"
          >
            Load more ({tasks.length}/{totalDocs})
          </button>
        )}
      </div>
      <div className="px-2 pb-2">
        {adding ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={submitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitDraft()
              if (e.key === 'Escape') {
                setDraft('')
                setAdding(false)
              }
            }}
            placeholder="Task title"
            className="w-full rounded border border-black/10 bg-white px-2 py-1 text-sm outline-none dark:border-white/10 dark:bg-[#2a2a2a]"
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 rounded px-2 py-1 text-left text-xs text-black/40 hover:bg-black/[.06] dark:text-white/40 dark:hover:bg-white/[.08]"
          >
            <Plus size={12} /> Add task
          </button>
        )}
      </div>
    </div>
  )
}

function TaskCard({
  task,
  metrics,
  active,
  agent,
  columnData,
  columnsVisibility,
  density,
  selectMode,
  selected,
  onOpen,
  onToggleSelect,
}: {
  task: Task
  metrics?: TaskRunMetrics
  active?: boolean
  agent: Agent | null
  columnData?: TaskAgentColumnData
  columnsVisibility: TaskViewColumns
  density: TaskViewDensity
  selectMode: boolean
  selected: boolean
  onOpen: () => void
  onToggleSelect: (taskId: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `${DRAG_PREFIX}${task.id}`, disabled: selectMode })
  const assignee = typeof task.assignee === 'object' ? task.assignee : null
  const project = typeof task.project === 'object' ? task.project : null
  const padding = density === 'compact' ? 'p-1.5' : 'p-2'
  const showAgentRow = columnsVisibility.agent || columnsVisibility.runs || columnsVisibility.lastRunOutcome || columnsVisibility.spend

  return (
    <div
      ref={setNodeRef}
      {...(selectMode ? {} : listeners)}
      {...(selectMode ? {} : attributes)}
      onClick={() => (selectMode ? onToggleSelect(task.id) : onOpen())}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 10 } : undefined}
      className={`${padding} rounded-md border text-sm shadow-sm dark:bg-[#2a2a2a] ${
        selected ? 'border-black bg-black/[.03] dark:border-white dark:bg-white/[.06]' : 'border-black/10 bg-white hover:border-black/20 dark:border-white/10 dark:hover:border-white/20'
      } ${selectMode ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'} ${isDragging ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {selectMode && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(task.id)}
              onClick={(e) => e.stopPropagation()}
              className="size-3.5 shrink-0"
              aria-label={`Select ${task.title || 'task'}`}
            />
          )}
          <div className="truncate font-medium">{task.title || 'Untitled'}</div>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {columnsVisibility.live && <LiveDot active={!!active} />}
          <RunMetrics metrics={metrics} />
        </span>
      </div>
      {(project || assignee) && (
        <div className="mt-1 flex items-center justify-between gap-1">
          {project ? (
            <span className="truncate text-xs text-black/50 dark:text-white/50">{project.name}</span>
          ) : (
            <span />
          )}
          {assignee && (
            <span
              title={assignee.name || assignee.email}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/10 text-[10px] font-medium dark:bg-white/10"
            >
              {(assignee.name || assignee.email || '?').slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
      )}
      {showAgentRow && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-black/5 pt-1.5 dark:border-white/10">
          {columnsVisibility.agent && <AgentColumn agent={agent} />}
          {columnsVisibility.runs && <RunsColumn count={columnData?.runCount ?? 0} />}
          {columnsVisibility.lastRunOutcome && <LastRunOutcomeColumn status={columnData?.lastRunStatus ?? null} />}
          {columnsVisibility.spend && <SpendColumn totalCostTicks={columnData?.totalCostTicks ?? 0} />}
        </div>
      )}
    </div>
  )
}
