'use client'

export interface TaskRunMetrics {
  runId: number
  status: string
  startedAt: string | null
  completedAt: string | null
  totalCostTicks: number
  stepCount: number
}

function elapsed(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return ''
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const minutes = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 60000))
  return `${minutes}m`
}

/** Compact task-card metrics. Cost ticks use the same fixed-point conversion as the run-card block. */
export function RunMetrics({ metrics }: { metrics?: TaskRunMetrics }) {
  if (!metrics) return null
  return <span className="shrink-0 text-[11px] text-black/40 dark:text-white/40" title={`Run #${metrics.runId} · ${metrics.status}`}>
    ${ (metrics.totalCostTicks / 100).toFixed(2) } · {elapsed(metrics.startedAt, metrics.completedAt)} · {metrics.stepCount} steps
  </span>
}

/** Task-level presence until a future block write handle can map files to editor blocks. */
export function AgentPresence({ active }: { active?: boolean }) {
  if (!active) return null
  return <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400" title="An agent is working on this task"><span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" /> Agent active</span>
}
