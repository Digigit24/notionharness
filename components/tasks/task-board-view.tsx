'use client'

// ROADMAP B-4.1 — the board's dnd-kit rendering, extracted verbatim out of
// `task-board.tsx` (data fetching/filtering stayed behind in
// `use-task-view-data.ts`; this file is pure rendering). Behavior is
// unchanged from the pre-B4 board: same columns, same cards, same
// column-level-only drag-and-drop (see the header comment this file
// inherited below for why).
//
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
import { useState } from 'react'
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { Plus } from 'lucide-react'
import { statusColorClasses } from '@/lib/status-colors'
import { AgentPresence, RunMetrics, type TaskRunMetrics } from './run-metrics'
import type { BoardColumnData } from './use-task-view-data'
import type { Task, TaskStatus } from '@/payload-types'

const DRAG_PREFIX = 'task-'
const DROP_PREFIX = 'col-'

export function TaskBoardView({
  columns,
  runMetrics,
  activeTaskIds,
  onOpenTask,
  onDragEnd,
  onAddTask,
  onLoadMore,
}: {
  columns: BoardColumnData[]
  runMetrics: Record<number, TaskRunMetrics>
  activeTaskIds: Set<number>
  onOpenTask: (taskId: number) => void
  onDragEnd: (taskId: number, targetStatusId: number) => void
  onAddTask: (statusId: number, title: string) => void
  onLoadMore: (statusId: number) => void
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const taskId = Number(String(active.id).slice(DRAG_PREFIX.length))
    const targetStatusId = Number(String(over.id).slice(DROP_PREFIX.length))
    onDragEnd(taskId, targetStatusId)
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex flex-1 gap-3 overflow-x-auto p-4">
        {columns.map((col) => (
          <TaskColumn
            key={col.status.id}
            status={col.status}
            tasks={col.tasks}
            totalDocs={col.totalDocs}
            runMetrics={runMetrics}
            activeTaskIds={activeTaskIds}
            onOpenTask={onOpenTask}
            onAddTask={(title) => onAddTask(col.status.id, title)}
            onLoadMore={() => onLoadMore(col.status.id)}
          />
        ))}
      </div>
    </DndContext>
  )
}

function TaskColumn({
  status,
  tasks,
  totalDocs,
  runMetrics,
  activeTaskIds,
  onOpenTask,
  onAddTask,
  onLoadMore,
}: {
  status: TaskStatus
  tasks: Task[]
  totalDocs: number
  runMetrics: Record<number, TaskRunMetrics>
  activeTaskIds: Set<number>
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
          <TaskCard key={task.id} task={task} metrics={runMetrics[task.id]} active={activeTaskIds.has(task.id)} onOpen={() => onOpenTask(task.id)} />
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

function TaskCard({ task, metrics, active, onOpen }: { task: Task; metrics?: TaskRunMetrics; active?: boolean; onOpen: () => void }) {
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
      <div className="flex items-center justify-between gap-2"><div className="truncate font-medium">{task.title || 'Untitled'}</div><span className="flex items-center gap-2"><AgentPresence active={active} /><RunMetrics metrics={metrics} /></span></div>
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
