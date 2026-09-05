// P5.4 library-level data-plane proof.
//
// NOT a live end-to-end with a real Hermes-ACP child process — port 3000
// was unavailable when the lead assigned this. Instead, this script
// imports the same `buildPermissionCallback` machinery that worker.ts uses
// in production and exercises:
//   (1) the createPendingApproval -> row-in-Postgres -> listPendingApprovals
//       wiring (proves the row actually lands and is queryable)
//   (2) the waitForApproval <-> resolveApproval in-process Map wiring
//       (proves the dispatcher/worker side and the route side resolve each
//       other across the awaited Promise even though they're separate
//       callers in different call frames)
//   (3) the waitForApproval timeout path (proves it returns control
//       ~immediately after permissionTimeoutMs with a cancelled/timeout
//       outcome rather than hanging)
//
// Per AGENTS.md, a script that imports getPayloadClient() against the
// shared DB is allowed because the 20260902_090000_approvals migration is
// confirmed identical between migrations/ and the previously live-applied
// SQL — verified in the prior audit (task 01a060ba). The script also
// prints `agents.permission_mode` and `payload_migrations` batch before/after
// to make any drift obvious.

import nextEnv from '@next/env'
import type { Pool as PoolType } from 'pg'

// nextEnv.loadEnvConfig must run BEFORE any module that reads process.env
// at import time (e.g. payload.config.ts -> PAYLOAD_SECRET). We achieve
// that with top-level await + dynamic import — TypeScript ESM dynamic
// imports can return typed modules while still being lazy. The type-only
// import above has zero runtime effect (erased at compile time), so it
// doesn't violate that ordering.
nextEnv.loadEnvConfig(process.cwd())
if (!process.env.DATABASE_URI) throw new Error('DATABASE_URI unset — .env.local not loaded')
if (!process.env.PAYLOAD_SECRET) throw new Error('PAYLOAD_SECRET unset — .env.local not loaded')

const { Pool } = await import('pg')
const { getPayloadClient } = await import('@/lib/payload')
const approvalHelpers = await import('@/lib/hermes/approval-helpers')
const acpTypes = await import('@/lib/acp/client')

const { createPendingApproval, waitForApproval, resolveApproval, listPendingApprovalsForUser } = approvalHelpers
type ApprovalOutcome = import('@/lib/acp/client').ApprovalOutcome

const TS = Date.now()
const FAKE_RUN_ID = 999_999 // ad-hoc; approvals.run_id has no FK
const REQUEST_USER = 1 // payload users id=1 (the seeded hrithikroushan row)
const EXTERNAL_HAPPY = `e2e-happy-${TS}`
const EXTERNAL_TO = `e2e-timeout-${TS}`

async function dumpSchemaState(pool: PoolType, label: string) {
  const drift = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_schema='public' AND table_name='approvals'`
  )).rows[0].n
  const batch = (await pool.query(
    `SELECT MAX(batch)::int AS batch FROM payload_migrations`
  )).rows[0].batch
  const opt = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_schema='public' AND table_name='approvals' AND column_name='options'`
  )).rows[0].n
  console.log(`  [${label}] approvals cols=${drift} options_col=${opt} payloads_max_batch=${batch}`)
}

