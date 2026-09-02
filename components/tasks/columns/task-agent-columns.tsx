'use client'

import { Badge } from '@/components/ui/badge'
import type { Agent } from '@/payload-types'

// ROADMAP B-4 "Work" — "the columns nobody else's tracker can have: Agent,
// Runs, Last run outcome, Spend, Live." Five small, individually reusable
// pieces (not one monolithic row) so any consumer — a board card today, a
// future list row or table cell — can drop in only the ones it wants.
// Real data sources, wired at the call site (components/tasks/task-board.tsx):
//   - AgentColumn        — `task.agent`, resolved against the workspace's
//                           already-fetched `agents` list (works whether or
//                           not the relationship came back populated).
//   - RunsColumn          — `TaskAgentColumnData.runCount`, which is
//                           `getTaskUsageTotals`'s own `runCount` (ROADMAP
//                           B-1, lib/broker/usage.ts) — not a second query.
//   - LastRunOutcomeColumn — `TaskAgentColumnData.lastRunStatus`, the head of
//                           `listRunsForTask`'s already-DESC-sorted list.
//   - SpendColumn         — `TaskAgentColumnData.totalCostTicks`, the exact
//                           same `getTaskUsageTotals` call, reused rather
//                           than reimplemented, per this batch's brief.
//   - LiveDot             — a *real* pulse (CSS `animate-ping`, not a static
//                           dot) driven by whether the task has a
//                           non-terminal run right now. The board wires this
//                           from its existing workspace-wide
//                           `getActiveRunsForWorkspace` presence set (no
//                           extra query); a consumer with only one task id in
//                           hand should use the new `hasActiveRunForTask`
//                           broker helper (lib/broker/runs.ts) instead.

export function AgentColumn({ agent }: { agent: Agent | null }) {
  if (!agent) return <span className="text-xs text-black/30 dark:text-white/30">No agent</span>
  return (
    <span className="truncate text-xs text-black/60 dark:text-white/60" title={agent.name}>
      {agent.name}
    </span>
  )
}

export function RunsColumn({ count }: { count: number }) {
  return <span className="text-xs tabular-nums text-black/50 dark:text-white/50">{count}</span>
}

const OUTCOME_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'secondary',
  failed: 'destructive',
  cancelled: 'outline',
  queued: 'outline',
  dispatched: 'outline',
  running: 'default',
  waiting_directory: 'outline',
}

export function LastRunOutcomeColumn({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-black/30 dark:text-white/30">No runs</span>
  return (
    <Badge variant={OUTCOME_VARIANT[status] ?? 'outline'} className="capitalize">
      {status.replace(/_/g, ' ')}
    </Badge>
  )
}

export function SpendColumn({ totalCostTicks }: { totalCostTicks: number }) {
  return <span className="text-xs tabular-nums text-black/50 dark:text-white/50">${(totalCostTicks / 100).toFixed(2)}</span>
}

/** A real pulse, not a decorative CSS-only fake — only renders the animated
 * ring when `active` is true, driven by a genuine non-terminal-run check
 * (see file header). */
export function LiveDot({ active }: { active: boolean }) {
  if (!active) {
    return <span className="inline-block size-2 rounded-full bg-black/10 dark:bg-white/10" aria-hidden="true" />
  }
  return (
    <span className="relative inline-flex size-2" title="A run is active on this task">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
    </span>
  )
}
