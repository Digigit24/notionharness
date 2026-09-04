import { NextResponse } from 'next/server'
import { refreshAllRuntimes } from '@/lib/runtimes/hermes/runtime-health'

/**
 * Internal-only trigger for `refreshAllRuntimes`, meant to be polled by
 * `scripts/run-runtime-health-loop.ts` (a separate process with no Payload/
 * DB imports of its own) — same reasoning as `/api/dispatcher/tick`: running
 * inside the Next.js server process reuses its already-loaded env and
 * single cached Payload client, rather than a standalone script opening a
 * second connection pool against the shared, connection-capped Supabase
 * instance. Also callable directly (e.g. a "Refresh" button on the runtimes
 * page) for an on-demand check between timer ticks.
 */
export async function POST() {
  const result = await refreshAllRuntimes()
  return NextResponse.json(result)
}
