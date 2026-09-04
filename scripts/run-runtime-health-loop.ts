// Phase C, C1.3 — polls `/api/runtimes/health-check` on a timer so the
// `runtimes` collection reflects real, current Hermes reachability instead
// of going stale the moment nobody happens to load the runtimes page.
//
// Deliberately a thin HTTP poller, not a process that imports
// `refreshAllRuntimes`/Payload itself — identical reasoning to
// `scripts/run-dispatcher-loop.ts` (see that file's own header comment):
// `payload.config.ts` reads `process.env.DATABASE_URI` at import time, and a
// second process calling `getPayloadClient()` would open a second Postgres
// connection pool against this project's small, shared, connection-capped
// Supabase instance. POSTing to the dev server's own route instead reuses
// its already-loaded env and single cached Payload client.
//
// Usage: npx tsx scripts/run-runtime-health-loop.ts [baseUrl]
//   (baseUrl defaults to http://localhost:3000 — the shared dev server)

import nextEnv from '@next/env'

// Phase 0 — needed only to read `DISPATCHER_SECRET` out of `.env`, which the
// health-check route now requires. `@next/env` imports nothing from this app,
// so the connection-pool hazard the header describes does not apply to it.
nextEnv.loadEnvConfig(process.cwd())

import fs from 'node:fs'
import path from 'node:path'

const baseUrl = process.argv[2] ?? 'http://localhost:3000'
// Runtime health changes far less often than dispatcher work needs claiming
// — a Hermes install going up/down is a human-timescale event, not a
// queue-draining one — so this polls much less aggressively than the
// dispatcher loop's 3s.
const POLL_MS = 30_000
let stopping = false

// --- Singleton guard — same pattern and same real-world reason as
// run-dispatcher-loop.ts's own (see that file): without it, repeated dev-
// server restarts leave zombie pollers hitting the same route concurrently.
const PID_FILE = path.join(process.cwd(), '.runtime-health-loop.pid')

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
        `[runtime-health] Refusing to start: another runtime-health loop appears to be running ` +
          `(pid ${existingPid}, per ${PID_FILE}). Stop it first (or delete the pidfile if ` +
          `you're certain that pid is stale) before starting a new one.`,
      )
      process.exit(1)
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8')
}

function releasePidFile(): void {
  try {
    if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE)
    }
  } catch {
    // Best-effort cleanup only.
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

interface HealthCheckOutcome {
  checked: number
}

async function tick(): Promise<void> {
  // Same shared secret as the dispatcher loop — this route is gated by the
  // same `app/api/internal-auth.ts` check, for the same reason.
  const secret = process.env.DISPATCHER_SECRET || ''
  const res = await fetch(`${baseUrl}/api/runtimes/health-check`, {
    method: 'POST',
    headers: secret ? { 'X-Dispatcher-Secret': secret } : {},
  })
  if (!res.ok) throw new Error(`health-check returned ${res.status}`)
  const outcome = (await res.json()) as HealthCheckOutcome
  console.log(`[runtime-health] checked ${outcome.checked} runtime profile(s)`)
}

async function loop(): Promise<void> {
  console.log(`[runtime-health] polling ${baseUrl}/api/runtimes/health-check every ${POLL_MS}ms`)
  while (!stopping) {
    try {
      await tick()
    } catch (err) {
      console.error('[runtime-health] loop error', err instanceof Error ? err.message : err)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  console.log('[runtime-health] stopped')
}

loop().catch((err) => {
  console.error('[runtime-health] fatal', err)
  process.exitCode = 1
})
