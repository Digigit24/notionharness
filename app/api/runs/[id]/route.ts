import { NextResponse } from 'next/server'
import { getRun } from '@/lib/broker/runs'
import { getRunUsageTotals } from '@/lib/broker/usage'
import { countRunEvents } from '@/lib/broker/messages'

/**
 * ROADMAP 6.3 — read-only surface the run-card block polls. Deliberately
 * thin: no transcript, no tokens, no mcpOverlay/runToken (per §4.7, a live
 * bearer token must never linger anywhere reachable, let alone a public-ish
 * read route) — just status + cost + step count, everything a "$4.38 · 18m ·
 * 163 steps"-style card needs and nothing else.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const runId = Number(id)
  if (!Number.isFinite(runId)) {
    return NextResponse.json({ error: 'Invalid run id' }, { status: 400 })
  }

  const run = await getRun(runId)
  if (!run) {
    return NextResponse.json({ error: 'Run not found.' }, { status: 404 })
  }

  const [usage, stepCount] = await Promise.all([getRunUsageTotals(runId), countRunEvents(runId)])

  return NextResponse.json({
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
    stepCount,
    totalTokens: usage.totalTokens,
    totalCostTicks: usage.totalCostTicks,
  })
}
