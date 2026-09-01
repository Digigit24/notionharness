// ROADMAP Pillar 4/6.1 — `lib/dispatcher/worker.ts`'s `dispatchNextRun` exists
// and is verified against the real hermes-acp binary, but nothing calls it:
// a task assignment enqueues a broker run that then sits 'queued' forever
// without something polling `claimNextRun`. A dedicated daemon process is
// the real Pillar 4.1 destination for this; this script is the minimal
// stand-in for that stage, run as its own process alongside `npm run dev`
// (deliberately NOT embedded in instrumentation.ts — that bundles through
// Next's webpack pipeline, including an edge-runtime pass that cannot
// resolve Payload's Node-only dependencies like `busboy`, regardless of a
// `NEXT_RUNTIME` runtime guard, and destabilized the whole dev server).
//
// Usage: npx tsx scripts/run-dispatcher-loop.ts
import { dispatchNextRun } from '../lib/dispatcher/worker'

const POLL_MS = 3000
const workerId = `local-${process.pid}`
let stopping = false

process.on('SIGINT', () => {
  stopping = true
})
process.on('SIGTERM', () => {
  stopping = true
})

async function loop(): Promise<void> {
  console.log(`[dispatcher] polling loop started (worker ${workerId})`)
  while (!stopping) {
    try {
      const outcome = await dispatchNextRun(workerId)
      if (outcome.claimed) {
        console.log(`[dispatcher] run ${outcome.runId} -> ${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}`)
      }
    } catch (err) {
      console.error('[dispatcher] loop error', err)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  console.log('[dispatcher] stopped')
}

loop().catch((err) => {
  console.error('[dispatcher] fatal', err)
  process.exitCode = 1
})
