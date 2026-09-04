// R12-P5.4 — "orchestration is verified by killing it, not by reading it."
//
// Five scenarios, each with a defined outcome, each proven against the REAL
// broker database (and, for the approval scenario, the REAL Payload client —
// same posture `scripts/e2e-approval-data-plane.ts` already established as
// safe against this shared instance). No live agent binary is required for
// four of the five: a crash, a cancellation, a pool exhaustion and an
// unanswered approval are all states a `runs`/`approvals` row can be put
// into directly, which is exactly what this script does — matching this
// repo's own `scripts/test-*.ts` convention of asserting on real rows and
// real behaviour rather than "no error was thrown".
//
// The fifth (the per-agent maxConcurrentRuns ceiling) is the one scenario
// that genuinely needs a live turn to observe — see its own comment below
// for why it is opt-in rather than run by default.
//
//   npx tsx scripts/test-chaos-dispatcher.ts
//   CHAOS_LIVE_CONCURRENCY=1 npx tsx scripts/test-chaos-dispatcher.ts   # + scenario 5, live
import nextEnv from '@next/env'
nextEnv.loadEnvConfig(process.cwd())
if (!process.env.DATABASE_URI) throw new Error('DATABASE_URI unset — .env not loaded')

const { getBrokerPool, closeBrokerPool } = await import('../lib/broker/db')
const { requestRunCancellation, isRunCancellationRequested, settleRun, sweepExpiredLeases, getRun, enqueueRun } =
  await import('../lib/broker/runs')
const { classifyRunFailure } = await import('../lib/dispatcher/classify-failure')

const pool = getBrokerPool()
let failures = 0

// `runs_task_agent_active_uidx` (lib/broker/migrations/0007) is a
// COALESCE(-1)-based unique index over (task_id, agent_id, page_id,
// session_id) for any non-terminal run — real behaviour discovered while
// writing this script: two `task_id IS NULL AND agent_id IS NULL`-shaped
// active runs collide on insert even though the ORIGINAL comment on the
// very first version of this index (0001) said NULLs would be distinct;
// 0004/0007 deliberately closed that gap. So every run this script enqueues
// gets its own fake `pageId` — `page_id` has no FK, and a large monotonic
// fake id is enough to make each row's key tuple unique without needing a
// real `pages` row.
let fakePageIdCounter = 900_000_000 + Math.floor(Math.random() * 1_000_000) * 100
function nextFakePageId(): number {
  fakePageIdCounter += 1
  return fakePageIdCounter
}
const cleanupRunIds: number[] = []
const cleanupApprovalExternalIds: string[] = []

function check(label: string, condition: boolean, detail?: unknown): void {
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  if (!condition) failures += 1
}

// Real user id, needed for `runs.accountable_user` (NOT NULL, FK). Fixtures
// are read, never created — this script must not depend on being able to
// write to `users`/`agents`.
async function requireAnyUserId(): Promise<number> {
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM users LIMIT 1')
  if (!rows[0]) throw new Error('this database has no users row — nothing to attribute a test run to')
  return rows[0].id
}

