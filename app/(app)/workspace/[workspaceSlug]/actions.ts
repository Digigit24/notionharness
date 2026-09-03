'use server'

import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { listPendingApprovalsForUser } from '@/lib/hermes/approval-helpers'
import { listActiveRunsForWorkspace, getWorkspaceUsageRollup } from '@/lib/broker'

// ROADMAP B1.5 — the ambient status bar's polling endpoint. Deliberately
// small: real, cheap-to-answer numbers (no page content, no digest items)
// so a 10-15s client poll stays lightweight. "Runtimes online" WAS excluded
// (no heartbeat producer ever wrote to `collections/Runtimes.ts`'s `status`
// field, so surfacing a count would have been fabricated) until Phase C's
// C1.3 (`lib/hermes/runtime-health.ts`) became the first real writer —
// `runtimesUp` below reads that real data now. Approvals are user-scoped,
// not workspace-scoped (`approvals` has no workspace field — same posture
// as the Inbox page this reuses `listPendingApprovalsForUser` from), so
// this counts across every workspace the user is in, matching the Inbox's
// own cross-workspace behavior.
export interface AmbientStatus {
  runsInFlight: number
  approvalsWaiting: number
  spendTicks24h: number
  /** null when this workspace has no runtime profiles at all — distinct from "0 up out of some". */
  runtimesUp: { up: number; total: number } | null
}

export async function getAmbientStatus(workspaceId: number): Promise<AmbientStatus> {
  const user = await getCurrentPayloadUser()
  const payload = await getPayloadClient()

  const [activeRuns, approvals, usage, runtimes] = await Promise.all([
    listActiveRunsForWorkspace(workspaceId),
    user ? listPendingApprovalsForUser(user.id).catch(() => []) : Promise.resolve([]),
    getWorkspaceUsageRollup(workspaceId, 1),
    payload.find({
      collection: 'runtimes',
      where: { workspace: { equals: workspaceId } },
      limit: 200,
      depth: 0,
      overrideAccess: true,
    }),
  ])

  return {
    runsInFlight: activeRuns.length,
    approvalsWaiting: approvals.length,
    spendTicks24h: usage.totalCostTicks,
    runtimesUp:
      runtimes.docs.length === 0
        ? null
        : { up: runtimes.docs.filter((r) => r.status === 'up').length, total: runtimes.docs.length },
  }
}
