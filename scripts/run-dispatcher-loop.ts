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

import nextEnv from '@next/env'

// Phase 0 — needed only to read `DISPATCHER_SECRET` out of `.env`. This does
// NOT reintroduce hazard 1 above: `@next/env` imports nothing from this app,
// so no transitive `payload.config.ts` import happens and no second connection
// pool is opened. It is called before anything else runs for the same reason
// hazard 1 exists at all.
nextEnv.loadEnvConfig(process.cwd())

import fs from 'node:fs'
import path from 'node:path'

const baseUrl = process.argv[2] ?? 'http://localhost:3000'
const POLL_MS = 3000
let stopping = false

// --- Singleton guard ---------------------------------------------------
//
// `.gitignore` has reserved `.dispatcher-loop.pid` since this script was
// first written, but nothing actually wrote or checked it — "kill the
// previous poller before starting a new one" was operator discipline, not
// enforced. AGENTS.md documents the real fallout: multiple zombie pollers
// left running simultaneously after repeated dev-server restarts, all
// hitting `/api/dispatcher/tick` and interleaving into the same log file,
// which looked like a much worse/flakier bug (phantom "run claimed twice"
// noise) than the system actually had. This makes that discipline
// mechanical instead of relying on memory.
const PID_FILE = path.join(process.cwd(), '.dispatcher-loop.pid')

/** Best-effort liveness check. POSIX: `process.kill(pid, 0)` sends no
 * signal, just probes whether the pid exists/is signalable — throws ESRCH
 * if it doesn't, EPERM if it exists but is owned by another user (still
 * "alive" for our purposes). Windows (this dev machine): Node implements
 * signal 0 by calling `OpenProcess`/checking exit status under the hood
 * rather than an actual POSIX signal, but the same exists/doesn't-exist
 * contract holds — it still throws for a pid that isn't running. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

function assertSingleton(): void {
  if (fs.existsSync(PID_FILE)) {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim()
    const existingPid = Number(raw)
    if (Number.isInteger(existingPid) && existingPid > 0 && isProcessAlive(existingPid)) {
      console.error(
        `[dispatcher] Refusing to start: another dispatcher loop appears to be running ` +
          `(pid ${existingPid}, per ${PID_FILE}). Stop it first (or delete the pidfile if ` +
          `you're certain that pid is stale) before starting a new one — see AGENTS.md's ` +
          `dispatcher/broker lessons for why running two of these at once is a real problem, ` +
          `not just wasted work.`,
      )
      process.exit(1)
    }
    // Pidfile exists but its pid is dead — a previous run didn't clean up
    // (crash, kill -9, machine sleep). Safe to reclaim.
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8')
}

/** Only removes the pidfile if it still names *this* process — never blow
 * away a pidfile a newer instance already wrote for itself. */
function releasePidFile(): void {
  try {
    if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE)
    }
  } catch {
    // Best-effort cleanup only — a leftover pidfile just means the next
    // start has to confirm it's stale, per assertSingleton above.
  }
}

assertSingleton()
process.on('exit', releasePidFile)

process.on('SIGINT', () => {
  stopping = true
})
process.on('SIGTERM', () => {
  stopping = true
})

interface DispatchOutcome {
  claimed: boolean
  runId?: number
  // 'started' means the tick claimed a run and handed it to a detached
  // execution task without waiting for it — see `lib/dispatcher/worker.ts`'s
  // execution-registry comment. This poller never observes 'completed'/
  // 'failed' directly any more; only the process still running that
  // detached task does.
  status?: 'started' | 'completed' | 'failed'
  error?: string
  recovered?: number
}

// Phase 0 — the tick route now refuses an unauthenticated caller (see
// `app/api/internal-auth.ts`). This process cannot hold a session by design, so
// the shared secret is its only way in; when the variable is unset the route
// still allows a development build, which is why this sends no header rather
// than refusing to start.
const DISPATCHER_SECRET = process.env.DISPATCHER_SECRET || ''

async function tick(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/dispatcher/tick`, {
    method: 'POST',
    headers: DISPATCHER_SECRET ? { 'X-Dispatcher-Secret': DISPATCHER_SECRET } : {},
  })
  if (!res.ok) throw new Error(`tick returned ${res.status}`)
  const outcome = (await res.json()) as DispatchOutcome
  if (outcome.claimed) {
    console.log(`[dispatcher] run ${outcome.runId} -> ${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}`)
  }
  if (outcome.recovered) console.log(`[dispatcher] requeued ${outcome.recovered} expired run lease(s)`)
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
