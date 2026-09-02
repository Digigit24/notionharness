import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { Activity, Clock, Gauge, CircleDollarSign, ListChecks } from 'lucide-react'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getWorkspaceHealthMetrics, getWorkspaceUsageRollup } from '@/lib/broker'
import { Card, CardContent } from '@/components/ui/card'

export const metadata = {
  title: 'Health | NotionForge',
}

// ROADMAP B8.4 (Batch B-6 "Finish") — the internal health page the plan asks
// for: "runtimes up, queue depth, claim latency, run success rate, spend
// rate." Every number below is real, derived from the `runs`/`run_usage`
// tables via `lib/broker/health.ts` and `getWorkspaceUsageRollup`.
//
// "Runtimes up" is deliberately NOT shown here — same honest-omission call
// `components/shell/ambient-status.tsx` already made for this exact metric
// (see its own header comment): `collections/Runtimes.ts` exists with a
// `status`/`lastCheckedAt` field pair, but nothing in this codebase — no
// daemon, no health-check route — ever writes to them, so any indicator
// drawn from that collection would be fabricated, not observed. This page
// follows that same precedent rather than re-deciding it differently.
const WINDOW_DAYS = 7

export default async function WorkspaceHealthPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const [health, usage] = await Promise.all([
    getWorkspaceHealthMetrics(workspace.id, WINDOW_DAYS),
    getWorkspaceUsageRollup(workspace.id, WINDOW_DAYS),
  ])

  const spendPerDay = usage.totalCostTicks / 100 / WINDOW_DAYS

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
        <header>
          <h1 className="text-2xl font-semibold">Health</h1>
          <p className="text-sm text-black/50 dark:text-white/50">
            {workspace.name} — live numbers, last {WINDOW_DAYS} days where a window applies. No fabricated
            indicators: a metric this codebase can&apos;t actually derive is omitted rather than guessed.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <HealthTile
            icon={<Activity size={16} />}
            label="Active runs"
            value={String(health.activeRunsCount)}
            detail="Runs currently claimed and executing (dispatched, running, or waiting on a directory)."
          />
          <HealthTile
            icon={<ListChecks size={16} />}
            label="Queue depth"
            value={String(health.queueDepth)}
            detail="Runs enqueued and waiting to be claimed by a worker."
          />
          <HealthTile
            icon={<Clock size={16} />}
            label="Claim latency (avg)"
            value={health.claimLatencyMsAvg == null ? 'No data yet' : formatMs(health.claimLatencyMsAvg)}
            detail={`Average time between a run being enqueued and actually starting, over the last ${WINDOW_DAYS} days.`}
          />
          <HealthTile
            icon={<Gauge size={16} />}
            label="Run success rate"
            value={health.runSuccessRate == null ? 'No data yet' : `${Math.round(health.runSuccessRate * 100)}%`}
            detail={`${health.completedCount} completed / ${health.failedCount} failed in the last ${WINDOW_DAYS} days. Cancelled runs are excluded from this rate.`}
          />
          <HealthTile
            icon={<CircleDollarSign size={16} />}
            label="Spend rate"
            value={`$${spendPerDay.toFixed(2)} / day`}
            detail={`$${(usage.totalCostTicks / 100).toFixed(2)} total across the last ${WINDOW_DAYS} days, averaged.`}
          />
        </div>
      </div>
    </div>
  )
}

function HealthTile({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode
  label: string
  value: string
  detail: string
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-3">
        <span className="flex items-center gap-1.5 text-xs font-medium text-black/50 dark:text-white/50">
          <span aria-hidden="true">{icon}</span>
          {label}
        </span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        <span className="text-xs text-black/40 dark:text-white/40">{detail}</span>
      </CardContent>
    </Card>
  )
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${(seconds / 60).toFixed(1)}m`
}
