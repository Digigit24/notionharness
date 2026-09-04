'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { statusColorClasses } from '@/lib/status-colors'
import { RunsColumn, LastRunOutcomeColumn, SpendColumn } from '@/components/tasks/columns/task-agent-columns'
import type { TaskAgentColumnData } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import type { TaskGroup } from '@/lib/task-views/data-layer'
import { taskProjectLabel } from '@/lib/task-views/data-layer'

/**
 * R14-P0.7 "Work" — this agent's own tasks, grouped by status.
 *
 * A SECOND RENDERER OVER EXISTING DATA, NOT A NEW QUERY (the roadmap item's
 * explicit point). Every number on this screen already exists elsewhere:
 * `groupTasks` (lib/task-views/data-layer.ts) is the exact function the task
 * board's List view groups its rows with, called here server-side
 * (agents/[agentId]/page.tsx) over tasks already filtered to this agent.
 * `RunsColumn`/`SpendColumn`/`LastRunOutcomeColumn` are the task board's own
 * per-task agent columns (components/tasks/columns/task-agent-columns.tsx),
 * fed by `getTaskAgentColumnsData` — the same batched broker read the board
 * itself polls, called here once at page load instead of on a 4s interval:
 * this is a static tab a person opens to look something up, not a live
 * board someone leaves open, so the interval the board needs would be a
 * polling loop this page has no use for (D0 — no polling without a reason).
 *
 * Groups are plain, uncontrolled `<details>` elements rather than a second
 * piece of collapse state — collapsing a group here is a display
 * preference with no data behind it, and the browser already does this for
 * free.
 */
export function AgentWorkTab({
  workspaceSlug,
  groups,
  columnsData,
}: {
  workspaceSlug: string
  groups: TaskGroup[]
  columnsData: Record<number, TaskAgentColumnData>
}) {
  if (groups.length === 0) {
    return (
      <p className="p-6 text-sm text-black/50 dark:text-white/50">
        This agent has no tasks yet. Assign it one from the{' '}
        <Link href={`/workspace/${workspaceSlug}/tasks`} className="font-medium text-primary underline-offset-2 hover:underline">
          Tasks board
        </Link>
        .
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-6">
      {groups.map((group) => (
        <TaskStatusGroup key={group.key} group={group} workspaceSlug={workspaceSlug} columnsData={columnsData} />
      ))}
    </div>
  )
}

function TaskStatusGroup({
  group,
  workspaceSlug,
  columnsData,
}: {
  group: TaskGroup
  workspaceSlug: string
  columnsData: Record<number, TaskAgentColumnData>
}) {
  const [open, setOpen] = useState(true)
  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
      className="rounded-lg border border-black/10 dark:border-white/10"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-black/60 dark:text-white/60">
        <ChevronRight size={13} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
        {group.status ? (
          <span className={`rounded px-1.5 py-0.5 ${statusColorClasses(group.status.color)}`}>{group.label}</span>
        ) : (
          <span>{group.label}</span>
        )}
        <span className="font-normal text-black/30 dark:text-white/30">{group.tasks.length}</span>
      </summary>
      <ul className="divide-y divide-black/5 border-t border-black/10 dark:divide-white/5 dark:border-white/10">
        {group.tasks.map((task) => {
          const data = columnsData[task.id]
          const projectLabel = taskProjectLabel(task)
          return (
            <li key={task.id}>
              <Link
                href={`/workspace/${workspaceSlug}/tasks?task=${task.id}`}
                className="flex items-center gap-3 px-3 py-2 text-sm transition hover:bg-black/[0.02] dark:hover:bg-white/[0.04]"
              >
                <span className="min-w-0 flex-1 truncate">{task.title || 'Untitled'}</span>
                {projectLabel && (
                  <span className="shrink-0 rounded bg-black/[0.06] px-1.5 py-0.5 text-[10px] text-black/50 dark:bg-white/[0.09] dark:text-white/50">
                    {projectLabel}
                  </span>
                )}
                <span className="w-14 shrink-0 text-right" title="Runs">
                  <RunsColumn count={data?.runCount ?? 0} />
                </span>
                <span className="w-24 shrink-0" title="Last run outcome">
                  <LastRunOutcomeColumn status={data?.lastRunStatus ?? null} />
                </span>
                <span className="w-16 shrink-0 text-right" title="Lifetime spend">
                  <SpendColumn totalCostTicks={data?.totalCostTicks ?? 0} />
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </details>
  )
}
