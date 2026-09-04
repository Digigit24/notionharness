// R3.7 — measure before changing.
//
// The roadmap's question is whether the transcript needs a real virtualiser
// beyond the current hundred-message tail. That is a question about numbers,
// and the number that matters is not "how fast does one event parse" but
// "how long does the whole adapt-and-render path take on the Nth event of a
// long turn" — because `adaptRunEventsToThread` runs over the FULL envelope
// list every time a single new event arrives. If that is O(n) per event, a
// long turn is quadratic and the cost shows up exactly when a user is
// watching a big refactor stream.
//
// 16ms is one frame at 60Hz. Anything at or under it is invisible; anything
// meaningfully over it drops frames while the agent is still typing.
//
//   npx tsx scripts/test-streaming-latency.ts [events] [budgetMs]
import { performance } from 'node:perf_hooks'

import { adaptRunEventsToThread } from '../lib/hermes/runEvent-adapter'
import type { RunEvent } from '../lib/run-events'

const TOTAL = Number(process.argv[2] ?? 4000)
const BUDGET_MS = Number(process.argv[3] ?? 16)

// A turn shaped like a real one: mostly streamed text, punctuated by tool
// calls, terminal output and their results. A benchmark of 4000 identical
// message chunks would flatter the adapter by never exercising its branches.
function syntheticEvent(seq: number): RunEvent {
  const phase = seq % 40
  if (phase === 0) return { type: 'thought', text: 'Considering the next step in the refactor.' }
  if (phase === 1)
    return { type: 'tool_call', id: `call-${seq}`, name: 'Read file', input: { path: 'src/index.ts' }, kind: 'read', status: 'in_progress' }
  if (phase === 2) return { type: 'terminal', id: `term-${seq - 1}`, chunk: 'npm run build\n' }
  if (phase === 3) return { type: 'terminal_exit', id: `term-${seq - 2}`, exitCode: 0, signal: null }
  if (phase === 4) return { type: 'tool_result', id: `call-${seq - 3}`, output: 'ok', isError: false }
  return { type: 'message', role: 'assistant', text: 'The function signature changes slightly here. ' }
}

const base = Date.now()
const envelopes = Array.from({ length: TOTAL }, (_, index) => ({
  runId: '1',
  seq: index + 1,
  event: syntheticEvent(index + 1),
  at: new Date(base + index * 25).toISOString(),
}))

// Warm the JIT so the first sample is not measuring compilation.
adaptRunEventsToThread(envelopes.slice(0, 200))

// The honest measurement: adapt the transcript as it looked at each of a
// series of growing prefixes, which is what actually happens as events stream.
const checkpoints = [100, 250, 500, 1000, 2000, TOTAL].filter((n) => n <= TOTAL)
const samples: Array<{ size: number; ms: number }> = []
for (const size of checkpoints) {
  const prefix = envelopes.slice(0, size)
  const started = performance.now()
  const iterations = 20
  for (let i = 0; i < iterations; i++) adaptRunEventsToThread(prefix)
  samples.push({ size, ms: (performance.now() - started) / iterations })
}

console.log('adapt cost by transcript length (one full adapt = one arriving event)')
console.log('')
console.log('  events    per-adapt    verdict')
for (const sample of samples) {
  const verdict = sample.ms <= BUDGET_MS ? 'within one frame' : 'OVER FRAME BUDGET'
  console.log(`  ${String(sample.size).padStart(6)}    ${sample.ms.toFixed(2).padStart(7)}ms    ${verdict}`)
}

// Cost of streaming a whole turn: every event re-adapts everything before it.
const worst = samples[samples.length - 1]
const first = samples[0]
const growth = worst.ms / Math.max(first.ms, 0.0001)
const sizeGrowth = worst.size / first.size
console.log('')
console.log(`transcript grew ${sizeGrowth.toFixed(0)}x, adapt cost grew ${growth.toFixed(1)}x`)
console.log(
  growth > sizeGrowth * 1.5
    ? 'SUPERLINEAR — the adapter itself is the problem, not the DOM. Fix that before virtualising.'
    : 'Linear or better — cost tracks transcript size, as expected.',
)
console.log('')
console.log(
  worst.ms <= BUDGET_MS
    ? `VERDICT: a ${TOTAL}-event turn adapts in ${worst.ms.toFixed(2)}ms, inside the ${BUDGET_MS}ms frame budget. A virtualiser would add measurement thrash to solve a problem the numbers do not show.`
    : `VERDICT: ${worst.ms.toFixed(2)}ms at ${TOTAL} events exceeds the ${BUDGET_MS}ms budget. Virtualising is justified.`,
)
process.exit(worst.ms <= BUDGET_MS ? 0 : 1)
