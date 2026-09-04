'use client'

import Link from 'next/link'
import { statusColorClasses } from '@/lib/status-colors'
import type { ProjectTaskChipData } from '@/app/(app)/workspace/[workspaceSlug]/teams/task-thread-actions'

/**
 * R14-P0.8 — "one chip component, two ways to arrive at the same state."
 *
 * The ONLY renderer of a `collections/Tasks.ts` (project) task's live status
 * inline in the teams UI. Rendered from `channel-view.tsx` beside a thread
 * root's message (P0.8.1: a task authored with a thread from the start) and
 * from `thread-pane.tsx` atop an open thread (P0.8.2), fed by the SAME
 * `projectTaskChips` map `team-room.tsx` seeds once from
 * `listProjectTaskChipsAction` and patches locally on create — never two
 * components, never two fetches for the same fact.
 *
 * Deliberately a SEPARATE component from `message-row.tsx`'s
 * `MessageTaskChip` rendering, not a rename of it: that one shows a broker
 * `team_tasks` row (subject/status/owner slot); this one shows a
 * `collections/Tasks.ts` row (title/status/project). ROADMAP-SERIES.md's own
 * R14-P0.8 section states plainly that the two task systems are not merged —
 * a single chip component pretending to cover both would quietly merge them
 * anyway, in the UI if nowhere else.
 */
export function ProjectTaskChip({ chip }: { chip: ProjectTaskChipData }) {
  return (
    <Link
      href={`/workspace/${chip.workspaceSlug}/tasks/${chip.taskId}`}
      className="inline-flex max-w-[20rem] items-center gap-1.5 rounded border border-black/10 px-1.5 py-0.5 text-[11px] hover:border-black/30 dark:border-white/15 dark:hover:border-white/35"
      title={`${chip.statusName}${chip.projectName ? ` · ${chip.projectName}` : ''} — open the task`}
    >
      <span aria-hidden>📋</span>
      <span className="truncate font-medium">{chip.title}</span>
      <span className={`shrink-0 rounded px-1 py-px text-[10px] font-medium ${statusColorClasses(chip.statusColor)}`}>
        {chip.statusName}
      </span>
      {chip.projectName && <span className="shrink-0 truncate text-black/40 dark:text-white/40">{chip.projectName}</span>}
    </Link>
  )
}
