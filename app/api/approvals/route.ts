import { NextRequest, NextResponse } from 'next/server'
import { getCurrentPayloadUser } from '@/lib/current-user'
import {
  resolveApproval,
  listPendingApprovalsForUser,
  getApproval,
  getApprovalByExternalId,
} from '@/lib/hermes/approval-helpers'

// P5.4 — identity always comes from the authenticated session, never a
// client-supplied header (same rule as enqueuePageRun / live-state): a
// spoofed `x-user-id` would otherwise let any logged-in user read or answer
// another user's pending approvals.
export async function GET() {
  const user = await getCurrentPayloadUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const approvals = await listPendingApprovalsForUser(user.id)
  return NextResponse.json({ docs: approvals })
}

export async function POST(req: NextRequest) {
  const user = await getCurrentPayloadUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json()
  const { id, externalId, decision, selectedOptionId, reason } = body as {
    id?: number
    externalId?: string
    decision: 'approved' | 'denied'
    selectedOptionId?: string
    reason?: string
  }

  if ((!id && !externalId) || !decision) {
    return NextResponse.json({ error: 'id (or externalId) and decision are required' }, { status: 400 })
  }

  // The in-chat approval card (components/hermes/PermissionCard) only ever
  // sees the ACP request id from the RunEvent stream — the `approvals` row is
  // created inside the dispatcher, after the card has already been painted, so
  // its numeric id is not something the transcript can carry. Resolving by
  // `externalId` lets the card answer the request it is actually showing;
  // access is still checked against the row's own `requestedUser` below, so
  // this widens the lookup, never the authorization.
  const approval = externalId ? await getApprovalByExternalId(externalId) : await getApproval(id!)
  if (!approval) {
    return NextResponse.json({ error: 'Approval not found' }, { status: 404 })
  }
  if (approval.requestedUser !== user.id) {
    return NextResponse.json({ error: 'You do not have access to this approval.' }, { status: 403 })
  }

  try {
    await resolveApproval(approval.id, {
      approved: decision === 'approved',
      selectedOptionId,
      reason,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 404 })
  }
}
