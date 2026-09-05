// R3.3 / B9.1 — answer "is the dispatcher actually running?" from a terminal.
//
// The same reading the Health page shows, without needing a browser. Useful
// precisely when something is wrong and you want one fact, fast.
//
//   npx tsx scripts/dispatcher-status.ts          this machine only
//   npx tsx scripts/dispatcher-status.ts --all     every machine that has ever ticked
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getDispatcherHealth, listDispatcherHeartbeats } = await import('../lib/broker/dispatcher-health')
const { closeBrokerPool } = await import('../lib/broker/db')
const { currentHostId } = await import('../lib/runtimes/host-id')

try {
  if (process.argv.includes('--all')) {
    const heartbeats = await listDispatcherHeartbeats()
    if (heartbeats.length === 0) {
      console.log('No machine has ever ticked on this database.')
    } else {
      for (const beat of heartbeats.sort((a, b) => a.hostId.localeCompare(b.hostId))) {
        console.log(
          `${beat.hostId.padEnd(24)} ${beat.stale ? 'NOT RUNNING' : 'running'.padEnd(11)} last tick ${beat.lastTickAt.toISOString()} (${(beat.sinceLastTickMs / 1000).toFixed(1)}s ago)`,
        )
      }
    }
  } else {
    const hostId = currentHostId()
    const health = await getDispatcherHealth(hostId)
    console.log(`machine:     ${hostId}`)
    console.log(`state:       ${health.stale ? 'NOT RUNNING' : 'running'}`)
    console.log(`last tick:   ${health.lastTickAt ? health.lastTickAt.toISOString() : 'never'}`)
    console.log(
      `age:         ${health.sinceLastTickMs === null ? 'n/a' : `${(health.sinceLastTickMs / 1000).toFixed(1)}s`}`,
    )
    console.log(`worker:      ${health.lastWorkerId ?? 'n/a'}`)
    console.log(`queued runs: ${health.queueDepth} (workspace-wide, not just this machine's)`)
    if (health.stalled) {
      console.log('')
      console.log('STALLED on this machine — runs are waiting workspace-wide; check --all to see if another')
      console.log('machine is already handling them before assuming nothing is.')
      console.log('Start it with: npx tsx scripts/run-dispatcher-loop.ts')
    }
  }
} finally {
  await closeBrokerPool()
}
