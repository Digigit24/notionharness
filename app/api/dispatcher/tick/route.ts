import { NextResponse } from 'next/server'
import { dispatchNextRun } from '@/lib/dispatcher/worker'
import { sweepExpiredLeases } from '@/lib/broker/runs'
import { recordDispatcherTick } from '@/lib/broker/dispatcher-health'
import { reclaimRunWorktrees } from '@/lib/run-worktrees/retention'
import { resolveRunWorktreeConfig } from '@/lib/run-worktrees/config'
import { bestEffort } from '@/lib/failures'
import { logger } from '@/lib/logger'
import { requireInternalCaller } from '../../internal-auth'

// Every tick, not every tenth. `sweepExpiredLeases` is one indexed UPDATE
// that normally matches nothing, so the cost is negligible — while the
// delay it used to add was very visible: a run orphaned by a server restart
// keeps its `running` status until something reclaims it, and the chat
// composer stays locked on "Agent is answering…" that whole time. Waiting
// out the lease is unavoidable (a real turn can legitimately run for
// minutes), but adding up to another 30s on top of it isn't.
const SWEEP_EVERY_TICKS = 1
let ticksSinceSweep = 0

// R3.4 — reclaim stale per-run checkouts about once an hour at the 3s poll
// rate. Deliberately rare and deliberately off the response path: it walks
// directories and shells out to git, which is exactly the kind of work D0
// forbids in front of anything a person is waiting on. The guard makes a slow
// pass unable to overlap itself no matter how many ticks arrive meanwhile.
const RECLAIM_EVERY_TICKS = 1200
let ticksSinceReclaim = 0
let reclaimInFlight = false

// Off unless explicitly turned on. Deleting a run's checkout is not
// reversible and it is not obviously safe: a worktree holds the diff a review
// screen reads, and only the person who owns this machine knows whether an
// old run still matters to them. The policy is implemented and testable
// (`npx tsx scripts/reclaim-worktrees.ts`, dry run by default) — arming it is
// a decision, not a default.
const RECLAIM_ENABLED = process.env.RUN_WORKTREE_AUTO_RECLAIM === 'true'

function maybeReclaimWorktrees(): void {
  if (!RECLAIM_ENABLED) return
  ticksSinceReclaim += 1
  if (ticksSinceReclaim < RECLAIM_EVERY_TICKS || reclaimInFlight) return
  ticksSinceReclaim = 0
  reclaimInFlight = true
  const { source, rootDir } = resolveRunWorktreeConfig()
  void reclaimRunWorktrees({ source, rootDir })
    .then((report) => {
      // Reported rather than silent: space that disappears without explanation
      // is indistinguishable from a bug, and the kept-reasons are the part
      // worth reading when something was NOT reclaimed.
      if (report.removed.length > 0 || report.failures.length > 0) {
        const mb = (report.reclaimedBytes / 1024 / 1024).toFixed(1)
        logger.info('reclaimed run checkouts', {
          removed: report.removed.length,
          examined: report.examined,
          kept: report.kept.length,
          reclaimedMb: mb,
        })
        for (const failure of report.failures) {
          logger.warn('could not remove a run checkout', { runId: failure.runId, error: failure.error })
        }
      }
    })
    .catch((err) => logger.warn('worktree reclaim pass failed', { error: String(err) }))
    .finally(() => {
      reclaimInFlight = false
    })
}

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
export async function POST(request: Request) {
  // Before the heartbeat, before the sweep, before anything: this route
  // spawns a real agent process on this host, so an unauthorised caller must
  // not even leave a trace that says the loop is alive.
  const refusal = await requireInternalCaller(request, 'dispatcher/tick')
  if (refusal) return refusal
  const workerId = `server-${process.pid}`
  // Recorded before any work, so a tick that then fails still proves the
  // loop is alive — the heartbeat answers "is anything polling", which is a
  // different question from "did this tick succeed". Fire-and-forget: a
  // heartbeat write must never be the thing that stops dispatching.
  void bestEffort(
    recordDispatcherTick(workerId),
    'a heartbeat write must never be the thing that stops dispatching',
    { workerId },
  )
  maybeReclaimWorktrees()
  ticksSinceSweep += 1
  let recovered = 0
  if (ticksSinceSweep >= SWEEP_EVERY_TICKS) {
    ticksSinceSweep = 0
    recovered = await sweepExpiredLeases()
  }
  const outcome = await dispatchNextRun(workerId)
  return NextResponse.json({ ...outcome, recovered })
}
