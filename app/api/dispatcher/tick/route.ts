import { NextResponse } from 'next/server'
import { dispatchNextRun } from '@/lib/dispatcher/worker'
import { sweepExpiredLeases } from '@/lib/broker/runs'

const SWEEP_EVERY_TICKS = 10
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
