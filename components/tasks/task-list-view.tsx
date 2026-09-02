'use client'

// ROADMAP B-4 — "List is the one people will live in. Board demos well;
// list is where work gets done." Grouped (via the shared data layer's
// `groupTasks`), virtualized (`@tanstack/react-virtual`, already a
// dependency — no hand-rolled virtualization), inline-editable (status/
// assignee change directly in the row, through the same `patchTask` write
// path the drawer uses — no second source of truth), and keyboard-navigable
// via `lib/keyboard/registry.ts`'s `useKeyboardShortcut` under the `'list'`
// scope B-0 explicitly reserved and left unwired for exactly this.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Archive, Check } from 'lucide-react'
import { useKeyboardShortcut } from '@/lib/keyboard/use-keyboard-shortcut'
import { statusColorClasses } from '@/lib/status-colors'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AgentPresence, RunMetrics, type TaskRunMetrics } from './run-metrics'
import type { TaskGroup } from '@/lib/task-views/data-layer'
import type { Task, TaskStatus, User } from '@/payload-types'

type Row =
  | { kind: 'header'; id: string; group: TaskGroup }
  | { kind: 'task'; id: string; task: Task }

export function TaskListView({
  groups,
  statuses,
  assignableUsers,
  runMetrics,
  activeTaskIds,
  loading,
  onOpenTask,
  onPatchTask,
  onArchiveTasks,
}: {
  groups: TaskGroup[]
  statuses: TaskStatus[]
  assignableUsers: User[]
  runMetrics: Record<number, TaskRunMetrics>
  activeTaskIds: Set<number>
  loading: boolean
  onOpenTask: (taskId: number) => void
  onPatchTask: (taskId: number, data: Partial<Pick<Task, 'status' | 'assignee'>>) => void
  onArchiveTasks: (taskIds: number[]) => void
}) {
  const rows = useMemo<Row[]>(
    () =>
      groups.flatMap((group) => [
        { kind: 'header' as const, id: `header-${group.key}`, group },
        ...group.tasks.map((task) => ({ kind: 'task' as const, id: `task-${task.id}`, task })),
      ]),
    [groups],
  )
  const taskIds = useMemo(() => rows.filter((r): r is Row & { kind: 'task' } => r.kind === 'task').map((r) => r.task.id), [rows])

  const parentRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index].kind === 'header' ? 32 : 44),
    overscan: 10,
  })

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [focusedTaskId, setFocusedTaskId] = useState<number | null>(null)

  // Keep focus valid as filters/sort/grouping change the underlying rows.
  useEffect(() => {
    if (focusedTaskId != null && !taskIds.includes(focusedTaskId)) {
      setFocusedTaskId(taskIds[0] ?? null)
    } else if (focusedTaskId == null && taskIds.length > 0) {
      setFocusedTaskId(taskIds[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskIds])

  function moveFocus(delta: 1 | -1) {
    if (taskIds.length === 0) return
    const currentIndex = focusedTaskId != null ? taskIds.indexOf(focusedTaskId) : -1
    const nextIndex = Math.min(taskIds.length - 1, Math.max(0, currentIndex === -1 ? 0 : currentIndex + delta))
    const nextId = taskIds[nextIndex]
    setFocusedTaskId(nextId)
    const rowIndex = rows.findIndex((r) => r.kind === 'task' && r.task.id === nextId)
    if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
  }

  // 'list' scope — only live while this view is mounted (registry.ts's
  // ref-counted activateScope/deactivateScope, one call per hook here).
  useKeyboardShortcut('j', 'Next task', () => moveFocus(1), 'list')
  useKeyboardShortcut('k', 'Previous task', () => moveFocus(-1), 'list')
  useKeyboardShortcut(
    'x',
    'Select/deselect task',
    () => {
      if (focusedTaskId == null) return
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(focusedTaskId)) next.delete(focusedTaskId)
        else next.add(focusedTaskId)
        return next
      })
    },
    'list',
  )
  useKeyboardShortcut(
    'e',
    'Archive selected task(s)',
    () => {
      const ids = selectedIds.size > 0 ? [...selectedIds] : focusedTaskId != null ? [focusedTaskId] : []
      if (ids.length === 0) return
      onArchiveTasks(ids)
      setSelectedIds(new Set())
    },
    'list',
  )
  useKeyboardShortcut(
    'enter',
    'Open focused task',
    () => {
      if (focusedTaskId != null) onOpenTask(focusedTaskId)
    },
    'list',
  )
  useKeyboardShortcut(
    'escape',
    'Clear selection',
    () => setSelectedIds(new Set()),
    'list',
  )

  if (loading && rows.length === 0) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-black/40 dark:text-white/40">Loading tasks…</div>
  }
  if (!loading && rows.length === 0) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-black/40 dark:text-white/40">No tasks match the current filters.</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 border-b border-black/5 bg-black/[.02] px-6 py-1.5 text-xs dark:border-white/10 dark:bg-white/[.03]">
          <span>{selectedIds.size} selected</span>
          <button
            type="button"
            onClick={() => {
              onArchiveTasks([...selectedIds])
              setSelectedIds(new Set())
            }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-black/60 hover:bg-black/[.06] dark:text-white/60 dark:hover:bg-white/[.08]"
          >
            <Archive size={12} /> Archive (e)
          </button>
          <button type="button" onClick={() => setSelectedIds(new Set())} className="text-black/40 hover:text-black dark:text-white/40 dark:hover:text-white">
            Clear
          </button>
        </div>
      )}
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            const style = { transform: `translateY(${item.start}px)`, height: item.size }
            if (row.kind === 'header') {
              return (
                <div key={row.id} className="absolute left-0 right-0 flex items-center gap-2 border-b border-black/10 bg-white/95 px-4 text-xs font-semibold text-black/50 backdrop-blur dark:border-white/10 dark:bg-[#191919]/95 dark:text-white/50" style={style}>
                  {row.group.status && <span className={`rounded px-1.5 py-0.5 ${statusColorClasses(row.group.status.color)}`}>{row.group.label}</span>}
                  {!row.group.status && <span>{row.group.label}</span>}
                  <span className="text-black/30 dark:text-white/30">{row.group.tasks.length}</span>
                </div>
              )
            }
            const task = row.task
            const isFocused = task.id === focusedTaskId
            const isSelected = selectedIds.has(task.id)
            return (
              <div
                key={row.id}
                data-task-row={task.id}
                onClick={() => {
                  setFocusedTaskId(task.id)
                  onOpenTask(task.id)
                }}
                className={`absolute left-0 right-0 flex cursor-pointer items-center gap-3 border-b border-black/5 px-4 text-sm hover:bg-black/[.03] dark:border-white/5 dark:hover:bg-white/[.04] ${
                  isFocused ? 'bg-black/[.04] dark:bg-white/[.06]' : ''
                } ${isSelected ? 'ring-1 ring-inset ring-black/20 dark:ring-white/30' : ''}`}
                style={style}
              >
                <button
                  type="button"
                  aria-label={isSelected ? 'Deselect task' : 'Select task'}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedIds((prev) => {
                      const next = new Set(prev)
                      if (next.has(task.id)) next.delete(task.id)
                      else next.add(task.id)
                      return next
                    })
                  }}
                  className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                    isSelected ? 'border-black bg-black text-white dark:border-white dark:bg-white dark:text-black' : 'border-black/20 dark:border-white/20'
                  }`}
                >
                  {isSelected && <Check size={10} />}
                </button>
                <span className="min-w-0 flex-1 truncate">{task.title || 'Untitled'}</span>
                <AgentPresence active={activeTaskIds.has(task.id)} />
                <RunMetrics metrics={runMetrics[task.id]} />
                <div onClick={(e) => e.stopPropagation()}>
                  <InlineStatusSelect statuses={statuses} task={task} onChange={(statusId) => onPatchTask(task.id, { status: statusId })} />
                </div>
                <div onClick={(e) => e.stopPropagation()}>
                  <InlineAssigneeSelect assignableUsers={assignableUsers} task={task} onChange={(userId) => onPatchTask(task.id, { assignee: userId })} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const UNASSIGNED = '__unassigned__'

function InlineStatusSelect({ statuses, task, onChange }: { statuses: TaskStatus[]; task: Task; onChange: (statusId: number) => void }) {
  const statusId = typeof task.status === 'number' ? task.status : task.status.id
  return (
    <Select value={String(statusId)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger size="sm" className="h-6 w-28 shrink-0 text-xs"><SelectValue /></SelectTrigger>
      <SelectContent>
        {statuses.map((s) => (
          <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function InlineAssigneeSelect({ assignableUsers, task, onChange }: { assignableUsers: User[]; task: Task; onChange: (userId: number | null) => void }) {
  const assigneeId = typeof task.assignee === 'object' ? task.assignee?.id ?? null : task.assignee ?? null
  return (
    <Select value={assigneeId != null ? String(assigneeId) : UNASSIGNED} onValueChange={(v) => onChange(v === UNASSIGNED ? null : Number(v))}>
      <SelectTrigger size="sm" className="h-6 w-28 shrink-0 text-xs"><SelectValue placeholder="Unassigned" /></SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
        {assignableUsers.map((u) => (
          <SelectItem key={u.id} value={String(u.id)}>{u.name || u.email}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
