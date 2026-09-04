// R12-P5.2 — the orphan reaper, proven against a real bare clone.
//
// A worker can die between `RunWorktreeManager.create()` cutting a run's
// branch and the run ever settling, leaving `agent/run/<id>` behind forever.
// This asserts `reapOrphanedWorktrees` actually removes the ones with no
// matching "live" id and leaves the others alone — not just "it ran with no
// error".
//
//   npx tsx scripts/test-orphan-reaper.ts
//
// P5.3 — `RunWorktreeManager` and `reapOrphanedWorktrees` both take a
// Postgres advisory lock now, so — same as `scripts/test-run-worktrees.ts`
// — env has to load before `../lib/run-worktrees/manager` is imported.
import nextEnv from '@next/env'
nextEnv.loadEnvConfig(process.cwd())

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const { RunWorktreeManager, reapOrphanedWorktrees, barePathFor } = await import('../lib/run-worktrees/manager')
const { closeBrokerPool } = await import('../lib/broker/db')

const exec = promisify(execFile)

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function branchNames(barePath: string): Promise<string[]> {
  const { stdout } = await exec('git', ['--git-dir', barePath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/agent/run'], {
    windowsHide: true,
  })
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

async function main() {
  const source = await mkdtemp(join(tmpdir(), 'notionforge-reaper-source-'))
  const rootDir = await mkdtemp(join(tmpdir(), 'notionforge-reaper-state-'))
  const run = async (args: string[], cwd = source) => exec('git', args, { cwd, windowsHide: true })
  await run(['init', '-b', 'main'])
  await run(['config', 'user.email', 'test@example.invalid'])
  await run(['config', 'user.name', 'reaper test'])
  await writeFile(join(source, 'seed.txt'), 'seed\n')
  await run(['add', '.'])
  await run(['commit', '-m', 'seed'])

  const manager = new RunWorktreeManager({ rootDir })
  const barePath = barePathFor(rootDir, source)

  await manager.create(source, 'run-101')
  await manager.create(source, 'run-102')
  await manager.create(source, 'run-103')

  const before = await branchNames(barePath)
  assert(
    ['agent/run/run-101', 'agent/run/run-102', 'agent/run/run-103'].every((b) => before.includes(b)),
    `expected all three run branches before reaping, got: ${before.join(', ')}`,
  )

  // Only run-101 and run-103 are "live" (have a matching `runs` row, in the
  // real dispatcher) — run-102's branch is an orphan and must go.
  const report = await reapOrphanedWorktrees(barePath, new Set(['run-101', 'run-103']))
  assert(report.removedBranches.includes('agent/run/run-102'), `expected run-102's branch reaped, got: ${JSON.stringify(report)}`)
  assert(report.removedWorktrees.length === 1, `expected run-102's still-checked-out worktree force-removed too, got: ${JSON.stringify(report.removedWorktrees)}`)
  assert(report.failures.length === 0, `expected no failures, got: ${JSON.stringify(report.failures)}`)

  const after = await branchNames(barePath)
  assert(!after.includes('agent/run/run-102'), 'run-102 branch should be gone after reaping')
  assert(after.includes('agent/run/run-101'), 'run-101 branch (live) must survive reaping')
  assert(after.includes('agent/run/run-103'), 'run-103 branch (live) must survive reaping')

  // Idempotent: reaping again with the same live set removes nothing more and
  // reports no failures — a boot-time reaper that runs every process start
  // must not error out on the second (or hundredth) run against the same clone.
  const second = await reapOrphanedWorktrees(barePath, new Set(['run-101', 'run-103']))
  assert(second.removedBranches.length === 0, `second reap pass should find nothing left to remove, got: ${second.removedBranches.join(', ')}`)

  // A bare path with no clone at all is a no-op, not an error — this runs on
  // every dispatcher boot and a project with no worktrees yet must not throw.
  const emptyReport = await reapOrphanedWorktrees(join(rootDir, 'never-cloned.git'), new Set())
  assert(emptyReport.removedBranches.length === 0 && emptyReport.failures.length === 0, 'a missing bare clone must be a quiet no-op')

  console.log('Orphan reaper test passed:', { removed: report.removedBranches })
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => closeBrokerPool())
