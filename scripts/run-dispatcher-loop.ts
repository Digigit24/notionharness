// ROADMAP Pillar 4/6.1 — `lib/dispatcher/worker.ts`'s `dispatchNextRun` exists
// and is verified against the real hermes-acp binary, but nothing calls it:
// a task assignment enqueues a broker run that then sits 'queued' forever
// without something polling `claimNextRun`. A dedicated daemon process is
// the real Pillar 4.1 destination for this.
//
// This script is deliberately a thin HTTP poller, not a process that imports
// `dispatchNextRun`/Payload itself — two reasons:
//   1. `payload.config.ts` reads `process.env.DATABASE_URI` at import time
//      (top-level `postgresAdapter({ pool: { connectionString } })`), before
//      any `nextEnv.loadEnvConfig()` call in an importing script's own body
//      could run — ESM imports are hoisted, so by the time this script's
//      top-level code executes, that config object is already built.
//   2. Even with env loaded correctly, a second process calling
//      `getPayloadClient()` opens a SECOND Postgres connection pool against
//      this project's small, shared, connection-capped Supabase instance
//      (already hit once this session) — on top of the dev server's own
//      pool and the broker's own small pool.
// POSTing to the dev server's own `/api/dispatcher/tick` route instead reuses
// its already-loaded env and its single cached Payload client — no new pool,
// no import-order hazard.
//
// Usage: npx tsx scripts/run-dispatcher-loop.ts [baseUrl]
//   (baseUrl defaults to http://localhost:3000 — the shared dev server)

const baseUrl = process.argv[2] ?? 'http://localhost:3000'
const POLL_MS = 3000
let stopping = false

process.on('SIGINT', () => {
  stopping = true
})
process.on('SIGTERM', () => {
  stopping = true
})

interface DispatchOutcome {
  claimed: boolean
  runId?: number
  status?: 'completed' | 'failed'
  error?: string
}

async function tick(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/dispatcher/tick`, { method: 'POST' })
  if (!res.ok) throw new Error(`tick returned ${res.status}`)
  const outcome = (await res.json()) as DispatchOutcome
  if (outcome.claimed) {
    console.log(`[dispatcher] run ${outcome.runId} -> ${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}`)
  }
}

async function loop(): Promise<void> {
  console.log(`[dispatcher] polling ${baseUrl}/api/dispatcher/tick every ${POLL_MS}ms`)
  while (!stopping) {
    try {
      await tick()
    } catch (err) {
      console.error('[dispatcher] loop error', err instanceof Error ? err.message : err)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  console.log('[dispatcher] stopped')
}

loop().catch((err) => {
  console.error('[dispatcher] fatal', err)
  process.exitCode = 1
})
