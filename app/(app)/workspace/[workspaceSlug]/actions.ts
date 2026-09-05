'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { listPendingApprovalsForUser } from '@/lib/hermes/approval-helpers'
import { listActiveRunsForWorkspace, getWorkspaceUsageRollup, hasAnyRunForWorkspace } from '@/lib/broker'

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
  /**
   * The highest id among the approvals waiting for this user, or null when
   * none is. The shell's chime keys off this rather than the count, because
   * a count can stay flat while one request is settled and a new one
   * arrives — and that new one is exactly what deserves a sound. Free: the
   * rows are already fetched for the count.
   */
  latestApprovalId: number | null
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
    latestApprovalId: approvals.length > 0 ? Math.max(...approvals.map((a) => a.id)) : null,
    spendTicks24h: usage.totalCostTicks,
    runtimesUp:
      runtimes.docs.length === 0
        ? null
        : { up: runtimes.docs.filter((r) => r.status === 'up').length, total: runtimes.docs.length },
  }
}

// Phase C, C4 — "seed the empty workspace... wire it into first-run."
// Re-checks "genuinely empty" server-side (the exact same three-signal
// definition the workspace home page uses for its own `isGenuinelyEmpty`
// check) rather than trusting the client's rendered state — the button
// this backs only appears on an empty workspace, but a stale client after
// a background action created content elsewhere must not be able to
// double-seed by clicking it anyway.
export async function seedStarterWorkspaceIfEmpty({
  workspaceId,
  workspaceSlug,
}: {
  workspaceId: number
  workspaceSlug: string
}) {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in to seed a workspace.')

  const payload = await getPayloadClient()
  const [pageCount, taskCount, hasAnyRun] = await Promise.all([
    payload.find({ collection: 'pages', where: { workspace: { equals: workspaceId } }, limit: 1, overrideAccess: true }).then((r) => r.totalDocs),
    payload.find({ collection: 'tasks', where: { workspace: { equals: workspaceId } }, limit: 1, overrideAccess: true }).then((r) => r.totalDocs),
    hasAnyRunForWorkspace(workspaceId),
  ])
  if (pageCount > 0 || taskCount > 0 || hasAnyRun) {
    throw new Error('This workspace already has content — refusing to seed a second starter set.')
  }

  // Imported HERE rather than at module scope, deliberately. This file is
  // pulled in by `workspace/[workspaceSlug]/layout.tsx`, so a top-level
  // import lands in the server bundle of EVERY page under that layout —
  // agents, tasks, settings, all of it. And the chain is heavy:
  // seed-starter-workspace → blocksuite-doc → blocksuite-store → Yjs, which
  // logged "Yjs was already imported. This breaks constructor checks" on
  // pages that never touch a document (observed live on /agents). Yjs's own
  // instance check is a real correctness issue, not just noise — two copies
  // mean `instanceof` fails across them. Deferring the import keeps the
  // editor stack out of every unrelated route's bundle and loads it only
  // when someone actually seeds a workspace.
  const { seedStarterWorkspace } = await import('@/lib/onboarding/seed-starter-workspace')
  const result = await seedStarterWorkspace({ workspaceId, userId: user.id })
  revalidatePath(`/workspace/${workspaceSlug}`)
  return { pageId: result.page.id }
}
