import { performance } from 'node:perf_hooks'
import { mergeRunEvents } from '../components/runs/use-run-event-stream'
import type { RunMessageRow } from '../lib/broker/types'

const runs = Number(process.argv[2] ?? 8)
const eventsPerRun = Number(process.argv[3] ?? 1000)
const budgetMs = Number(process.argv[4] ?? 16)
const start = performance.now()
let merged = 0
for (let run = 0; run < runs; run++) {
  const initial: RunMessageRow[] = []
  const batch: RunMessageRow[] = []
  for (let seq = 1; seq <= eventsPerRun; seq++) batch.push({ seq, event: { type: 'message', role: 'assistant', text: `run-${run}-${seq}` }, createdAt: new Date().toISOString() })
  // Deliberately reverse delivery order to prove sequence ordering is retained.
  const result = mergeRunEvents(initial, batch.reverse())
  if (result[0]?.seq !== 1 || result.at(-1)?.seq !== eventsPerRun) throw new Error('Run events were not merged in seq order')
  merged += result.length
}
const elapsed = performance.now() - start
if (merged !== runs * eventsPerRun) throw new Error(`Expected ${runs * eventsPerRun} events, got ${merged}`)
console.log(`render stream benchmark: ${runs} runs × ${eventsPerRun} events = ${merged} merged in ${elapsed.toFixed(2)}ms (budget ${budgetMs}ms)`)
if (elapsed > budgetMs) process.exitCode = 1
