import { NextRequest, NextResponse } from 'next/server'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { resolveApproval, listPendingApprovalsForUser, getApproval } from '@/lib/hermes/approval-helpers'

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
  const { id, decision, selectedOptionId, reason } = body as {
    id: number
    decision: 'approved' | 'denied'
    selectedOptionId?: string
    reason?: string
  }

  if (!id || !decision) {
    return NextResponse.json({ error: 'id and decision are required' }, { status: 400 })
  }

  const approval = await getApproval(id)
  if (!approval) {
    return NextResponse.json({ error: 'Approval not found' }, { status: 404 })
  }
  if (approval.requestedUser !== user.id) {
    return NextResponse.json({ error: 'You do not have access to this approval.' }, { status: 403 })
  }

  try {
    await resolveApproval(id, {
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
