import { NextResponse } from 'next/server'
import { getRun } from '@/lib/broker/runs'
import { listRunEvents } from '@/lib/broker/messages'
import { processTranscript } from '@/lib/transcript/pipeline'
import type { RunEventEnvelope } from '@/lib/run-events'

/**
 * ROADMAP 6.3 — read-only surface the run-card block polls. Deliberately
 * thin: no transcript, no tokens, no mcpOverlay/runToken (per §4.7, a live
 * bearer token must never linger anywhere reachable, let alone a public-ish
 * read route) — just status + the real outcome chips + step count.
 *
 * `stepCount`/`chips` come from `processTranscript` — the same pipeline the
 * transcript UI uses — rather than a raw `run_messages` count (which
 * over-counts by including session/usage/done events as "steps") or a
 * separately-summed cost (which duplicated `outcome.totalCostTicks`'s own
 * math through a second code path). One source of truth for both.
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

  const rows = await listRunEvents(runId)
  const envelopes: RunEventEnvelope[] = rows.map((row) => ({ runId: String(runId), seq: row.seq, event: row.event }))
  const { steps, outcome } = processTranscript(envelopes)

  return NextResponse.json({
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
    stepCount: steps.length,
    chips: outcome.chips,
  })
}
