// R3.3 — answer "is the dispatcher actually running?" from a terminal.
//
// The same reading the Health page shows, without needing a browser. Useful
// precisely when something is wrong and you want one fact, fast.
//
//   npx tsx scripts/dispatcher-status.ts
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getDispatcherHealth } = await import('../lib/broker/dispatcher-health')
const { closeBrokerPool } = await import('../lib/broker/db')

try {
  const health = await getDispatcherHealth()
  console.log(`state:       ${health.stale ? 'NOT RUNNING' : 'running'}`)
  console.log(`last tick:   ${health.lastTickAt ? health.lastTickAt.toISOString() : 'never'}`)
  console.log(
    `age:         ${health.sinceLastTickMs === null ? 'n/a' : `${(health.sinceLastTickMs / 1000).toFixed(1)}s`}`,
  )
  console.log(`worker:      ${health.lastWorkerId ?? 'n/a'}`)
  console.log(`queued runs: ${health.queueDepth}`)
  if (health.stalled) {
    console.log('')
    console.log('STALLED — runs are waiting and nothing is picking them up.')
    console.log('Start it with: npx tsx scripts/run-dispatcher-loop.ts')
  }
} finally {
  await closeBrokerPool()
}
