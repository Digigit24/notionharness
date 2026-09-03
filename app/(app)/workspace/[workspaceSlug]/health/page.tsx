import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { Activity, Clock, Gauge, CircleDollarSign, ListChecks, Server } from 'lucide-react'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getWorkspaceHealthMetrics, getWorkspaceUsageRollup } from '@/lib/broker'
import { getPayloadClient } from '@/lib/payload'
import { formatRelativeTime } from '@/lib/relative-time'
import { Card, CardContent } from '@/components/ui/card'

export const metadata = {
  title: 'Health | NotionForge',
}

// ROADMAP B8.4 (Batch B-6 "Finish") — the internal health page the plan asks
// for: "runtimes up, queue depth, claim latency, run success rate, spend
// rate." Every number below is real, derived from the `runs`/`run_usage`
// tables via `lib/broker/health.ts` and `getWorkspaceUsageRollup`.
//
// "Runtimes up" WAS deliberately omitted here (same honest-omission call
// `components/shell/ambient-status.tsx` made for this exact metric):
// `collections/Runtimes.ts` had a `status`/`lastCheckedAt` field pair but
// nothing in this codebase ever wrote to them, so any indicator drawn from
// it would have been fabricated, not observed. Phase C's C1.3
// (`lib/hermes/runtime-health.ts`) is the first real writer — a live HTTP
// round trip to Hermes per enabled runtime profile — so the tile below is
// now honest: it reads whatever was true as of the last check, and says so
// explicitly ("as of the last check") rather than implying live status.
const WINDOW_DAYS = 7

export default async function WorkspaceHealthPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()
  const [health, usage, runtimes] = await Promise.all([
    getWorkspaceHealthMetrics(workspace.id, WINDOW_DAYS),
    getWorkspaceUsageRollup(workspace.id, WINDOW_DAYS),
    payload.find({
      collection: 'runtimes',
      where: { workspace: { equals: workspace.id } },
      limit: 200,
      depth: 0,
      overrideAccess: true,
    }),
  ])

  const spendPerDay = usage.totalCostTicks / 100 / WINDOW_DAYS
  const upCount = runtimes.docs.filter((r) => r.status === 'up').length
  const mostRecentCheck = runtimes.docs
    .map((r) => r.lastCheckedAt)
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1)

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
            icon={<Server size={16} />}
            label="Runtimes up"
            value={runtimes.docs.length === 0 ? 'No profiles' : `${upCount} / ${runtimes.docs.length}`}
            detail={
              runtimes.docs.length === 0
                ? 'No runtime profiles configured for this workspace yet.'
                : mostRecentCheck
                  ? `As of the last check, ${formatRelativeTime(mostRecentCheck)}. See the Runtimes page for per-profile detail.`
                  : 'Never checked yet — visit the Runtimes page and hit Refresh.'
            }
          />
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
