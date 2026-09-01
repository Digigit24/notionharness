// Standalone broker smoke test — exercises enqueue/claim/append/settle/sweep
// against the real DB with a small, short-lived pool (per AGENTS.md's shared-
// Supabase connection-cap gotcha). Does NOT call getPayloadClient() at all
// (DB-safety rule) — plain `pg` only, matching the broker's own design.
//
// Run: npx tsx scripts/test-broker.ts
// Cleans up every row it creates before exiting.

import nextEnv from '@next/env'
import { Pool } from 'pg'
import {
  enqueueRun,
  claimNextRun,
  markRunStarted,
  renewLease,
  settleRun,
  sweepExpiredLeases,
  getRun,
  appendRunEvent,
  listRunEvents,
  recordUsage,
  closeBrokerPool,
} from '../lib/broker'

nextEnv.loadEnvConfig(process.cwd())

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function findRealUserId(): Promise<number> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
  try {
    const res = await pool.query<{ id: number }>('SELECT id FROM users ORDER BY id ASC LIMIT 1')
    if (!res.rows[0]) throw new Error('No users row exists to use as accountable_user — seed at least one user first.')
    return res.rows[0].id
  } finally {
    await pool.end()
  }
}

async function main() {
  const userId = await findRealUserId()
  const createdRunIds: number[] = []

  try {
    // --- ENQUEUE ---
    const run = await enqueueRun({ accountableUser: userId, priority: 5 })
    createdRunIds.push(run.id)
    assert(run.status === 'queued', `expected queued, got ${run.status}`)
    assert(run.attempt === 1, `expected attempt 1, got ${run.attempt}`)
    console.log(`[ok] enqueueRun -> run ${run.id}, status=${run.status}`)

    // --- CLAIM (FOR UPDATE SKIP LOCKED) ---
    const claimed = await claimNextRun('test-worker-1', 5_000)
    assert(claimed !== null, 'expected a run to be claimed')
    assert(claimed!.id === run.id, `expected to claim run ${run.id}, got ${claimed!.id}`)
    assert(claimed!.status === 'dispatched', `expected dispatched, got ${claimed!.status}`)
    assert(claimed!.leaseExpiresAt !== null, 'expected lease_expires_at to be set on claim')
    assert(!!claimed!.runToken && claimed!.runToken.length >= 32, `expected a real run_token minted at claim, got ${JSON.stringify(claimed!.runToken)}`)
    console.log(`[ok] claimNextRun -> claimed run ${claimed!.id}, status=${claimed!.status}, lease set, run_token minted`)

    // A second immediate claim must find nothing (no other queued run).
    const secondClaim = await claimNextRun('test-worker-2', 5_000)
    assert(secondClaim === null, `expected no second run to claim, got ${JSON.stringify(secondClaim)}`)
    console.log('[ok] second claimNextRun with nothing queued -> null')

    await markRunStarted(run.id)
    const started = await getRun(run.id)
    assert(started!.status === 'running', `expected running, got ${started!.status}`)
    assert(started!.startedAt !== null, 'expected started_at to be set')
    console.log('[ok] markRunStarted -> status=running, started_at set')

    // --- APPEND (monotonic seq) ---
    const e1 = await appendRunEvent(run.id, { type: 'message', role: 'user', text: 'hello' })
    const e2 = await appendRunEvent(run.id, { type: 'tool_call', id: 't1', name: 'bash', input: { cmd: 'ls' }, status: 'running' })
    const e3 = await appendRunEvent(run.id, { type: 'done', status: 'ok' })
    assert(e1.seq === 1 && e2.seq === 2 && e3.seq === 3, `expected seq 1,2,3, got ${e1.seq},${e2.seq},${e3.seq}`)
    console.log(`[ok] appendRunEvent x3 -> seq ${e1.seq}, ${e2.seq}, ${e3.seq} (monotonic)`)

    const events = await listRunEvents(run.id)
    assert(events.length === 3, `expected 3 events, got ${events.length}`)
    assert(events[0].event.type === 'message' && events[2].event.type === 'done', 'expected event order to match seq order')
    console.log(`[ok] listRunEvents -> ${events.length} events, correctly seq-ordered`)

    await recordUsage(run.id, { provider: 'anthropic', model: 'claude', tokens: 1234, costTicks: 56 })
    console.log('[ok] recordUsage -> inserted')

    // --- lease renewal ---
    const before = (await getRun(run.id))!.leaseExpiresAt!
    await new Promise((r) => setTimeout(r, 50))
    await renewLease(run.id, 60_000)
    const after = (await getRun(run.id))!.leaseExpiresAt!
    assert(new Date(after).getTime() > new Date(before).getTime(), 'expected renewLease to push lease_expires_at forward')
    console.log('[ok] renewLease -> lease_expires_at extended')

    // --- SETTLE (terminal, no retry) ---
    const { settled, retry } = await settleRun(run.id, 'completed')
    assert(settled.status === 'completed', `expected completed, got ${settled.status}`)
    assert(settled.completedAt !== null, 'expected completed_at to be set')
    assert(retry === null, 'expected no retry on a clean completion')
    assert(settled.runToken === null, `expected run_token wiped at settle, got ${JSON.stringify(settled.runToken)}`)
    console.log('[ok] settleRun(completed) -> settled, no retry spawned, run_token wiped')

    // --- SETTLE with retry ---
    const retryableRun = await enqueueRun({ accountableUser: userId, maxAttempts: 3 })
    createdRunIds.push(retryableRun.id)
    const claimedForFailure = await claimNextRun('test-worker-3', 5_000)
    assert(claimedForFailure!.id === retryableRun.id, 'expected to claim the retryable run')
    assert(
      !!claimedForFailure!.runToken && claimedForFailure!.runToken !== claimed!.runToken,
      'expected each claim to mint its own distinct run_token, not reuse one',
    )
    const failResult = await settleRun(retryableRun.id, 'failed', { error: 'simulated failure', retryable: true })
    assert(failResult.settled.status === 'failed', `expected failed, got ${failResult.settled.status}`)
    assert(failResult.retry !== null, 'expected a retry run to be spawned')
    assert(failResult.retry!.retryOf === retryableRun.id, `expected retry_of=${retryableRun.id}, got ${failResult.retry!.retryOf}`)
    assert(failResult.retry!.attempt === 2, `expected retry attempt 2, got ${failResult.retry!.attempt}`)
    assert(failResult.retry!.status === 'queued', `expected retry queued, got ${failResult.retry!.status}`)
    createdRunIds.push(failResult.retry!.id)
    console.log(`[ok] settleRun(failed, retryable) -> retry run ${failResult.retry!.id} queued, retry_of=${retryableRun.id}, attempt=2`)

    // Drain the still-queued retry spawned above so it can't be the one the
    // RECOVER section below claims instead of its own intended target.
    const leftoverRetry = await claimNextRun('cleanup-drain', 5_000)
    if (leftoverRetry) await settleRun(leftoverRetry.id, 'cancelled')

    // --- RECOVER (lease sweep) ---
    const staleRun = await enqueueRun({ accountableUser: userId })
    createdRunIds.push(staleRun.id)
    const claimedStale = await claimNextRun('dead-worker', 1) // 1ms lease — expires almost immediately
    assert(claimedStale!.id === staleRun.id, 'expected to claim the stale run')
    await new Promise((r) => setTimeout(r, 50)) // let the 1ms lease actually lapse
    const swept = await sweepExpiredLeases()
    assert(swept >= 1, `expected sweepExpiredLeases to reclaim at least 1 run, got ${swept}`)
    const recovered = await getRun(staleRun.id)
    assert(recovered!.status === 'queued', `expected swept run back to queued, got ${recovered!.status}`)
    assert(recovered!.workerId === null, 'expected worker_id cleared after sweep')
    assert(recovered!.leaseExpiresAt === null, 'expected lease_expires_at cleared after sweep')
    console.log(`[ok] sweepExpiredLeases -> reclaimed ${swept} run(s), stale run back to queued`)

    // Clean up the now-queued recovered run so nothing is left claimable.
    const recoveredClaim = await claimNextRun('cleanup-worker', 5_000)
    if (recoveredClaim) await settleRun(recoveredClaim.id, 'cancelled')
    const remainingRetry = await claimNextRun('cleanup-worker-2', 5_000)
    if (remainingRetry) await settleRun(remainingRetry.id, 'cancelled')

    console.log('\nALL BROKER CHECKS PASSED')
  } finally {
    // Delete every row this script created (run_messages/run_usage cascade via FK).
    if (createdRunIds.length) {
      const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
      try {
        await pool.query('DELETE FROM runs WHERE id = ANY($1::bigint[])', [createdRunIds])
        console.log(`[cleanup] deleted ${createdRunIds.length} test run(s): ${createdRunIds.join(', ')}`)
      } finally {
        await pool.end()
      }
    }
    await closeBrokerPool()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
