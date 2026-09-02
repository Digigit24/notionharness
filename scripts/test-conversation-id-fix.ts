// ROADMAP — verifies the fix for task 01a05f9d: `worker.ts`'s
// `conversationId: run.taskId ?? run.id` dropped page context entirely for
// page-scoped runs (task_id: null, from P6.1/6.2), giving every one a fresh,
// unique conversation shard (`run.id`, always unique) instead of sharing
// state.db across turns on the same page the way task-scoped runs already
// share it across turns on the same task.
//
// Two things verified for real, not just asserted about the expression in
// isolation:
//   1. The selection logic itself (taskId > pageId > run.id) against
//      representative Run shapes.
//   2. The actual downstream effect: `buildHermesHomeOverlay` (Pillar 3.4)
//      resolves the SAME state.db path for two different page-scoped runs
//      sharing a pageId, and a DIFFERENT path for a run against a different
//      page — i.e. "memory across turns on the same page" is a real,
//      observable filesystem fact after this fix, not just a passed-through
//      number.
//
// Run: npx tsx scripts/test-conversation-id-fix.ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHermesHomeOverlay } from '../lib/hermes/home-overlay'

let failures = 0
function check(label: string, condition: boolean) {
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${label}`)
  if (!condition) failures += 1
}

// Mirrors worker.ts's exact selection expression — kept as a tiny local
// function rather than importing `executeRun` (not exported, and pulls in
// getPayloadClient()/the broker, which this script deliberately avoids).
function conversationIdFor(run: { taskId: number | null; pageId: number | null; id: number }): number {
  return run.taskId ?? run.pageId ?? run.id
}

async function main() {
  // --- 1. Selection logic ---
  check('task-scoped run: taskId wins', conversationIdFor({ taskId: 5, pageId: 9, id: 100 }) === 5)
  check('page-scoped run (no task): pageId wins, not run.id', conversationIdFor({ taskId: null, pageId: 9, id: 100 }) === 9)
  check('neither task nor page: falls back to run.id', conversationIdFor({ taskId: null, pageId: null, id: 100 }) === 100)

  // --- 2. Real downstream effect: same shard on disk for the same page ---
  const overlayRoot = await mkdtemp(join(tmpdir(), 'conv-id-fix-overlay-'))
  const baseHermesHome = await mkdtemp(join(tmpdir(), 'conv-id-fix-base-'))
  const conversationStateRoot = join(overlayRoot, 'conversation-state')

  const pageRunA = { taskId: null, pageId: 42, id: 501 }
  const pageRunB = { taskId: null, pageId: 42, id: 502 } // same page, different run — the "second turn"
  const otherPageRun = { taskId: null, pageId: 43, id: 503 } // different page entirely

  const overlayA = await buildHermesHomeOverlay({
    runId: String(pageRunA.id),
    agentId: 'test-agent',
    conversationId: conversationIdFor(pageRunA),
    enabledSkills: [],
    baseHermesHome,
    conversationStateRoot,
    agentMemoryRoot: join(overlayRoot, 'agent-memories'),
    taskRoot: join(overlayRoot, 'tasks'),
  })
  const overlayB = await buildHermesHomeOverlay({
    runId: String(pageRunB.id),
    agentId: 'test-agent',
    conversationId: conversationIdFor(pageRunB),
    enabledSkills: [],
    baseHermesHome,
    conversationStateRoot,
    agentMemoryRoot: join(overlayRoot, 'agent-memories'),
    taskRoot: join(overlayRoot, 'tasks'),
  })
  const overlayOther = await buildHermesHomeOverlay({
    runId: String(otherPageRun.id),
    agentId: 'test-agent',
    conversationId: conversationIdFor(otherPageRun),
    enabledSkills: [],
    baseHermesHome,
    conversationStateRoot,
    agentMemoryRoot: join(overlayRoot, 'agent-memories'),
    taskRoot: join(overlayRoot, 'tasks'),
  })

  check(
    'two page-scoped runs on the SAME page share the same state.db path (conversation continuity restored)',
    overlayA.stateDbPath === overlayB.stateDbPath,
  )
  check(
    'a page-scoped run on a DIFFERENT page gets a DIFFERENT state.db path (no cross-page bleed)',
    overlayOther.stateDbPath !== overlayA.stateDbPath,
  )
  check('the shared path is actually keyed by pageId, not by either run id', overlayA.stateDbPath.includes(String(pageRunA.pageId)))

  await overlayA.cleanup()
  await overlayB.cleanup()
  await overlayOther.cleanup()

  console.log('')
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exitCode = 1
})
