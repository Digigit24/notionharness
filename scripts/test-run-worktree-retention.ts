// R12-P5.2 — a real test of `reclaimRunWorktrees`'s disk budget against the
// real broker database and the real filesystem, matching the bar
// `scripts/test-run-worktrees.ts` sets: assert on real rows and real bytes,
// not just "no error was thrown".
//
//   npx tsx scripts/test-run-worktree-retention.ts
import nextEnv from '@next/env'
nextEnv.loadEnvConfig(process.cwd())

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const { RunWorktreeManager } = await import('../lib/run-worktrees/manager')
const { reclaimRunWorktrees } = await import('../lib/run-worktrees/retention')
const { getBrokerPool, closeBrokerPool } = await import('../lib/broker/db')

const exec = promisify(execFile)
const pool = getBrokerPool()

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function main() {
  const { rows: userRows } = await pool.query<{ id: number }>('SELECT id FROM users LIMIT 1')
  assert(userRows[0], 'this database has no users row to attribute test runs to')
  const accountableUser = userRows[0].id

  const source = await mkdtemp(join(tmpdir(), 'notionforge-retention-source-'))
  const rootDir = await mkdtemp(join(tmpdir(), 'notionforge-retention-state-'))
  const run = async (args: string[], cwd = source) => exec('git', args, { cwd, windowsHide: true })
  await run(['init', '-b', 'main'])
  await run(['config', 'user.email', 'test@example.invalid'])
  await run(['config', 'user.name', 'retention test'])
  await writeFile(join(source, 'seed.txt'), 'seed\n')
  await run(['add', '.'])
  await run(['commit', '-m', 'seed'])

  const manager = new RunWorktreeManager({ rootDir })
  const insertedIds: number[] = []

  async function insertRun(status: string, extra: { reviewOpen?: boolean } = {}): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO runs (status, accountable_user, page_subtree_block_id, suggestion_status, dismissed_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        status,
        accountableUser,
        extra.reviewOpen ? 'blk-test' : null,
        extra.reviewOpen ? 'pending' : 'accepted',
        extra.reviewOpen ? null : new Date(),
      ],
    )
    const id = rows[0].id
    insertedIds.push(id)
    return id
  }

  async function makeWorktree(id: number, payloadBytes: number): Promise<void> {
    const worktree = await manager.create(source, String(id))
    if (payloadBytes > 0) {
      await writeFile(join(worktree.worktreePath, 'payload.bin'), Buffer.alloc(payloadBytes, 'x'))
    }
  }

  try {
    // --- Scenario 1: keepLast alone, no budget ---------------------------
    const unfinishedId = await insertRun('running')
    const reviewId = await insertRun('completed', { reviewOpen: true })
    const oldIds: number[] = []
    for (let i = 0; i < 4; i += 1) oldIds.push(await insertRun('completed'))

    await makeWorktree(unfinishedId, 100)
    await makeWorktree(reviewId, 100)
    for (const id of oldIds) await makeWorktree(id, 100)

    const first = await reclaimRunWorktrees({ source, rootDir, keepLast: 2, dryRun: false })
    assert(first.examined === 6, `expected 6 checkouts examined, got ${first.examined}`)

    const keptReasons = new Map(first.kept.map((k) => [k.runId, k.reason]))
    assert(keptReasons.get(String(unfinishedId)) === 'unfinished', 'the running run must be kept as unfinished')
    assert(keptReasons.get(String(reviewId)) === 'open-review', 'the open-review run must be kept as open-review')
    // oldIds[2] and oldIds[3] are the two most recent settled+closed runs.
    assert(keptReasons.get(String(oldIds[2])) === 'recent', `${oldIds[2]} should be kept as recent`)
    assert(keptReasons.get(String(oldIds[3])) === 'recent', `${oldIds[3]} should be kept as recent`)
    assert(
      first.removed.includes(String(oldIds[0])) && first.removed.includes(String(oldIds[1])),
      `the two oldest settled runs should have been removed, got: ${first.removed.join(', ')}`,
    )
    assert(first.removed.length === 2, `expected exactly 2 removed, got ${first.removed.length}: ${first.removed.join(', ')}`)
    assert(first.budgetEvicted.length === 0, 'no budget was set — nothing should be attributed to it')
    console.log('scenario 1 (keepLast, no budget) passed:', {
      examined: first.examined,
      removed: first.removed,
      kept: first.kept,
    })

    // --- Scenario 2: the disk budget forces eviction of the OLDER "recent" ---
    // oldIds[2] and oldIds[3] are still on disk (kept above), ~100 bytes each
    // plus the tiny seed file and `.git` pointer. Rewrite them to a known,
    // dominant size so the budget math is unambiguous.
    const bigBytes = 300_000
    await writeFile(join(rootDir, 'runs', String(oldIds[2]), 'payload.bin'), Buffer.alloc(bigBytes, 'y'))
    await writeFile(join(rootDir, 'runs', String(oldIds[3]), 'payload.bin'), Buffer.alloc(bigBytes, 'y'))

    // A budget that fits ONE ~300KB checkout comfortably but not two: the
    // older of the two (oldIds[2]) must be the one evicted — newer survives.
    const second = await reclaimRunWorktrees({
      source,
      rootDir,
      keepLast: 2,
      maxTotalBytes: bigBytes * 1.5,
      dryRun: false,
    })
    assert(
      second.budgetEvicted.includes(String(oldIds[2])) && !second.budgetEvicted.includes(String(oldIds[3])),
      `expected the OLDER recent run (${oldIds[2]}) evicted by budget and the newer (${oldIds[3]}) kept, got budgetEvicted=${second.budgetEvicted.join(', ')}`,
    )
    const keptReasons2 = new Map(second.kept.map((k) => [k.runId, k.reason]))
    assert(keptReasons2.get(String(oldIds[3])) === 'recent', `${oldIds[3]} should still be kept as recent under budget`)
    assert(keptReasons2.get(String(unfinishedId)) === 'unfinished', 'budget must never touch an unfinished run')
    assert(keptReasons2.get(String(reviewId)) === 'open-review', 'budget must never touch an open-review run')
    assert(second.keptBytes < bigBytes * 1.5, `keptBytes (${second.keptBytes}) should be under the budget after eviction`)
    console.log('scenario 2 (disk budget) passed:', {
      budgetEvicted: second.budgetEvicted,
      keptBytes: second.keptBytes,
      kept: second.kept,
    })

    console.log('Run-worktree retention (keepLast + disk budget) test passed')
  } finally {
    await pool.query('DELETE FROM runs WHERE id = ANY($1::int[])', [insertedIds])
    await closeBrokerPool()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
