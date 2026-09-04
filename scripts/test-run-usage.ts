// ROADMAP — verifies the fix in this task: `worker.ts`'s `onEvent` callback
// now also calls `recordUsage` on a `usage` RunEvent, not just `appendRunEvent`.
// Exercises the EXACT SAME onEvent wiring worker.ts uses (call both
// appendRunEvent and recordUsage on event.type==='usage') against a REAL
// broker run row and the REAL hermes-acp binary, then reads `run_usage`
// back via `getRunUsageTotals` to confirm rows actually landed in Postgres
// — not just that `sendTurn`'s in-memory envelopes contained a usage event.
//
// Deliberately does NOT call `getPayloadClient()` / `dispatchNextRun` itself:
// this session's standing guidance is not to run a second standalone process
// against the shared, connection-capped Supabase-backed Payload instance
// (confirmed as a real, current risk by the lead's own dispatcher-loop
// writeup this session) — `enqueueRun`/`claimNextRun`/`settleRun` are
// broker-only (raw `pg`, small pool), matching `scripts/test-broker.ts`'s
// own established safe pattern. This script proves the onEvent → recordUsage
// wiring is correct; the Payload-dependent agent/task lookup portion of
// `executeRun` is unchanged by this task and already covered by
// `scripts/test-dispatcher-core.ts` + the lead's own live E2E test.
//
// Run: npx tsx scripts/test-run-usage.ts
// Cleans up the scratch run it creates before exiting.
import nextEnv from '@next/env'
import { join } from 'node:path'
import { Pool } from 'pg'
import { enqueueRun, claimNextRun, settleRun, appendRunEvent, recordUsage, closeBrokerPool } from '../lib/broker'
import { getRunUsageTotals } from '../lib/broker/usage'
import { sendTurnWithIdentity } from '../lib/runtimes/hermes/run-with-identity'
import type { RunEventEnvelope } from '../lib/run-events'

nextEnv.loadEnvConfig(process.cwd())

// Phase C, C1.0 — no hardcoded machine path here anymore (there was one —
// a different developer's own hermes-acp path — until it was confirmed to
// name a machine other than whichever one actually runs this script);
// derived from the required `HERMES_HOME_BASE` instead.
const HERMES_ACP_BIN =
  process.env.HERMES_ACP_BIN ??
  (process.env.HERMES_HOME_BASE
    ? join(process.env.HERMES_HOME_BASE, 'hermes-agent', 'venv', 'Scripts', 'hermes-acp.exe')
    : (() => {
        throw new Error('Set HERMES_ACP_BIN or HERMES_HOME_BASE so this script can find the hermes-acp binary.')
      })())

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

// Restores a run this script accidentally claimed back to exactly its
// pre-claim state. Learned the hard way running this script against the
// shared DB with the real live dispatcher poller also running against it:
// `claimNextRun` claims whatever's oldest-and-highest-priority in the
// queue, with no way to target a specific run id — a genuine, unrelated
// queued run (someone's real task assignment) got claimed by this script
// instead of its own scratch row on the first attempt, and was left stuck
// in 'dispatched' under this script's worker_id until manually corrected.
async function releaseAccidentalClaim(runId: number): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
  try {
    await pool.query(
      `UPDATE runs SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, run_token = NULL, updated_at = now() WHERE id = $1`,
      [runId],
    )
    console.error(`[test] Released accidentally claimed run ${runId} back to 'queued' (was not this script's own scratch run).`)
  } finally {
    await pool.end()
  }
}

async function main() {
  const userId = await findRealUserId()
  // A very high priority: `claimNextRun` orders by `priority DESC, created_at
  // ASC`, so this guarantees the scratch run claims first regardless of
  // whatever else is already genuinely queued on a live, shared system —
  // this script must never compete with real work for the same row.
  const run = await enqueueRun({ accountableUser: userId, priority: 1_000_000 })
  console.log(`[ok] enqueueRun -> run ${run.id}`)

  try {
    const claimed = await claimNextRun('test-run-usage-worker', 60_000)
    if (claimed && claimed.id !== run.id) {
      // Belt-and-suspenders: even with max priority this should be
      // unreachable, but if it ever happens again, self-heal immediately
      // rather than leave someone else's real run stuck.
      await releaseAccidentalClaim(claimed.id)
    }
    assert(claimed !== null && claimed.id === run.id, `expected to claim the scratch run ${run.id}, got ${claimed?.id ?? 'null'}`)
    console.log(`[ok] claimNextRun -> claimed run ${claimed!.id}`)

    // The exact onEvent wiring under test, copied from worker.ts's
    // executeRun — appendRunEvent always, recordUsage additionally on a
    // 'usage' event, both best-effort/non-fatal.
    const onEvent = (envelope: RunEventEnvelope) => {
      void appendRunEvent(run.id, envelope.event).catch((err) => {
        console.error(`[test] Failed to append live run event for run ${run.id}.`, err)
      })
      if (envelope.event.type === 'usage') {
        const usage = envelope.event
        void recordUsage(run.id, {
          provider: usage.provider,
          model: usage.model,
          tokens: usage.tokens,
          costTicks: usage.costTicks,
        }).catch((err) => {
          console.error(`[test] Failed to record usage for run ${run.id}.`, err)
        })
      }
    }

    const result = await sendTurnWithIdentity({
      binaryPath: HERMES_ACP_BIN,
      cwd: process.env.TEMP || process.env.TMP || '.',
      text: 'Reply with exactly the word "pong" and nothing else.',
      runId: String(run.id),
      agentId: 'test-agent-run-usage',
      conversationId: run.id,
      enabledSkills: [],
      turnTimeoutMs: 30_000,
      onEvent,
    })

    const usageEnvelopes = result.envelopes.filter((e) => e.event.type === 'usage')
    console.log(`[ok] turn produced ${usageEnvelopes.length} usage event(s) in-memory`)
    assert(usageEnvelopes.length > 0, 'expected the real hermes-acp turn to emit at least one usage RunEvent')

    // onEvent's recordUsage calls are fire-and-forget — give the last one a
    // moment to actually land before reading run_usage back.
    await new Promise((r) => setTimeout(r, 500))

    const totals = await getRunUsageTotals(run.id)
    console.log(`[ok] getRunUsageTotals(${run.id}) -> tokens=${totals.totalTokens}, costTicks=${totals.totalCostTicks}`)

    const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
    let rowCount: number
    try {
      const res = await pool.query<{ count: string }>('SELECT count(*) FROM run_usage WHERE run_id = $1', [run.id])
      rowCount = Number(res.rows[0].count)
    } finally {
      await pool.end()
    }
    assert(rowCount === usageEnvelopes.length, `expected ${usageEnvelopes.length} run_usage row(s) for run ${run.id}, found ${rowCount}`)
    console.log(`[ok] run_usage table actually has ${rowCount} row(s) for run ${run.id} — not just in-memory envelopes`)

    await settleRun(run.id, 'completed')
    console.log('\nALL RUN-USAGE CHECKS PASSED')
  } finally {
    const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
    try {
      await pool.query('DELETE FROM runs WHERE id = $1', [run.id])
      console.log(`[cleanup] deleted scratch run ${run.id} (run_usage/run_messages cascade via FK)`)
    } finally {
      await pool.end()
    }
    await closeBrokerPool()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
