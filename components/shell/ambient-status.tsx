'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CircleDollarSign, PlayCircle, ShieldAlert, Server } from 'lucide-react'
import { getAmbientStatus, type AmbientStatus } from '@/app/(app)/workspace/[workspaceSlug]/actions'

const POLL_INTERVAL_MS = 12_000

/**
 * ROADMAP B1.5 — "persistently in the shell: runs in flight, approvals
 * waiting, spend today. Small, quiet, always there." Mounted at the bottom
 * of the expanded Sidebar (components/sidebar/sidebar.tsx), right above the
 * user/logout footer row — the one spot that doesn't compete with the
 * Section nav or the page tree for space.
 *
 * Shows a "runtimes up" stat once a workspace has at least one runtime
 * profile — Phase C's C1.3 (`lib/hermes/runtime-health.ts`) is the real
 * registration/heartbeat mechanism this comment used to say was still
 * missing; `getAmbientStatus` now derives it from real `runtimes` rows, not
 * a fabricated dot. Hidden entirely (not shown as "0/0") when the workspace
 * has no runtime profiles configured — see `AmbientStatus.runtimesUp`'s own
 * null-vs-zero distinction in `actions.ts`.
 *
 * Polls a Server Action on a plain interval — this session's B-2 SSE work
 * only streams a single run's events (`/api/runs/[id]/events/stream`), there
 * is no workspace-wide equivalent to subscribe to, and three small counts
 * every 12s is cheap enough not to justify building one.
 */
export function AmbientStatus({
  workspaceId,
  workspaceSlug,
  initialStatus,
}: {
  workspaceId: number
  workspaceSlug: string
  initialStatus: AmbientStatus
}) {
  const [status, setStatus] = useState<AmbientStatus>(initialStatus)

  useEffect(() => {
    let cancelled = false
    const poll = () => {
      void getAmbientStatus(workspaceId).then((next) => {
        if (!cancelled) setStatus(next)
      })
    }
    const interval = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [workspaceId])

  return (
    // ROADMAP B8.2 — polls a Server Action every 12s with no user action
    // triggering the update (see this component's own header comment);
    // `aria-live="polite"` lets assistive tech pick up the changed counts
    // without interrupting whatever the user is doing.
    <div
      className="flex items-center gap-1 border-t border-black/5 px-2 py-1.5 dark:border-white/10"
      aria-live="polite"
      aria-atomic="true"
    >
      <StatusStat
        href={`/workspace/${workspaceSlug}/active-runs`}
        icon={<PlayCircle size={12} />}
        value={status.runsInFlight}
        title={`${status.runsInFlight} run${status.runsInFlight === 1 ? '' : 's'} in flight`}
      />
      <StatusStat
        href={`/workspace/${workspaceSlug}/inbox`}
        icon={<ShieldAlert size={12} />}
        value={status.approvalsWaiting}
        title={`${status.approvalsWaiting} approval${status.approvalsWaiting === 1 ? '' : 's'} waiting`}
        emphasize={status.approvalsWaiting > 0}
      />
      <StatusStat
        href={`/workspace/${workspaceSlug}#what-it-is-costing`}
        icon={<CircleDollarSign size={12} />}
        value={`$${(status.spendTicks24h / 100).toFixed(2)}`}
        title="Spend, last 24 hours"
      />
      {status.runtimesUp && (
        <StatusStat
          href={`/workspace/${workspaceSlug}/runtimes`}
          icon={<Server size={12} />}
          value={`${status.runtimesUp.up}/${status.runtimesUp.total}`}
          title={`${status.runtimesUp.up} of ${status.runtimesUp.total} runtime(s) up, as of the last check`}
          emphasize={status.runtimesUp.up < status.runtimesUp.total}
        />
      )}
    </div>
  )
}

function StatusStat({
  href,
  icon,
  value,
  title,
  emphasize = false,
}: {
  href: string
  icon: ReactNode
  value: number | string
  title: string
  emphasize?: boolean
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-label={title}
      className={
        'flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium tabular-nums hover:bg-black/[.06] dark:hover:bg-white/[.08] ' +
        (emphasize ? 'text-amber-600 dark:text-amber-400' : 'text-black/50 dark:text-white/50')
      }
    >
      <span aria-hidden="true">{icon}</span>
      {value}
    </Link>
  )
}
