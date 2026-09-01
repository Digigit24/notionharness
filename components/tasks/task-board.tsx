'use client'

import { useEffect, useState } from 'react'
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { Plus } from 'lucide-react'
import { statusColorClasses } from '@/lib/status-colors'
import { createTask, loadMoreTasks, moveTaskToStatus } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import { TaskDrawer } from './task-drawer'
import type { Project, Task, TaskStatus, User, Workspace } from '@/payload-types'

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

export function TaskBoard({
  workspace,
  columns,
  projects,
  assignableUsers,
  currentUserId,
  pageSize,
}: {
  workspace: Workspace
  columns: ColumnData[]
  projects: Project[]
  assignableUsers: User[]
  currentUserId: number | null
  pageSize: number
}) {
  const [tasksByStatus, setTasksByStatus] = useState<Record<number, Task[]>>(() =>
    Object.fromEntries(columns.map((c) => [c.status.id, c.tasks])),
  )
  const [totalsByStatus, setTotalsByStatus] = useState<Record<number, number>>(() =>
    Object.fromEntries(columns.map((c) => [c.status.id, c.totalDocs])),
  )
  const [error, setError] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)

  useEffect(() => {
    setTasksByStatus(Object.fromEntries(columns.map((c) => [c.status.id, c.tasks])))
    setTotalsByStatus(Object.fromEntries(columns.map((c) => [c.status.id, c.totalDocs])))
  }, [columns])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-black/5 px-6 py-3 dark:border-white/10">
        <h1 className="text-lg font-semibold">Tasks</h1>
      </div>
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-6 py-1.5 text-xs text-red-600 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </div>
      )}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex flex-1 gap-3 overflow-x-auto p-4">
          {columns.map((col) => (
            <TaskColumn
              key={col.status.id}
              status={col.status}
              tasks={tasksByStatus[col.status.id] ?? []}
              totalDocs={totalsByStatus[col.status.id] ?? 0}
              onOpenTask={setSelectedTaskId}
              onAddTask={(title) => void handleAddTask(col.status.id, title)}
              onLoadMore={() => void handleLoadMore(col.status.id)}
            />
          ))}
        </div>
      </DndContext>

      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          workspace={workspace}
          projects={projects}
          statuses={columns.map((c) => c.status)}
          assignableUsers={assignableUsers}
          onClose={() => setSelectedTaskId(null)}
          onUpdated={handleTaskUpdated}
        />
      )}
    </div>
  )
}

function TaskColumn({
  status,
  tasks,
  totalDocs,
  onOpenTask,
  onAddTask,
  onLoadMore,
}: {
  status: TaskStatus
  tasks: Task[]
  totalDocs: number
  onOpenTask: (taskId: number) => void
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
      <div className="flex min-h-[40px] flex-1 flex-col gap-1.5 px-2 pb-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onOpen={() => onOpenTask(task.id)} />
        ))}
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

function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `${DRAG_PREFIX}${task.id}` })
  const assignee = typeof task.assignee === 'object' ? task.assignee : null
  const project = typeof task.project === 'object' ? task.project : null

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onOpen}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 10 } : undefined}
      className={`cursor-grab rounded-md border border-black/10 bg-white p-2 text-sm shadow-sm hover:border-black/20 active:cursor-grabbing dark:border-white/10 dark:bg-[#2a2a2a] dark:hover:border-white/20 ${
        isDragging ? 'opacity-50' : ''
      }`}
    >
      <div className="truncate font-medium">{task.title || 'Untitled'}</div>
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
    </div>
  )
}