// ---------------------------------------------------------------------------
// Scenario 1 — a worker dies mid-turn; lease recovery reclaims the run.
//
// `sweepExpiredLeases` is what `app/api/dispatcher/tick/route.ts` calls on
// every single tick (SWEEP_EVERY_TICKS = 1) — this is the mechanism a real
// server-restart-mid-turn relies on, exercised directly rather than through
// the HTTP route.
async function scenarioLeaseRecovery(accountableUser: number): Promise<void> {
  console.log('\n--- Scenario 1: worker killed mid-turn (lease recovery) ---')

  const crashed = await enqueueRun({ accountableUser, pageId: nextFakePageId(), prompt: 'chaos: crashed mid-turn' })
  cleanupRunIds.push(crashed.id)
  // Simulate exactly what a real crash leaves behind: 'running', a worker id
  // that no longer exists, and a lease that expired in the past.
  await pool.query(
    `UPDATE runs SET status = 'running', worker_id = 'dead-worker-simulated', lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [crashed.id],
  )

  // Control case: a run whose lease has NOT expired must survive the sweep
  // untouched — otherwise this "recovery" would just be "reset everything".
  const healthy = await enqueueRun({ accountableUser, pageId: nextFakePageId(), prompt: 'chaos: still healthy' })
  cleanupRunIds.push(healthy.id)
  await pool.query(
    `UPDATE runs SET status = 'running', worker_id = 'alive-worker-simulated', lease_expires_at = now() + interval '5 minutes' WHERE id = $1`,
    [healthy.id],
  )

  const recovered = await sweepExpiredLeases()
  check('sweepExpiredLeases reclaimed at least the one expired-lease run', recovered >= 1, { recovered })

  const afterCrash = await getRun(crashed.id)
  check('the crashed run is back to queued', afterCrash?.status === 'queued', afterCrash?.status)
  check('the crashed run lost its worker id', afterCrash?.workerId === null, afterCrash?.workerId)
  check('the crashed run lost its lease', afterCrash?.leaseExpiresAt === null, afterCrash?.leaseExpiresAt)

  const afterHealthy = await getRun(healthy.id)
  check(
    'the healthy (non-expired-lease) run was left alone',
    afterHealthy?.status === 'running' && afterHealthy?.workerId === 'alive-worker-simulated',
    { status: afterHealthy?.status, workerId: afterHealthy?.workerId },
  )
}

// ---------------------------------------------------------------------------
// Scenario 2 — a cancelled run is honoured and NEVER retried.
//
// `classify-failure.ts`'s own header names the bug this guards: an old settle
// path used `retryable: !succeeded`, which requeued the very turn someone
// had just pressed Stop on. This proves both halves — the TAXONOMY decision
// (classifyRunFailure with cancellationRequested wins over any pattern in
// the text) and the DATABASE decision (settleRun('cancelled') creates no
// retry row) — and contrasts it against an ordinary retryable failure, which
// DOES get a retry, so the two paths are provably different rather than
// merely asserted to be.
async function scenarioCancellationNotRetried(accountableUser: number): Promise<void> {
  console.log('\n--- Scenario 2: cancellation is honoured and is not a failure ---')

  const run = await enqueueRun({ accountableUser, maxAttempts: 3, pageId: nextFakePageId(), prompt: 'chaos: about to be cancelled' })
  cleanupRunIds.push(run.id)

  const requested = await requestRunCancellation(run.id)
  check('requestRunCancellation reports it took effect', requested === true)
  check('isRunCancellationRequested now reports true', await isRunCancellationRequested(run.id))

  // The taxonomy: even an error whose TEXT looks like an ordinary crash must
  // resolve to 'cancelled' once the caller says cancellation was requested —
  // this is `cancellationRequested`'s whole job, checked FIRST in
  // `classifyRunFailure`, ahead of every pattern.
  const disposition = classifyRunFailure(new Error('spawn ENOENT — looks like an ordinary crash'), {
    cancellationRequested: true,
  })
  check('classifyRunFailure treats a requested cancellation as cancelled, not failed', disposition.outcome === 'cancelled', disposition)

  const { settled, retry } = await settleRun(run.id, 'cancelled')
  check('the row settles as cancelled', settled.status === 'cancelled', settled.status)
  check('a cancelled run is NEVER retried', retry === null, retry)

  // Contrast: an ORDINARY retryable failure, same attempt/maxAttempts shape,
  // DOES get a retry row — proving cancellation's "no retry" is a deliberate
  // branch, not just "nothing happened to retry".
  const failing = await enqueueRun({ accountableUser, maxAttempts: 3, pageId: nextFakePageId(), prompt: 'chaos: ordinary retryable failure' })
  cleanupRunIds.push(failing.id)
  const { retry: ordinaryRetry } = await settleRun(failing.id, 'failed', { error: 'db_unavailable (simulated)', retryable: true })
  check('an ordinary retryable failure DOES get a retry row (the contrast case)', ordinaryRetry !== null, ordinaryRetry?.id)
  if (ordinaryRetry) cleanupRunIds.push(ordinaryRetry.id)
}

// ---------------------------------------------------------------------------
// Scenario 3 — the per-agent maxConcurrentRuns ceiling.
//
// This is the one scenario that cannot be proven against the broker tables
// alone: `agentInFlightCounts` (worker.ts) is in-process state incremented
// only once a real turn actually starts, so observing the ceiling means
// dispatching two REAL turns against a real ACP binary and confirming the
// second's turn does not start until the first's does. Doing that safely
// means creating a throwaway agent row pointed at an already-probed runtime
// profile and running two small real turns through it — real work against
// a shared dev database that (per this session) other agents may be using
// concurrently. That is a reasonable thing to do deliberately, on request,
// and not a reasonable thing for a script to do by default on every run.
//
// So: opt-in via CHAOS_LIVE_CONCURRENCY=1. Skipped otherwise, loudly, with
// the exact lines that implement the ceiling named so a reader can go verify
// it by inspection instead — worker.ts's `maxConcurrentForAgent` gate.
async function scenarioConcurrencyCeiling(): Promise<void> {
  console.log('\n--- Scenario 3: per-agent maxConcurrentRuns ceiling ---')
  if (process.env.CHAOS_LIVE_CONCURRENCY !== '1') {
    console.log(
      'SKIP  not run by default (needs a real ACP turn against a throwaway agent on this shared dev database).\n' +
        '      Re-run with CHAOS_LIVE_CONCURRENCY=1 to exercise it live.\n' +
        '      Enforced in lib/dispatcher/worker.ts, executeClaimedRun(): the\n' +
        '      `while ((agentInFlightCounts.get(agentId) ?? 0) >= maxConcurrentForAgent)\n' +
        '      await sleep(...)` loop, gating entry just before `incrAgentInFlight`/\n' +
        '      `sendTurnWithIdentity` — read there rather than fabricated as a pass here.',
    )
    return
  }

  const { rows: profileRows } = await pool.query<{ id: number; workspace_id: number }>(
    `SELECT id, workspace_id FROM runtime_profiles WHERE enabled = true AND last_probe_code = 'ok' LIMIT 1`,
  )
  if (!profileRows[0]) {
    check('a working, already-probed runtime profile exists to build a throwaway agent on', false, 'none found')
    return
  }
  const profile = profileRows[0]
  const accountableUser = await requireAnyUserId()

  const { rows: agentRows } = await pool.query<{ id: number }>(
    `INSERT INTO agents (name, workspace_id, runtime_profile_id, permission_mode, max_concurrent_runs, enabled, updated_at, created_at)
     VALUES ('chaos-test throwaway agent', $1, $2, 'auto', 1, true, now(), now())
     RETURNING id`,
    [profile.workspace_id, profile.id],
  )
  const agentId = agentRows[0].id

  try {
    const { dispatchNextRun } = await import('../lib/dispatcher/worker')
    const runA = await enqueueRun({ accountableUser, agentId, pageId: nextFakePageId(), prompt: 'Reply with exactly the word "one" and nothing else.' })
    const runB = await enqueueRun({ accountableUser, agentId, pageId: nextFakePageId(), prompt: 'Reply with exactly the word "two" and nothing else.' })
    cleanupRunIds.push(runA.id, runB.id)

    await dispatchNextRun('chaos-worker-a')
    await dispatchNextRun('chaos-worker-b')

    const deadline = Date.now() + 90_000
    let a = await getRun(runA.id)
    let b = await getRun(runB.id)
    while ((a?.status !== 'completed' && a?.status !== 'failed') || (b?.status !== 'completed' && b?.status !== 'failed')) {
      if (Date.now() > deadline) break
      await new Promise((r) => setTimeout(r, 500))
      a = await getRun(runA.id)
      b = await getRun(runB.id)
    }

    check('both runs eventually settled', a?.status === 'completed' && b?.status === 'completed', {
      a: a?.status,
      b: b?.status,
    })
    if (a?.completedAt && b?.completedAt) {
      const gapMs = Math.abs(new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())
      // With maxConcurrentRuns=1, the two turns cannot overlap — the second
      // one's ACTUAL start (not its claim) waits for the first's finish, so
      // the gap between their completions should be close to one full
      // turn's duration, not near-zero the way two PARALLEL turns would be.
      check(`the two completions are meaningfully spaced apart (serialized), gap=${gapMs}ms`, gapMs > 500, gapMs)
    }
  } finally {
    await pool.query('DELETE FROM agents WHERE id = $1', [agentId])
  }
}

