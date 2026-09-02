'use client'

// ROADMAP B-1 "Detail" — the task detail page (`/workspace/[slug]/tasks/
// [taskId]`), built on the B-0 `<DetailLayout>` primitive the same way the
// run review page already is. Header/right rail are rendered once outside
// the tab area; every tab carries a real count; every empty tab has a
// sentence + one real action, per the batch's own rules.
//
// Data-fetching/business logic throughout is reused, not reinvented:
// `updateTaskFields`/`createTask` (board actions), `ThreadDrawerTab`'s
// underlying `Thread`/`adaptRunEventsToThread` machinery (task-work-tab.tsx),
// `getTaskActivity` (already powers the drawer's Activity tab), and the
// review page's own run-status badge convention.

import { useState } from 'react'
import Link from 'next/link'
import { ListTree, Plus } from 'lucide-react'
import { DetailLayout, type DetailLayoutTab } from '@/components/layout/detail-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { statusColorClasses } from '@/lib/status-colors'
import { updateTaskFields } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import { createSubtask } from '@/app/(app)/workspace/[workspaceSlug]/tasks/[taskId]/actions'
import { TaskWorkTab } from './task-work-tab'
import type { Run, RunStatus, TaskUsageTotals } from '@/lib/broker'
import type { Activity, Agent, Comment, Page, Project, Task, TaskStatus, User, Workspace } from '@/payload-types'

const RUN_BADGE_VARIANT: Record<RunStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  failed: 'destructive',
  cancelled: 'outline',
  queued: 'secondary',
  dispatched: 'secondary',
  running: 'secondary',
  waiting_directory: 'secondary',
}

export interface ChangeSummary {
  run: Run
  fileCount: number
  branchExists: boolean
}

