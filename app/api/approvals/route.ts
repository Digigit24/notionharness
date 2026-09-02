import { NextRequest, NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'
import { resolveApproval, listPendingApprovalsForUser } from '@/lib/hermes/approval-helpers'

export async function GET(req: NextRequest) {
  const userId = req.headers.get('x-user-id')
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const approvals = await listPendingApprovalsForUser(Number(userId))
  return NextResponse.json({ docs: approvals })
}

export async function POST(req: NextRequest) {
  const userId = req.headers.get('x-user-id')
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

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