// ---------------------------------------------------------------------------
// Scenario 4 — exhausting the broker pool produces a clear typed failure,
// never a silent hang.
//
// `lib/broker/db.ts`'s pool caps at 3 connections specifically because this
// Postgres instance's own real cap (15) is shared across every pool in this
// process AND every teammate's dev server — `connectionTimeoutMillis: 8_000`
// exists for exactly this scenario. Filling the pool and then asking for one
// more connection proves that guard actually fires.
async function scenarioPoolExhaustion(): Promise<void> {
  console.log('\n--- Scenario 4: broker pool exhaustion fails clearly, does not hang ---')
  const max = (pool.options as { max?: number }).max ?? 3
  const held: Array<{ release: () => void }> = []
  try {
    for (let i = 0; i < max; i += 1) {
      held.push(await pool.connect())
    }
    check(`filled the pool (max=${max})`, held.length === max)

    const start = Date.now()
    let threw: unknown = null
    try {
      await pool.connect()
    } catch (err) {
      threw = err
    }
    const elapsedMs = Date.now() - start

    check('the extra connection attempt actually failed rather than hanging', threw !== null, threw instanceof Error ? threw.message : threw)
    // Generous window: real behaviour is "settles at connectionTimeoutMillis
    // (8s)", not instantly and not never.
    check(`it failed within a bounded time (~8s, not a hang), elapsed=${elapsedMs}ms`, elapsedMs < 15_000 && elapsedMs > 1_000, elapsedMs)

    const message = threw instanceof Error ? threw.message : String(threw)
    check(
      'the failure is recognisably a pool/timeout problem (this app\'s classifyRunFailure maps this text to db_unavailable, which IS retryable)',
      /timeout|pool|connection/i.test(message),
      message,
    )
  } finally {
    for (const client of held) client.release()
  }
}

