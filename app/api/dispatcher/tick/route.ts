import { NextResponse } from 'next/server'
import { dispatchNextRun } from '@/lib/dispatcher/worker'
import { sweepExpiredLeases } from '@/lib/broker/runs'

// Every tick, not every tenth. `sweepExpiredLeases` is one indexed UPDATE
// that normally matches nothing, so the cost is negligible — while the
// delay it used to add was very visible: a run orphaned by a server restart
// keeps its `running` status until something reclaims it, and the chat
// composer stays locked on "Agent is answering…" that whole time. Waiting
// out the lease is unavoidable (a real turn can legitimately run for
// minutes), but adding up to another 30s on top of it isn't.
const SWEEP_EVERY_TICKS = 1
let ticksSinceSweep = 0

/**
 * Internal-only trigger for `dispatchNextRun`, meant to be polled by
 * `scripts/run-dispatcher-loop.ts` (a separate process with no Payload/DB
 * imports of its own — see that script's header comment for why). Running
 * inside the Next.js server process means this reuses the app's already-
 * loaded env and the single cached Payload client (`lib/payload.ts`'s
 * `global._notionforgePayloadClient`), rather than a standalone script
 * opening a second connection pool against the shared, connection-capped
 * Supabase instance.
 *
 * `dispatchNextRun` claims at most one run and hands its actual execution
 * off to a detached in-process task (`lib/dispatcher/worker.ts`'s execution
 * registry) rather than awaiting it here — so this response returns as soon
 * as the claim (or "nothing queued") is known, never after a turn finishes.
 * A single run can otherwise legitimately run for up to `turnTimeoutMs`
 * (10 minutes for `permissionMode: 'ask'`), and the poller below hits this
 * route every 3s with no mutex of its own.
 */
export async function POST() {
  ticksSinceSweep += 1
  let recovered = 0
  if (ticksSinceSweep >= SWEEP_EVERY_TICKS) {
    ticksSinceSweep = 0
    recovered = await sweepExpiredLeases()
  }
  const outcome = await dispatchNextRun(`server-${process.pid}`)
  return NextResponse.json({ ...outcome, recovered })
}
