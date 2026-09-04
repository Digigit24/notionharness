// R3.4 — run the worktree retention pass by hand, and see what it would do.
//
//   npx tsx scripts/reclaim-worktrees.ts            # dry run, changes nothing
//   npx tsx scripts/reclaim-worktrees.ts --apply    # actually reclaim
//   npx tsx scripts/reclaim-worktrees.ts --apply --keep-last 5
//
// Dry run is the default on purpose: the whole point of a retention policy is
// that you can check what it considers expendable before it acts.
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { reclaimRunWorktrees } = await import('../lib/run-worktrees/retention')
const { resolveRunWorktreeConfig } = await import('../lib/run-worktrees/config')
const { closeBrokerPool } = await import('../lib/broker/db')

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const apply = process.argv.includes('--apply')
  const keepLastRaw = flagValue('--keep-last')
  const keepLast = keepLastRaw ? Number(keepLastRaw) : undefined
  const { source, rootDir } = resolveRunWorktreeConfig()

  console.log(`source:  ${source}`)
  console.log(`root:    ${rootDir}`)
  console.log(`mode:    ${apply ? 'APPLY' : 'dry run (pass --apply to act)'}`)
  if (keepLast !== undefined) console.log(`keep:    last ${keepLast} settled runs`)
  console.log('')

  const report = await reclaimRunWorktrees({ source, rootDir, keepLast, dryRun: !apply })

  const byReason = new Map<string, number>()
  for (const kept of report.kept) byReason.set(kept.reason, (byReason.get(kept.reason) ?? 0) + 1)

  console.log(`examined:  ${report.examined} checkouts`)
  console.log(`${apply ? 'removed' : 'would remove'}:   ${report.removed.length} (${(report.reclaimedBytes / 1024 / 1024).toFixed(1)} MB)`)
  console.log(`kept:      ${report.kept.length}`)
  for (const [reason, count] of byReason) console.log(`             ${count} — ${reason}`)
  if (report.removed.length > 0) console.log(`run ids:   ${report.removed.join(', ')}`)
  for (const failure of report.failures) console.log(`FAILED ${failure.runId}: ${failure.error}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => closeBrokerPool())