// ---------------------------------------------------------------------------
// Scenario 5 — an approval nobody answers times out and settles correctly.
//
// Extends the proof `scripts/e2e-approval-data-plane.ts` already established
// (waitForApproval's timeout path returns control near `timeoutMs`, not
// never) with the one thing that script's own timeout probe did not actually
// check: that the REAL approvals row created for the request is left in
// `status = 'timeout'`, not still 'pending' forever — R3.6's whole point.
async function scenarioApprovalTimeout(): Promise<void> {
  console.log('\n--- Scenario 5: an unanswered approval times out and settles ---')
  const { createPendingApproval, waitForApproval } = await import('../lib/hermes/approval-helpers')
  const accountableUser = await requireAnyUserId()
  const externalId = `chaos-timeout-${Date.now()}`
  cleanupApprovalExternalIds.push(externalId)

  const rowId = await createPendingApproval({
    runId: 999_999_001, // no FK on approvals.run_id — an obviously-fake id is fine
    externalId,
    requestedUserId: accountableUser,
    title: 'chaos test — deliberately never answered',
    detail: 'This approval is left unanswered on purpose to prove the timeout path.',
    options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow once' }],
  })

  const start = Date.now()
  const outcome = await waitForApproval(externalId, 1_500)
  const elapsedMs = Date.now() - start

  check('the outcome is cancelled/timeout, not a hang', outcome.outcome === 'cancelled' && (outcome as { reason?: string }).reason === 'timeout', outcome)
  check(`it took roughly the configured timeout (~1500ms), elapsed=${elapsedMs}ms`, elapsedMs >= 1_400 && elapsedMs < 5_000, elapsedMs)

  const { rows } = await pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [rowId])
  check('the REAL approvals row was updated to status=timeout, not left pending', rows[0]?.status === 'timeout', rows[0]?.status)
}

async function main() {
  const accountableUser = await requireAnyUserId()
  try {
    await scenarioLeaseRecovery(accountableUser)
    await scenarioCancellationNotRetried(accountableUser)
    await scenarioConcurrencyCeiling()
    await scenarioPoolExhaustion()
    await scenarioApprovalTimeout()
  } finally {
    if (cleanupRunIds.length > 0) {
      await pool.query('DELETE FROM runs WHERE id = ANY($1::int[])', [cleanupRunIds])
    }
    if (cleanupApprovalExternalIds.length > 0) {
      await pool.query('DELETE FROM approvals WHERE external_id = ANY($1::text[])', [cleanupApprovalExternalIds])
    }
    await closeBrokerPool()
  }

  console.log('')
  console.log(failures === 0 ? 'ALL CHAOS SCENARIOS PASSED' : `${failures} CHAOS CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

// `getPayloadClient()` (scenario 5) caches a live pg Pool on `globalThis` for
// the app's whole lifetime by design (`lib/payload.ts`) — correct for a
// server, but it means this PROCESS never exits on its own once that client
// has been created. `scripts/e2e-approval-data-plane.ts` hits the same thing
// and works around it the same way: an explicit `process.exit` rather than
// waiting for Node to notice there is nothing left to do.
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('[chaos-dispatcher] FATAL:', err)
    process.exit(1)
  })