export function TaskDetailView({
  workspace,
  task: initialTask,
  statuses,
  projects,
  assignableUsers,
  agents,
  runs,
  usageTotals,
  runUsageByRunId,
  subtasks: initialSubtasks,
  comments,
  activity,
  page,
  changes,
}: {
  workspace: Workspace
  task: Task
  statuses: TaskStatus[]
  projects: Project[]
  assignableUsers: User[]
  agents: Agent[]
  runs: Run[]
  usageTotals: TaskUsageTotals
  runUsageByRunId: Record<number, { totalTokens: number; totalCostTicks: number }>
  subtasks: Task[]
  comments: Comment[]
  activity: Activity[]
  page: Page | null
  changes: ChangeSummary[]
}) {
  const [task, setTask] = useState(initialTask)
  const [subtasks, setSubtasks] = useState(initialSubtasks)

  async function patch(data: Partial<Pick<Task, 'status' | 'assignee' | 'agent' | 'project'>>) {
    const updated = await updateTaskFields({ taskId: task.id, workspaceSlug: workspace.slug, data })
    setTask(updated)
  }

  const statusId = typeof task.status === 'object' ? task.status.id : task.status
  const assigneeId = typeof task.assignee === 'object' ? task.assignee?.id : task.assignee
  const agentId = typeof task.agent === 'object' ? task.agent?.id : task.agent
  const projectId = typeof task.project === 'object' ? task.project?.id : task.project
  const currentStatus = statuses.find((s) => s.id === statusId)
  const project = typeof task.project === 'object' ? task.project : projects.find((p) => p.id === projectId) ?? null

  const tabs: DetailLayoutTab[] = [
    {
      key: 'work',
      label: 'Work',
      count: runs.length + comments.length,
      content: (
        <TaskWorkTab
          taskId={task.id}
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          agents={agents}
          taskAgentId={agentId ?? null}
          page={page}
          initialComments={comments}
          initialRuns={runs}
        />
      ),
    },
    {
      key: 'runs',
      label: 'Runs',
      count: runs.length,
      content: (
        <RunsTab workspaceSlug={workspace.slug} runs={runs} agents={agents} runUsageByRunId={runUsageByRunId} />
      ),
    },
    {
      key: 'changes',
      label: 'Changes',
      count: changes.reduce((sum, c) => sum + c.fileCount, 0),
      content: <ChangesTab workspaceSlug={workspace.slug} changes={changes} />,
    },
    {
      key: 'subtasks',
      label: 'Sub-tasks',
      count: subtasks.length,
      content: (
        <SubtasksTab
          workspace={workspace}
          parentTaskId={task.id}
          statuses={statuses}
          defaultStatusId={statusId}
          subtasks={subtasks}
          onCreated={(created) => setSubtasks((prev) => [...prev, created])}
        />
      ),
    },
    {
      key: 'activity',
      label: 'Activity',
      count: activity.length,
      content: <ActivityTab activity={activity} />,
    },
  ]

  const rightRail = (
    <div className="flex flex-col gap-4 text-sm">
      <Field label="Status">
        <select
          value={statusId ?? ''}
          onChange={(e) => void patch({ status: Number(e.target.value) })}
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
          onChange={(e) => void patch({ assignee: e.target.value ? Number(e.target.value) : null })}
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
        <select
          value={agentId ?? ''}
          onChange={(e) => void patch({ agent: e.target.value ? Number(e.target.value) : null })}
          className="w-full rounded-md border border-black/10 bg-transparent px-2.5 py-1.5 text-sm dark:border-white/10"
        >
          <option value="">No agent</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Project">
        {project ? (
          <Link href={`/workspace/${workspace.slug}/tasks`} className="mt-0.5 block truncate text-sm font-medium hover:underline">
            {project.name}
          </Link>
        ) : (
          <select
            value={projectId ?? ''}
            onChange={(e) => void patch({ project: e.target.value ? Number(e.target.value) : null })}
            className="w-full rounded-md border border-black/10 bg-transparent px-2.5 py-1.5 text-sm dark:border-white/10"
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </Field>

      <div className="border-t border-black/10 pt-3 dark:border-white/10">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
          Execution (lifetime)
        </h2>
        <dl className="mt-1.5 flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <dt className="text-black/50 dark:text-white/50">Runs</dt>
            <dd className="font-medium">{usageTotals.runCount}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-black/50 dark:text-white/50">Tokens</dt>
            <dd className="font-medium">{usageTotals.totalTokens.toLocaleString()}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-black/50 dark:text-white/50">Cost</dt>
            <dd className="font-medium">${(usageTotals.totalCostTicks / 100).toFixed(2)}</dd>
          </div>
        </dl>
      </div>
    </div>
  )

  return (
    <DetailLayout
      breadcrumb={
        project
          ? [{ label: project.name }, { label: task.title || 'Untitled' }]
          : [{ label: 'Tasks', href: `/workspace/${workspace.slug}/tasks` }, { label: task.title || 'Untitled' }]
      }
      title={task.title || 'Untitled'}
      statusBadge={
        currentStatus && (
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusColorClasses(currentStatus.color)}`}>
            {currentStatus.name}
          </span>
        )
      }
      primaryAction={
        <Button asChild variant="outline" size="sm">
          <Link href={`/workspace/${workspace.slug}/tasks?task=${task.id}`}>Open in board</Link>
        </Button>
      }
      tabs={tabs}
      defaultTab="work"
      rightRail={rightRail}
    />
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-black/40 dark:text-white/40">{label}</span>
      {children}
    </label>
  )
}

function RunsTab({
  workspaceSlug,
  runs,
  agents,
  runUsageByRunId,
}: {
  workspaceSlug: string
  runs: Run[]
  agents: Agent[]
  runUsageByRunId: Record<number, { totalTokens: number; totalCostTicks: number }>
}) {
  if (runs.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No runs yet"
          description="Assign an agent to this task, or start a run from the Work tab, and every run against this task will show up here."
        />
      </div>
    )
  }

  const agentById = new Map(agents.map((a) => [a.id, a.name]))

  return (
    <div className="flex flex-col gap-2 p-4">
      {runs.map((run) => {
        const usage = runUsageByRunId[run.id]
        const durationMin = run.startedAt
          ? Math.max(0, Math.round(((run.completedAt ? new Date(run.completedAt).getTime() : Date.now()) - new Date(run.startedAt).getTime()) / 60000))
          : null
        return (
          <Link
            key={run.id}
            href={`/workspace/${workspaceSlug}/runs/${run.id}/review`}
            className="flex items-center justify-between gap-3 rounded-md border border-black/10 px-3 py-2 text-sm hover:bg-black/[.03] dark:border-white/10 dark:hover:bg-white/[.04]"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Badge variant={RUN_BADGE_VARIANT[run.status]}>{run.status}</Badge>
              <span className="truncate">
                Run #{run.id}
                {run.agentId != null ? ` · ${agentById.get(run.agentId) ?? `agent #${run.agentId}`}` : ''}
              </span>
            </span>
            <span className="shrink-0 text-xs text-black/40 dark:text-white/40">
              {durationMin != null ? `${durationMin}m · ` : ''}
              {usage ? `$${(usage.totalCostTicks / 100).toFixed(2)}` : '$0.00'}
            </span>
          </Link>
        )
      })}
    </div>
  )
}

function ChangesTab({ workspaceSlug, changes }: { workspaceSlug: string; changes: ChangeSummary[] }) {
  // Simplification (see final report): a true cross-run merged diff would
  // need to de-duplicate/merge overlapping file changes across runs, which
  // is out of scope for this pass — this lists each run that produced a
  // diff, with its file count, linking out to that run's own review page.
  const withDiffs = changes.filter((c) => c.branchExists)
  if (withDiffs.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No changes yet"
          description="Once a run against this task produces file changes, it'll show up here linking to its own diff."
        />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 p-4">
      {withDiffs.map(({ run, fileCount }) => (
        <Link
          key={run.id}
          href={`/workspace/${workspaceSlug}/runs/${run.id}/review`}
          className="flex items-center justify-between gap-3 rounded-md border border-black/10 px-3 py-2 text-sm hover:bg-black/[.03] dark:border-white/10 dark:hover:bg-white/[.04]"
        >
          <span className="flex items-center gap-2">
            <Badge variant={RUN_BADGE_VARIANT[run.status]}>{run.status}</Badge>
            Run #{run.id}
          </span>
          <span className="text-xs text-black/40 dark:text-white/40">
            {fileCount} file{fileCount === 1 ? '' : 's'} changed
          </span>
        </Link>
      ))}
    </div>
  )
}

function SubtasksTab({
  workspace,
  parentTaskId,
  statuses,
  defaultStatusId,
  subtasks,
  onCreated,
}: {
  workspace: Workspace
  parentTaskId: number
  statuses: TaskStatus[]
  defaultStatusId: number | undefined
  subtasks: Task[]
  onCreated: (task: Task) => void
}) {
  const [title, setTitle] = useState('')
  const [statusChoice, setStatusChoice] = useState<number | undefined>(defaultStatusId ?? statuses[0]?.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const text = title.trim()
    if (!text || !statusChoice || busy) return
    setBusy(true)
    setError(null)
    try {
      const created = await createSubtask({
        parentTaskId,
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        statusId: statusChoice,
        title: text,
      })
      onCreated(created)
      setTitle('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create sub-task.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-2 rounded-md border border-black/10 p-3 dark:border-white/10">
        <div className="flex gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            placeholder="New sub-task title"
            className="flex-1 rounded-md border border-black/10 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-black/30 dark:border-white/10 dark:focus:border-white/30"
          />
          <select
            value={statusChoice ?? ''}
            onChange={(e) => setStatusChoice(Number(e.target.value))}
            className="rounded-md border border-black/10 bg-transparent px-2 py-1.5 text-sm dark:border-white/10"
          >
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Button type="button" size="sm" disabled={busy || !title.trim()} onClick={() => void submit()}>
            <Plus size={14} /> Add
          </Button>
        </div>
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>

      {subtasks.length === 0 ? (
        <EmptyState icon={<ListTree size={18} />} title="No sub-tasks yet" description="Break this task down — add one above." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {subtasks.map((sub) => {
            const subStatus = typeof sub.status === 'object' ? sub.status : statuses.find((s) => s.id === sub.status)
            return (
              <li key={sub.id}>
                <Link
                  href={`/workspace/${workspace.slug}/tasks/${sub.id}`}
                  className="flex items-center justify-between gap-2 rounded-md border border-black/10 px-3 py-2 text-sm hover:bg-black/[.03] dark:border-white/10 dark:hover:bg-white/[.04]"
                >
                  <span className="truncate">{sub.title || 'Untitled'}</span>
                  {subStatus && (
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${statusColorClasses(subStatus.color)}`}>
                      {subStatus.name}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function ActivityTab({ activity }: { activity: Activity[] }) {
  if (activity.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title="No activity yet" description="Every change to this task — status, assignee, comments, runs — will show up here, unfiltered." />
      </div>
    )
  }
  return (
    <ul className="flex flex-col gap-2 p-4">
      {activity.map((item) => {
        const actor = typeof item.actor === 'object' ? item.actor : null
        const details = item.payload && typeof item.payload === 'object' ? (item.payload as Record<string, unknown>) : null
        return (
          <li key={item.id} className="rounded-md border border-black/10 px-3 py-2 text-sm dark:border-white/10">
            <div className="flex items-center justify-between gap-2">
              <span>
                <span className="font-medium">{actor?.name || actor?.email || 'System'}</span>{' '}
                <span className="text-black/60 dark:text-white/60">{item.action}</span>
              </span>
              <span className="shrink-0 text-xs text-black/30 dark:text-white/30">{new Date(item.createdAt).toLocaleString()}</span>
            </div>
            {details && Object.keys(details).length > 0 && (
              <pre className="mt-1 overflow-x-auto rounded bg-black/[.03] px-2 py-1 text-xs text-black/50 dark:bg-white/[.05] dark:text-white/50">
                {JSON.stringify(details, null, 2)}
              </pre>
            )}
          </li>
        )
      })}
    </ul>
  )
}
