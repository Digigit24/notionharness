'use server'

import { getCurrentPayloadUser } from '@/lib/current-user'
import { listPendingApprovalsForUser } from '@/lib/hermes/approval-helpers'
import { listActiveRunsForWorkspace, getWorkspaceUsageRollup } from '@/lib/broker'

// ROADMAP B1.5 — the ambient status bar's polling endpoint. Deliberately
// small: three real, cheap-to-answer numbers (no page content, no digest
// items) so a 10-15s client poll stays lightweight. "Runtimes online" is
// NOT part of this payload — the `runtimes` collection exists (collections/
// Runtimes.ts) but nothing in this codebase updates its `status`/
// `lastCheckedAt` fields yet (no heartbeat producer), so surfacing a count
// from it would be a fabricated status dot, exactly what AGENTS.md's
// never-claim-what-you-don't-track discipline forbids. Approvals are
// user-scoped, not workspace-scoped (`approvals` has no workspace field —
// same posture as the Inbox page this reuses `listPendingApprovalsForUser`
// from), so this counts across every workspace the user is in, matching
// the Inbox's own cross-workspace behavior.
export interface AmbientStatus {
  runsInFlight: number
  approvalsWaiting: number
  spendTicks24h: number
}

export async function getAmbientStatus(workspaceId: number): Promise<AmbientStatus> {
  const user = await getCurrentPayloadUser()

  const [activeRuns, approvals, usage] = await Promise.all([
    listActiveRunsForWorkspace(workspaceId),
    user ? listPendingApprovalsForUser(user.id).catch(() => []) : Promise.resolve([]),
    getWorkspaceUsageRollup(workspaceId, 1),
  ])

  return {
    runsInFlight: activeRuns.length,
    approvalsWaiting: approvals.length,
    spendTicks24h: usage.totalCostTicks,
  }
}