async function cleanup(pool: PoolType, externalIds: string[]) {
  if (!externalIds.length) return
  const ids = externalIds.map(e => `'${e}'`).join(', ')
  const r = await pool.query(
    `DELETE FROM approvals WHERE external_id IN (${ids})`
  )
  console.log(`  cleanup deleted ${r.rowCount} row(s) for external_ids=${ids}`)
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 2 })
  try {
    console.log('--- 0. schema state before')
    await dumpSchemaState(pool, 'before')
    const agentBefore = (await pool.query(
      `SELECT id, permission_mode FROM agents WHERE id=2`
    )).rows[0]
    console.log(`  agent(2).permission_mode = ${agentBefore?.permission_mode}`)

    // Force Payload client init. If migrations were drifted, this would
    // log a "schema drift detected" prompt before we got here. Watch for it.
    console.log('\n--- 1. initialising Payload client')
    const payload = await getPayloadClient()
    console.log('  payload client ready')

    // ============== Probe 1: happy path ==============
    console.log('\n--- 2. PROBE 1: createPendingApproval + listPendingApprovalsForUser')
    const rowId = await createPendingApproval({
      runId: FAKE_RUN_ID,
      externalId: EXTERNAL_HAPPY,
      requestedUserId: REQUEST_USER,
      title: 'Run a shell command',
      detail: 'E2E proof — please ignore',
      options: [
        { optionId: 'allow', kind: 'allow_once', label: 'Allow once' },
        { optionId: 'deny', kind: 'deny_once', label: 'Deny' },
      ],
    })
    console.log(`  createPendingApproval returned rowId=${rowId}`)
    const pending = await listPendingApprovalsForUser(REQUEST_USER)
    const found = pending.find(p => p.externalId === EXTERNAL_HAPPY)
    if (!found) throw new Error(`listPendingApprovalsForUser(${REQUEST_USER}) did not include rowId=${rowId}`)
    console.log(`  listPendingApprovalsForUser returned the row: id=${found.id} status=${found.status} title="${found.title}"`)

    console.log('\n--- 3. PROBE 1 (cont): waitForApproval <-> resolveApproval race')
    // Start waitForApproval BEFORE calling resolveApproval so the Map entry
    // is registered before resolveApproval looks it up. waitForApproval's
    // own check at lines 47-50 of approval-helpers.ts would throw
    // 'Approval waiter for <id> already exists' if I called it twice for
    // the same id, so I keep it single-shot.
    const t0 = Date.now()
    const waiter = waitForApproval(EXTERNAL_HAPPY, 30_000)
    // Let the Map registration land (microtask + setImmediate).
    await new Promise(r => setTimeout(r, 25))
    await resolveApproval(rowId, { approved: true, selectedOptionId: 'allow' })
    const outcome: ApprovalOutcome = await waiter
    const tWait = Date.now() - t0
    console.log(`  outcome=${JSON.stringify(outcome)} resolved_in=${tWait}ms`)
    if (outcome.outcome !== 'selected' || outcome.optionId !== 'allow') {
      throw new Error(`expected {outcome:'selected', optionId:'allow'}, got ${JSON.stringify(outcome)}`)
    }

    console.log('\n--- 4. PROBE 1 (cont): DB state after resolve')
    const finalRow = (await pool.query(
      `SELECT id, status, selected_option_id, updated_at FROM approvals WHERE id=$1`,
      [rowId]
    )).rows[0]
    console.log(`  approvals row ${rowId}: ${JSON.stringify(finalRow)}`)
    if (finalRow.status !== 'approved') throw new Error(`expected status=approved, got ${finalRow.status}`)
    if (finalRow.selected_option_id !== 'allow') throw new Error(`expected selected_option_id=allow, got ${finalRow.selected_option_id}`)

    // ============== Probe 2: timeout path ==============
    console.log('\n--- 5. PROBE 2: waitForApproval timeout (no concurrent resolve)')
    // We have to first create a stub row so the data plane tests a realistic
    // round-trip — though waitForApproval itself only depends on the Map.
    // Either way, we run it on a fresh externalId that no resolver will
    // touch, with a short timeout so the test finishes quickly.
    const t1 = Date.now()
    const toOutcome = await waitForApproval(EXTERNAL_TO, 2000)
    const tTook = Date.now() - t1
    console.log(`  timeout outcome=${JSON.stringify(toOutcome)} elapsed=${tTook}ms`)
    if (toOutcome.outcome !== 'cancelled' || toOutcome.reason !== 'timeout') {
      throw new Error(`expected {outcome:'cancelled', reason:'timeout'}, got ${JSON.stringify(toOutcome)}`)
    }
    if (tTook < 1800 || tTook > 4000) {
      throw new Error(`timeout took ${tTook}ms; expected ~2000ms`)
    }

    // ============== Probe 3: listPendingApprovalsForUser excludes the resolved row ==============
    console.log('\n--- 6. PROBE 3: listPendingApprovalsForUser excludes resolved row')
    const pending2 = await listPendingApprovalsForUser(REQUEST_USER)
    const stillThere = pending2.find(p => p.externalId === EXTERNAL_HAPPY)
    console.log(`  remaining pending for user(1): ${pending2.length}, our row still in list=${!!stillThere}`)
    if (stillThere) throw new Error('resolved row still appears in pending list')

    // ============== Cleanup ==============
    console.log('\n--- 7. cleanup test rows (insert a transient stub so the delete covers EXTERNAL_TO path too)')
    await pool.query(
      `INSERT INTO approvals (external_id, run_id, requested_user_id, title, detail, options, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'timeout stub', '', '[]'::jsonb, 'timeout', NOW(), NOW())`,
      [EXTERNAL_TO, FAKE_RUN_ID, REQUEST_USER]
    )
    await cleanup(pool, [EXTERNAL_HAPPY, EXTERNAL_TO])

    console.log('\n--- 8. schema state after (drift / agent state unchanged)')
    await dumpSchemaState(pool, 'after')
    const agentAfter = (await pool.query(
      `SELECT id, permission_mode FROM agents WHERE id=2`
    )).rows[0]
    console.log(`  agent(2).permission_mode = ${agentAfter?.permission_mode} (was ${agentBefore?.permission_mode})`)
    if (agentAfter?.permission_mode !== agentBefore?.permission_mode) {
      throw new Error('agent fixture was mutated')
    }

    console.log('\n=== data-plane proof PASSED ===')
  } finally {
    await pool.end()
  }
}

main().then(() => process.exit(0)).catch(err => { console.error('FATAL:', err); process.exit(1) })
