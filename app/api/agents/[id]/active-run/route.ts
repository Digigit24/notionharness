import { NextResponse } from 'next/server'
import { getActiveRunForAgent } from '@/lib/broker'

/**
 * ROADMAP 6.3 audit — polled by the inline @mention chip's live-status dot.
 * Deliberately minimal: just whether the agent has a non-terminal run right
 * now and, if so, its id — nothing about the run's content, matching the
 * run-card route's own "thin read surface" posture.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const agentId = Number(id)
  if (!Number.isFinite(agentId)) {
    return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 })
  }

  const run = await getActiveRunForAgent(agentId)
  return NextResponse.json({ active: run !== null, runId: run?.id ?? null })
}
