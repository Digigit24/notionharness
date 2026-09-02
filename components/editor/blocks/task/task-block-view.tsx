'use client'

import { useEffect, useState, useTransition } from 'react'
import { getTask, updateTaskFields } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import { listWorkspaceStatuses, listAssignableUsers } from '@/app/(app)/workspace/[workspaceSlug]/command-bar/actions'
import { statusColorClasses } from '@/lib/status-colors'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import type { Task, TaskStatus, User } from '@/payload-types'

/**
 * ROADMAP B3.4 — the Task block's actual UI: title (plain editable input,
 * same input+onBlur idiom `RecordDetailHeader`/`PageCanvas` already use for
 * a "real doc field," not BlockSuite rich text — the block references a
 * task, it isn't one), a status badge/picker, and an assignee picker.
 * Mounted into the Lit block via the same React-root-inside-a-`<div>`
 * pattern `record-detail-panel.ts`'s `reactSlot` already established.
 *
 * Every read/write here is the real `tasks` collection — `getTask` and
 * `updateTaskFields` (`tasks/actions.ts`) are the same actions the task
 * board and task detail page use, so a status change made from inside a
 * page shows up on the board and vice versa. No second source of truth.
 */
export function TaskBlockView({
  taskId,
  workspaceSlug,
  onOpenTask,
}: {
  taskId: number
  workspaceSlug: string | null
  onOpenTask: (taskId: number) => void
}) {
  const [task, setTask] = useState<Task | null | undefined>(undefined)
  const [title, setTitle] = useState('')
  const [statuses, setStatuses] = useState<TaskStatus[] | null>(null)
  const [users, setUsers] = useState<User[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    getTask(taskId)
      .then((t) => {
        if (cancelled) return
        setTask(t)
        setTitle(t?.title ?? '')
        if (!t) setError('Task not found.')
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load task.')
      })
    return () => {
      cancelled = true
    }
  }, [taskId])

  const workspaceId = task ? (typeof task.workspace === 'number' ? task.workspace : task.workspace.id) : null

  // Pickers' option lists are fetched lazily, only once the task (and so
  // its workspace id) is known — no reason to pay for two extra round trips
  // before that.
  useEffect(() => {
    if (workspaceId == null) return
    listWorkspaceStatuses(workspaceId).then(setStatuses)
    listAssignableUsers(workspaceId).then(setUsers)
  }, [workspaceId])

  if (error) {
    return <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
  }
  if (task === undefined) {
    return <span className="text-xs text-black/40 dark:text-white/40">Loading task…</span>
  }
  if (task === null) {
    return <span className="text-xs text-red-600 dark:text-red-400">Task not found.</span>
  }

  const status = typeof task.status === 'object' ? task.status : null
  const assignee = typeof task.assignee === 'object' ? task.assignee : null

  const saveTitle = () => {
    const trimmed = title.trim()
    if (!trimmed || trimmed === task.title || !workspaceSlug) {
      setTitle(task.title)
      return
    }
    setTask({ ...task, title: trimmed })
    startTransition(() => {
      void updateTaskFields({ taskId, workspaceSlug, data: { title: trimmed } }).catch(() => {
        setError('Failed to save title.')
      })
    })
  }

  const changeStatus = (statusId: string) => {
    const nextId = Number(statusId)
    const next = statuses?.find((s) => s.id === nextId)
    if (next) setTask({ ...task, status: next })
    startTransition(() => {
      void updateTaskFields({ taskId, workspaceSlug: workspaceSlug ?? '', data: { status: nextId } }).catch(() => {
        setError('Failed to change status.')
      })
    })
  }

  const changeAssignee = (value: string) => {
    const nextId = value === 'unassigned' ? null : Number(value)
    const next = nextId === null ? null : (users?.find((u) => u.id === nextId) ?? null)
    setTask({ ...task, assignee: next })
    startTransition(() => {
      void updateTaskFields({ taskId, workspaceSlug: workspaceSlug ?? '', data: { assignee: nextId } }).catch(() => {
        setError('Failed to change assignee.')
      })
    })
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-black/10 bg-black/[.015] px-2.5 py-1.5 dark:border-white/10 dark:bg-white/[.02]">
      <input
        className="min-w-[120px] flex-1 rounded-sm border-none bg-transparent text-sm outline-none placeholder:text-black/30 focus-visible:ring-2 focus-visible:ring-ring/40 dark:placeholder:text-white/30"
        aria-label="Task title"
        value={title}
        placeholder="Untitled task"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />

      {workspaceSlug && statuses !== null ? (
        <Select value={status ? String(status.id) : undefined} onValueChange={changeStatus}>
          <SelectTrigger size="sm" className="h-6 border-none bg-transparent px-1.5 shadow-none">
            <SelectValue placeholder="No status">
              {status && <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusColorClasses(status.color)}`}>{status.name}</span>}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {statuses.map((s) => (
              <SelectItem key={s.id} value={String(s.id)}>
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusColorClasses(s.color)}`}>{s.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : status ? (
        <Badge variant="secondary" className={statusColorClasses(status.color)}>
          {status.name}
        </Badge>
      ) : null}

      {workspaceSlug && users !== null ? (
        <Select value={assignee ? String(assignee.id) : 'unassigned'} onValueChange={changeAssignee}>
          <SelectTrigger size="sm" className="h-6 border-none bg-transparent px-1.5 shadow-none">
            <SelectValue placeholder="Unassigned">{assignee ? assignee.name || assignee.email : 'Unassigned'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={String(u.id)}>
                {u.name || u.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="text-xs text-black/40 dark:text-white/40">{assignee ? assignee.name || assignee.email : 'Unassigned'}</span>
      )}

      <button
        type="button"
        className="ml-auto shrink-0 text-xs text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
        onClick={() => onOpenTask(taskId)}
      >
        Open ↗
      </button>
    </div>
  )
}
