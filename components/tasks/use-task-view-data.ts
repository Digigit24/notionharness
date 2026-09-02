'use client'

/**
 * ROADMAP B-4.1 — the client half of the shared task data/filter layer.
 * `lib/task-views/data-layer.ts` owns the pure filter/sort/group *model*;
 * this hook owns the *state* (what's currently selected, what's been
 * fetched, which view is active) and the *writes* (create/move/patch, all
 * delegating to the existing `tasks/actions.ts` server actions — no second
 * write path). `TaskBoard`, `TaskListView` and `TaskTableView` each call
 * this once (lifted to the shared container in `task-board.tsx`) so a
 * filter/sort change and every task edit are visible in all three views
 * immediately, without a page reload.
 *
 * Two data shapes coexist on purpose:
 * - `tasksByStatus`/`totalsByStatus` — the board's pre-existing per-column,
 *   per-page cache (`ColumnData[]` from the server component, "load more"
 *   per column). Unchanged in shape/behavior from the pre-B4 board.
 * - `viewTasks` — a flat, cross-column dataset fetched via the new
 *   `getTasksForView` server action, which List and Table need (they show
 *   "all tasks matching the filter," not "the first page of one status").
 *
 * Every write (drag, inline edit, create) updates both caches so switching
 * views never shows stale data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createTask,
  getTasksForView,
  loadMoreTasks,
  moveTaskToStatus,
  updateTaskFields,
} from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import {
  DEFAULT_SORT,
  EMPTY_FILTERS,
  groupTasks,
  sortTasks,
  taskMatchesFilters,
  taskStatusId,
  type TaskFilters,
  type TaskGroup,
  type TaskGroupBy,
  type TaskSort,
} from '@/lib/task-views/data-layer'
import type { Task, TaskStatus, Workspace } from '@/payload-types'

export type TaskViewKind = 'board' | 'list' | 'table'

export interface ColumnData {
  status: TaskStatus
  tasks: Task[]
  totalDocs: number
}

export interface BoardColumnData {
  status: TaskStatus
  tasks: Task[]
  totalDocs: number
}

export function useTaskViewData({
  workspace,
  columns,
  pageSize,
  currentUserId,
  defaultProjectId = null,
}: {
  workspace: Workspace
  columns: ColumnData[]
  pageSize: number
  currentUserId: number | null
  defaultProjectId?: number | null
}) {
  const statuses = useMemo(() => columns.map((c) => c.status), [columns])

  // --- Board's per-column cache (same shape/semantics as the pre-B4 board) ---
  const [tasksByStatus, setTasksByStatus] = useState<Record<number, Task[]>>(() =>
    Object.fromEntries(columns.map((c) => [c.status.id, c.tasks])),
  )
  const [totalsByStatus, setTotalsByStatus] = useState<Record<number, number>>(() =>
    Object.fromEntries(columns.map((c) => [c.status.id, c.totalDocs])),
  )
  useEffect(() => {
    setTasksByStatus(Object.fromEntries(columns.map((c) => [c.status.id, c.tasks])))
    setTotalsByStatus(Object.fromEntries(columns.map((c) => [c.status.id, c.totalDocs])))
  }, [columns])

  const [error, setError] = useState<string | null>(null)

  // --- the shared filter/sort/group model ---
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS)
  const [sort, setSort] = useState<TaskSort>(DEFAULT_SORT)
  const [groupBy, setGroupBy] = useState<TaskGroupBy>('status')
  const [view, setView] = useState<TaskViewKind>('board')

  // --- List/Table's flat, cross-column dataset ---
  const [viewTasks, setViewTasks] = useState<Task[] | null>(null)
  const [viewTotal, setViewTotal] = useState(0)
  const [viewLoading, setViewLoading] = useState(false)
  const requestId = useRef(0)

  const refreshViewTasks = useCallback(async () => {
    const id = ++requestId.current
    setViewLoading(true)
    try {
      const result = await getTasksForView({ workspaceId: workspace.id, filters, sort })
      if (id !== requestId.current) return // superseded by a newer request
      setViewTasks(result.docs)
      setViewTotal(result.totalDocs)
    } catch (err) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : 'Failed to load tasks.')
    } finally {
      if (id === requestId.current) setViewLoading(false)
    }
  }, [workspace.id, filters, sort])

  useEffect(() => {
    if (view === 'list' || view === 'table') void refreshViewTasks()
  }, [view, refreshViewTasks])

  // --- Board's filtered-per-column view. Same `taskMatchesFilters`
  // predicate `getTasksForView`'s `buildTasksWhere` uses server-side,
  // applied here over the already-loaded board cache — a filter set means
  // the same thing whether it narrows an in-memory column or a fresh query. ---
  const boardColumns: BoardColumnData[] = useMemo(() => {
    return statuses
      .filter((status) => !filters.statusIds || filters.statusIds.includes(status.id))
      .map((status) => ({
        status,
        tasks: (tasksByStatus[status.id] ?? []).filter((t) => taskMatchesFilters(t, filters)),
        totalDocs: totalsByStatus[status.id] ?? 0,
      }))
  }, [statuses, tasksByStatus, totalsByStatus, filters])

  const listGroups: TaskGroup[] = useMemo(() => {
    const sorted = sortTasks(viewTasks ?? [], sort)
    return groupTasks(sorted, groupBy, statuses)
  }, [viewTasks, sort, groupBy, statuses])

  const tableTasks = useMemo(() => sortTasks(viewTasks ?? [], sort), [viewTasks, sort])

  const findTask = useCallback(
    (taskId: number): { task: Task; statusId: number } | null => {
      for (const [statusId, tasks] of Object.entries(tasksByStatus)) {
        const task = tasks.find((t) => t.id === taskId)
        if (task) return { task, statusId: Number(statusId) }
      }
      const flat = viewTasks?.find((t) => t.id === taskId)
      return flat ? { task: flat, statusId: taskStatusId(flat) } : null
    },
    [tasksByStatus, viewTasks],
  )

  /** Moves a task's cached copy between `tasksByStatus` buckets (or replaces
   * it in place when the status didn't change) — the one place board-cache
   * relocation happens, used by drag-and-drop, inline status edits, AND
   * keyboard-driven archive, so all three never disagree about which column
   * a task is cached under. */
  function relocateInBoardCache(taskId: number, task: Task, fromStatusId: number, toStatusId: number) {
    if (fromStatusId === toStatusId) {
      setTasksByStatus((prev) => ({
        ...prev,
        [toStatusId]: (prev[toStatusId] ?? []).map((t) => (t.id === taskId ? task : t)),
      }))
      return
    }
    setTasksByStatus((prev) => ({
      ...prev,
      [fromStatusId]: (prev[fromStatusId] ?? []).filter((t) => t.id !== taskId),
      [toStatusId]: [...(prev[toStatusId] ?? []), task],
    }))
  }

  /** Board drag-and-drop's status-change path — identical optimistic-update
   * shape to the pre-B4 board's `handleDragEnd`, just taking plain
   * `(taskId, targetStatusId)` instead of a dnd-kit `DragEndEvent` so it can
   * also be called from keyboard-driven actions (archive) and, in principle,
   * a future non-drag status-change UI. */
  function handleDragEnd(taskId: number, targetStatusId: number) {
    const found = findTask(taskId)
    if (!found || found.statusId === targetStatusId) return
    setError(null)
    const updatedTask = { ...found.task, status: targetStatusId }
    relocateInBoardCache(taskId, updatedTask, found.statusId, targetStatusId)
    setViewTasks((prev) => (prev ? prev.map((t) => (t.id === taskId ? updatedTask : t)) : prev))

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
      setViewTasks((prev) => (prev ? [...prev, created] : prev))
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

  /** Applies a fresh copy of a task (from any write) to both caches — the
   * board's per-column bucket (relocating it if its status changed) and
   * List/Table's flat `viewTasks`. */
  function handleTaskUpdated(updated: Task) {
    const found = findTask(updated.id)
    const newStatusId = taskStatusId(updated)
    if (found && found.statusId !== newStatusId) {
      relocateInBoardCache(updated.id, updated, found.statusId, newStatusId)
    } else {
      setTasksByStatus((prev) => {
        const next = { ...prev }
        for (const statusId of Object.keys(next)) {
          next[Number(statusId)] = next[Number(statusId)].map((t) => (t.id === updated.id ? updated : t))
        }
        return next
      })
    }
    setViewTasks((prev) => (prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev))
  }

  /** Inline-edit entry point for List/Table (and the drawer) — the same
   * `updateTaskFields` server action every surface uses, so there is exactly
   * one write path for a task's fields regardless of which view triggered it. */
  async function patchTask(
    taskId: number,
    data: Partial<Pick<Task, 'title' | 'status' | 'assignee' | 'agent' | 'project'>>,
  ) {
    try {
      const updated = await updateTaskFields({ taskId, workspaceSlug: workspace.slug, data })
      handleTaskUpdated(updated)
      return updated
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update task.')
      return null
    }
  }

  /** B-4.1 keyboard scaffolding ("x select / e archive", left unwired by
   * B-0's keyboard registry for a future list view — this is that future).
   * `tasks` has no `archived` field (checked `collections/Tasks.ts`) and
   * adding one is a schema change out of scope for this pass — the closest
   * real, schema-backed equivalent is moving the task to whichever status
   * has category `cancelled` (falling back to `done`), the same fixed
   * category vocabulary `TASK_STATUS_CATEGORIES` already defines. This is a
   * deliberate interpretation, not a fabricated field — documented again at
   * the call site in `task-list-view.tsx`. */
  async function archiveTasks(taskIds: number[]) {
    const target = statuses.find((s) => s.category === 'cancelled') ?? statuses.find((s) => s.category === 'done')
    if (!target) {
      setError('No "cancelled" or "done" status is configured in this workspace to archive into.')
      return
    }
    for (const taskId of taskIds) {
      const found = findTask(taskId)
      if (!found || found.statusId === target.id) continue
      handleDragEnd(taskId, target.id)
    }
  }

  return {
    statuses,
    view,
    setView,
    error,
    setError,
    filters,
    setFilters,
    sort,
    setSort,
    groupBy,
    setGroupBy,
    boardColumns,
    listGroups,
    tableTasks,
    viewLoading,
    viewTotal,
    findTask,
    handleDragEnd,
    handleAddTask,
    handleLoadMore,
    handleTaskUpdated,
    patchTask,
    archiveTasks,
  }
}

export type UseTaskViewData = ReturnType<typeof useTaskViewData>
