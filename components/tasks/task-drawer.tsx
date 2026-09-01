'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { getRunMessages, getTaskActivity, getTaskRuns, updateTaskFields } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import { useRunEventStream } from '@/components/runs/use-run-event-stream'
import type { Activity, Agent, Project, Task, TaskStatus, User, Workspace } from '@/payload-types'

type Tab = 'overview' | 'activity' | 'sessions'

export function TaskDrawer({
  task,
  workspace,
  projects,
  statuses,
  assignableUsers,
  agents,
  onClose,
  onUpdated,
}: {
  task: Task
  workspace: Workspace
  projects: Project[]
  statuses: TaskStatus[]
  assignableUsers: User[]
  agents: Agent[]
  onClose: () => void
  onUpdated: (task: Task) => void
}) {
  const [tab, setTab] = useState<Tab>('overview')

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function patch(data: Partial<Pick<Task, 'title' | 'status' | 'assignee' | 'agent' | 'project'>>) {
    const updated = await updateTaskFields({ taskId: task.id, workspaceSlug: workspace.slug, data })
    onUpdated(updated)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/20 dark:bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="Task details"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="flex h-full w-full max-w-[420px] flex-col border-l border-black/10 bg-white shadow-2xl dark:border-white/10 dark:bg-[#252525]">
        <div className="flex items-center justify-between border-b border-black/10 px-4 py-3 dark:border-white/10">
          <h2 className="truncate text-sm font-semibold">{task.title || 'Untitled'}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close task details"
            className="rounded-md p-1.5 text-black/50 hover:bg-black/[.06] dark:text-white/50 dark:hover:bg-white/[.08]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex border-b border-black/10 px-2 dark:border-white/10">
          {(['overview', 'activity', 'sessions'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-xs font-medium capitalize ${
                tab === t
                  ? 'border-b-2 border-black text-black dark:border-white dark:text-white'
                  : 'text-black/40 dark:text-white/40'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'overview' && (
            <OverviewTab
              task={task}
              projects={projects}
              statuses={statuses}
              assignableUsers={assignableUsers}
              agents={agents}
              onPatch={patch}
            />
          )}
          {tab === 'activity' && <ActivityTab taskId={task.id} />}
          {tab === 'sessions' && <SessionsTab taskId={task.id} agents={agents} />}
        </div>
      </div>
    </div>
  )
}

function OverviewTab({
  task,
  projects,
  statuses,
  assignableUsers,
  agents,
  onPatch,
}: {
  task: Task
  projects: Project[]
  statuses: TaskStatus[]
  assignableUsers: User[]
  agents: Agent[]
  onPatch: (data: Partial<Pick<Task, 'title' | 'status' | 'assignee' | 'agent' | 'project'>>) => Promise<void>
}) {
  const [title, setTitle] = useState(task.title || '')
  useEffect(() => setTitle(task.title || ''), [task.id, task.title])

  const statusId = typeof task.status === 'object' ? task.status.id : task.status
  const assigneeId = typeof task.assignee === 'object' ? task.assignee?.id : task.assignee
  const projectId = typeof task.project === 'object' ? task.project?.id : task.project

  return (
    <div className="flex flex-col gap-4">
      <Field label="Title">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== task.title && void onPatch({ title: title || 'Untitled' })}
          className="w-full rounded-md border border-black/10 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-black/30 dark:border-white/10 dark:focus:border-white/30"
        />
      </Field>
      <Field label="Status">
        <select
          value={statusId ?? ''}
          onChange={(e) => void onPatch({ status: Number(e.target.value) })}
          className="w-full rounded-md border border-black/10 bg-transparent px-2.5 py-1.5 text-sm dark:border-white/10"
        >
          {statuses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Assignee">
        <select
          value={assigneeId ?? ''}
          onChange={(e) => void onPatch({ assignee: e.target.value ? Number(e.target.value) : null })}
          className="w-full rounded-md border border-black/10 bg-transparent px-2.5 py-1.5 text-sm dark:border-white/10"
        >
          <option value="">Unassigned</option>
          {assignableUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.email}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Agent">
        <select value={typeof task.agent === 'object' ? task.agent?.id ?? '' : task.agent ?? ''} onChange={(e) => void onPatch({ agent: e.target.value ? Number(e.target.value) : null })} className="w-full rounded-md border border-black/10 bg-transparent px-2.5 py-1.5 text-sm dark:border-white/10">
          <option value="">No agent</option>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
      </Field>
      <Field label="Project">
        <select
          value={projectId ?? ''}
          onChange={(e) => void onPatch({ project: e.target.value ? Number(e.target.value) : null })}
          className="w-full rounded-md border border-black/10 bg-transparent px-2.5 py-1.5 text-sm dark:border-white/10"
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}

function SessionsTab({ taskId, agents }: { taskId: number; agents: Agent[] }) {
  const observed = true
  const snapshots = useRunEventStream(taskId, observed, async (id) => {
    const runs = await getTaskRuns(id)
    return Promise.all(runs.map(async (run) => ({ run, events: await getRunMessages(run.id) })))
  })
  const rows = useMemo(() => snapshots.flatMap(({ run, events }) => [
    { kind: 'header' as const, key: `run-${run.id}`, run, events },
    ...events.map((event) => ({ kind: 'event' as const, key: `run-${run.id}-${event.seq}`, run, event })),
  ]), [snapshots])
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: (index) => rows[index].kind === 'header' ? 30 : 44, overscan: 10 })
  if (snapshots.length === 0) return <p className="text-sm text-black/40 dark:text-white/40">No agent runs yet.</p>
  return <div ref={parentRef} className="max-h-[60vh] overflow-auto"><div className="relative" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map((item) => { const row = rows[item.index]; return <div key={row.key} className="absolute left-0 right-0 px-1" style={{ transform: `translateY(${item.start}px)` }}>{row.kind === 'header' ? <div className="flex justify-between border-b border-black/10 py-1 text-xs dark:border-white/10"><span>Run #{row.run.id} · {agents.find((a) => a.id === row.run.agentId)?.name ?? 'Agent'}</span><span>{row.run.status}</span></div> : <div className="whitespace-pre-wrap break-words py-1 font-mono text-[11px]"><span className="text-black/40 dark:text-white/40">[{row.event.seq}] </span>{JSON.stringify(row.event.event)}</div>}</div> })}</div></div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-black/40 dark:text-white/40">{label}</span>
      {children}
    </label>
  )
}

function ActivityTab({ taskId }: { taskId: number }) {
  const [activity, setActivity] = useState<Activity[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getTaskActivity(taskId)
      .then((docs) => {
        if (active) setActivity(docs)
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load activity.')
      })
    return () => {
      active = false
    }
  }, [taskId])

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
  if (!activity) return <p className="text-sm text-black/40 dark:text-white/40">Loading…</p>
  if (activity.length === 0) return <p className="text-sm text-black/40 dark:text-white/40">No activity yet.</p>

  return (
    <ul className="flex flex-col gap-3">
      {activity.map((item) => {
        const actor = typeof item.actor === 'object' ? item.actor : null
        return (
          <li key={item.id} className="text-sm">
            <div>
              <span className="font-medium">{actor?.name || actor?.email || 'System'}</span>{' '}
              <span className="text-black/60 dark:text-white/60">{item.action}</span>
            </div>
            <div className="text-xs text-black/30 dark:text-white/30">{new Date(item.createdAt).toLocaleString()}</div>
          </li>
        )
      })}
    </ul>
  )
}
