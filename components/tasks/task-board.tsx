'use client'

// ROADMAP B-4 "Work" — this file is the shared task-views *container*. It
// owns: the single `useTaskViewData` hook (the shared data/filter layer
// every view reads, from `lib/task-views/data-layer.ts` via
// `roadmap/b4-list-table`), the view switcher, `<TaskViewBar>` (filters +
// sort + group + columns + density + saved views, from
// `roadmap/b4-views-bulk`), select-mode + bulk actions, and the task drawer.
// Board/List/Table rendering each live in their own file
// (`task-board-view.tsx`, `task-list-view.tsx`, `task-table-view.tsx`).
//
// MERGE RECONCILIATION (2026-09-02): two parallel B-4 branches both rewrote
// this file's body from the same pre-batch base — `b4-list-table` extracted
// the fused fetch/filter/render logic into `useTaskViewData` + the three
// view files (the real architectural fix the plan called out as this
// batch's actual risk); `b4-views-bulk`, working from the OLD fused board
// (it branched in parallel and never saw the extraction), added saved
// views, agent columns and bulk actions on top of it. This file combines
// both: the extraction's architecture, with the second branch's genuinely
// new features layered on. See `lib/task-views/types.ts`'s header comment
// for how the two branches' competing `TaskFilters`/`TaskSort`/`TaskGroupBy`
// vs. `TaskViewConfig` models were reconciled (data-layer's is canonical;
// `TaskViewConfig` now wraps it rather than duplicating it).
//
// SCOPE NOTE: bulk-select and the agent columns are wired into Board only
// (`task-board-view.tsx`'s new optional props) for this pass — List/Table
// don't have them yet. Wiring them into all three views is real additional
// work, not a small part of resolving this conflict; left as a documented
// follow-up rather than silently dropped or half-built into all three.
import { Suspense, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import {
  bulkUpdateTaskFields,
  getActiveRunsForWorkspace,
  getTaskAgentColumnsData,
  getTaskRuns,
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
  taskViewFiltersToTaskFilters,
  type TaskViewConfig,
} from '@/lib/task-views/types'
import type { SavedViewScope } from '@/collections/SavedViews'
import { TaskDrawer } from './task-drawer'
import { TaskViewBar } from './task-view-bar'
import { BulkActionBar } from './bulk-action-bar'
import { TaskBoardView } from './task-board-view'
import { TaskListView } from './task-list-view'
import { TaskTableView } from './task-table-view'
import { useTaskViewData, type ColumnData, type TaskViewKind } from './use-task-view-data'
import type { TaskRunMetrics } from './run-metrics'
import type { Agent, Project, SavedView, Task, User, Workspace } from '@/payload-types'

export type { ColumnData, TaskViewKind } from './use-task-view-data'

const VIEW_LABELS: Record<TaskViewKind, string> = { board: 'Board', list: 'List', table: 'Table' }

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

  const data = useTaskViewData({ workspace, columns, pageSize, currentUserId, defaultProjectId })
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(initialSelectedTaskId)
  const [runMetrics, setRunMetrics] = useState<Record<number, TaskRunMetrics>>({})
  const [activeTaskIds, setActiveTaskIds] = useState<Set<number>>(new Set())
  const [agentColumnsData, setAgentColumnsData] = useState<Record<number, TaskAgentColumnData>>({})
  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  // ROADMAP B-4 "Work" — saved views + "every view is a URL." Seeded once
  // from the URL on mount, then kept in sync both ways below.
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

  // Drive the shared data/filter layer from viewConfig — TaskViewConfig's
  // simpler, URL-friendly filters (single value, status *category*) are
  // adapted into data-layer's TaskFilters (array-valued, status *ids*) via
  // `taskViewFiltersToTaskFilters`; sort/groupBy/view already share the same
  // real types (see lib/task-views/types.ts), so no adapter is needed there.
  useEffect(() => {
    data.setFilters(taskViewFiltersToTaskFilters(viewConfig.filters, data.statuses))
    data.setSort(viewConfig.sort ?? { field: 'position', direction: 'asc' })
    data.setGroupBy(viewConfig.groupBy)
    data.setView(viewConfig.view)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- data's setters are stable; including `data` itself would re-run on every one of its own state updates.
  }, [viewConfig, data.statuses])

  // Reflect viewConfig + the selected saved view into the URL. `replace`,
  // not `push` — a filter tweak shouldn't spam browser history the way a
  // real navigation would. Only known view-state keys are touched, so an
  // unrelated param already on the URL (e.g. `?task=` for the notification
  // deep link) survives.
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

  const listTasks = useMemo(() => data.listGroups.flatMap((g) => g.tasks), [data.listGroups])
  const boardTasks = useMemo(() => data.boardColumns.flatMap((c) => c.tasks), [data.boardColumns])

  // Every task currently visible in ANY view (not just the active one) — run
  // metrics/presence/agent-columns stay warm across a view switch instead of
  // re-fetching from zero every time.
  const allTasks = useMemo(() => {
    const byId = new Map<number, Task>()
    for (const task of boardTasks) byId.set(task.id, task)
    for (const task of listTasks) byId.set(task.id, task)
    for (const task of data.tableTasks) byId.set(task.id, task)
    return [...byId.values()]
  }, [boardTasks, listTasks, data.tableTasks])

  const selectedTask = selectedTaskId != null ? data.findTask(selectedTaskId)?.task ?? null : null

  /** The workspace's status whose category is 'cancelled' — the bulk Archive
   * action's real, working target until `tasks.archived` exists (written,
   * not applied — migrations/20260902_130000_tasks_archived.ts). Null if the
   * workspace has none configured, in which case the Archive button
   * disables itself. Same interpretation `useTaskViewData`'s own
   * `archiveTasks` (the keyboard-driven path) already uses. */
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

  async function runBulkUpdate(patch: Partial<Pick<Task, 'status' | 'assignee' | 'agent' | 'project'>>) {
    if (selectedIds.size === 0) return
    setBulkBusy(true)
    data.setError(null)
    try {
      const updated = await bulkUpdateTaskFields({ taskIds: Array.from(selectedIds), workspaceSlug: workspace.slug, data: patch })
      for (const task of updated) data.handleTaskUpdated(task)
      setSelectedIds(new Set())
    } catch (err) {
      data.setError(err instanceof Error ? err.message : 'Bulk update failed.')
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

  // ROADMAP B-4 "Work" (agent columns: Runs / Last run outcome / Spend) — one
  // batched server-action round trip for the whole board, polled on the same
  // 4s cadence as refreshMetrics/refreshPresence above.
  useEffect(() => {
    let active = true
    async function refreshAgentColumns() {
      const ids = allTasks.map((t) => t.id)
      if (ids.length === 0) {
        if (active) setAgentColumnsData({})
        return
      }
      const columnsData = await getTaskAgentColumnsData(ids)
      if (active) setAgentColumnsData(columnsData)
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
          <Button type="button" variant={selectMode ? 'default' : 'outline'} size="sm" onClick={toggleSelectMode}>
            {selectMode ? 'Cancel select' : 'Select'}
          </Button>
          <Tabs value={viewConfig.view} onValueChange={(v) => setViewConfig((prev) => ({ ...prev, view: v as TaskViewKind }))}>
            <TabsList>
              {(['board', 'list', 'table'] as const).map((item) => (
                <TabsTrigger key={item} value={item}>{VIEW_LABELS[item]}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
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

      {data.error && (
        <div className="border-b border-red-200 bg-red-50 px-6 py-1.5 text-xs text-red-600 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400">
          {data.error}
        </div>
      )}
      {savedViewsError && (
        <div className="border-b border-red-200 bg-red-50 px-6 py-1.5 text-xs text-red-600 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400">
          {savedViewsError}
        </div>
      )}

      {viewConfig.view === 'board' ? (
        <TaskBoardView
          columns={data.boardColumns}
          runMetrics={runMetrics}
          activeTaskIds={activeTaskIds}
          agentsById={agentsById}
          agentColumnsData={agentColumnsData}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onOpenTask={setSelectedTaskId}
          onToggleSelect={toggleTaskSelected}
          onDragEnd={data.handleDragEnd}
          onAddTask={data.handleAddTask}
          onLoadMore={data.handleLoadMore}
        />
      ) : viewConfig.view === 'list' ? (
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

      {selectedIds.size > 0 && (
        <BulkActionBar
          selectedCount={selectedIds.size}
          statuses={data.statuses}
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
