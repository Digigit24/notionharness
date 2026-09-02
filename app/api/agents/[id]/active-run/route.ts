import { NextResponse } from 'next/server'
import { getActiveRunForAgent } from '@/lib/broker'
import { getSession } from '@/lib/session'

/**
 * ROADMAP 6.3 audit — polled by the inline @mention chip's live-status dot.
 * Deliberately minimal: just whether the agent has a non-terminal run right
 * now and, if so, its id — nothing about the run's content, matching the
 * run-card route's own "thin read surface" posture.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Mention chips are rendered inside authenticated workspaces. Keep the
  // status probe behind the same session boundary as the users directory so
  // anonymous callers cannot enumerate agent activity by guessing ids.
  if (!(await getSession())) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const { id } = await params
  const agentId = Number(id)
  if (!Number.isFinite(agentId)) {
    return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 })
  }

  const run = await getActiveRunForAgent(agentId)
  return NextResponse.json({ active: run !== null, runId: run?.id ?? null })
}
