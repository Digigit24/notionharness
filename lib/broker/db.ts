import { Pool } from 'pg'

// Shared small pool for the raw-pg-owned broker tables (runs/run_messages/
// run_usage — see AGENTS.md's D5 section). Kept deliberately small: this
// project's Postgres is a shared, small-tier Supabase instance with a real
// session-mode connection cap (~15, hit and confirmed live this session) —
// every teammate's dev server and one-off script competes for the same pool.
//
// `max` was 3, sized back when the tick route awaited exactly one run's
// execution at a time. `lib/dispatcher/worker.ts` now runs up to
// `DISPATCHER_MAX_CONCURRENT_RUNS` (default 4) runs concurrently in this
// same process, each independently issuing short-lived queries against this
// pool (a lease-heartbeat `renewLease` every ~15s, `appendRunEvent`/
// `recordUsage` per live event, plus the one-off `markRunStarted`/
// `settleRun` calls) — those queries are brief and don't hold a connection
// for a run's whole lifetime, but enough of them can land in the same
// instant that 3 became a real bottleneck. 6 stays comfortably under the
// shared instance's connection cap alongside the dev server's own Payload
// pool and everyone else's.
let pool: Pool | null = null

export function getBrokerPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URI || '',
      max: 6,
    })
  }
  return pool
}

export async function closeBrokerPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
