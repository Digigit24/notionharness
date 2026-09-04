// R12-P5.3 — proving the advisory lock actually serializes concurrent
// callers, not just that both eventually succeed.
//
// `RunWorktreeManager`'s own in-process `locks` Map would already serialize
// two calls made from the SAME process regardless of whether the Postgres
// lock did anything at all — so a test that only calls `manager.create()`
// twice from one process could pass for the wrong reason. This calls the
// lower-level `withRepoLock` directly, with each call checking out its OWN
// connection from the pool (exactly as two separate processes would, each
// with their own connection), which is the only way to actually exercise the
// cross-process guarantee P5.3 is about.
//
//   npx tsx scripts/test-repo-lock.ts
import nextEnv from '@next/env'
nextEnv.loadEnvConfig(process.cwd())

const { withRepoLock } = await import('../lib/run-worktrees/lock')
const { closeBrokerPool } = await import('../lib/broker/db')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const path = 'C:\\fake\\bare-clone-for-lock-test.git'

  // --- Non-interleaving proof ---------------------------------------------
  // If the lock does nothing, both callers enter the critical section at
  // roughly the same time and one will observe `active === true` on entry.
  // If the lock works, the second caller cannot even start its critical
  // section until the first has fully finished (including its own unlock).
  let active = false
  let interleaved = false
  const order: string[] = []

  async function criticalSection(name: string): Promise<void> {
    await withRepoLock(path, async () => {
      if (active) interleaved = true
      active = true
      order.push(`${name}:enter`)
      await sleep(150)
      order.push(`${name}:exit`)
      active = false
    })
  }

  const start = Date.now()
  await Promise.all([criticalSection('A'), criticalSection('B')])
  const elapsedMs = Date.now() - start

  assert(!interleaved, 'the two callers observed the critical section as active simultaneously — the lock did not serialize them')
  assert(
    (order[0] === 'A:enter' && order[1] === 'A:exit' && order[2] === 'B:enter' && order[3] === 'B:exit') ||
      (order[0] === 'B:enter' && order[1] === 'B:exit' && order[2] === 'A:enter' && order[3] === 'A:exit'),
    `expected one caller to fully enter-and-exit before the other started, got: ${order.join(', ')}`,
  )
  // Serialized work takes at least both sleeps back to back; if it ran in
  // parallel this would be ~150ms instead of ~300ms. A generous floor (250ms)
  // avoids flaking on timer jitter while still failing if it ran concurrently.
  assert(elapsedMs >= 250, `two 150ms critical sections that were truly serialized should take >=250ms, took ${elapsedMs}ms`)
  console.log('lock serialization proof passed:', { order, elapsedMs })

  // --- Different paths do NOT contend with each other ---------------------
  // A lock keyed on the wrong thing (e.g. a constant) would also serialize
  // unrelated repositories, which would be a real performance bug hiding
  // behind a passing "it's serialized" test. Measured by actual wall-clock
  // overlap of the two critical sections' [enter, exit] intervals, not by
  // total elapsed time — `pool.connect()`'s own network latency to a shared,
  // remote Postgres instance is real and would make an elapsed-time-based
  // threshold flaky for the wrong reason.
  const otherPath = 'C:\\fake\\a-totally-different-bare-clone.git'
  const spans: Record<string, { enter: number; exit: number }> = {}
  async function otherCriticalSection(p: string, name: string): Promise<void> {
    await withRepoLock(p, async () => {
      spans[name] = { enter: Date.now(), exit: 0 }
      await sleep(150)
      spans[name].exit = Date.now()
    })
  }
  await Promise.all([otherCriticalSection(path, 'X'), otherCriticalSection(otherPath, 'Y')])
  const overlap = spans.X.enter < spans.Y.exit && spans.Y.enter < spans.X.exit
  assert(overlap, `two DIFFERENT repo paths should run their critical sections concurrently, but they did not overlap: ${JSON.stringify(spans)} — the lock key may not be path-specific`)
  console.log('lock key is path-specific (different repos ran concurrently):', spans)

  console.log('Repo advisory lock test passed')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => closeBrokerPool())
