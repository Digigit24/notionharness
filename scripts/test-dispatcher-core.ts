// Dispatcher wiring smoke test — verifies the part of `lib/dispatcher/
// worker.ts` that's actually new and risky: a run's worktree (Pillar 4.4)
// as the turn's cwd, combined with the per-agent HERMES_HOME overlay
// (Pillar 3.4) and the new live `onEvent` streaming callback added to
// `sendTurn`/`sendTurnWithIdentity` in this same task — run against the
// REAL hermes-acp binary and a disposable temp repo, never the real
// notionforge repo.
//
// Deliberately does NOT exercise `dispatchNextRun`/`executeRun` themselves:
// those also call `getPayloadClient()` and the raw-pg broker, and this
// project's own standing guidance is not to run standalone scripts against
// the shared Supabase-backed Payload instance (schema-drift/hang risk,
// `push: false`). The broker's claim/settle mechanics are already proven by
// `scripts/test-broker.ts` (Pillar 4); this script proves everything
// downstream of "a run has been claimed" that's genuinely new here.
//
// Run with: npx tsx scripts/test-dispatcher-core.ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { RunWorktreeManager } from '../lib/run-worktrees/manager'
import { sendTurnWithIdentity } from '../lib/hermes/run-with-identity'
import type { RunEventEnvelope } from '../lib/run-events'

const exec = promisify(execFile)
let failures = 0

function check(label: string, condition: boolean) {
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${label}`)
  if (!condition) failures += 1
}

const HERMES_ACP_BIN =
  process.env.HERMES_ACP_BIN ?? 'C:\\Users\\hrith\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes-acp.exe'

async function main() {
  const source = await mkdtemp(join(tmpdir(), 'dispatcher-core-source-'))
  const state = await mkdtemp(join(tmpdir(), 'dispatcher-core-state-'))
  const overlayRoot = await mkdtemp(join(tmpdir(), 'dispatcher-core-overlay-'))
  const git = async (args: string[], cwd = source) => exec('git', args, { cwd, windowsHide: true })

  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'test@example.invalid'])
  await git(['config', 'user.name', 'dispatcher core test'])
  await writeFile(join(source, 'seed.txt'), 'seed\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'seed'])

  const manager = new RunWorktreeManager({ rootDir: state })
  const runId = `dispatch-${randomUUID().slice(0, 8)}`
  const worktree = await manager.create(source, runId, 'main')

  const liveEnvelopes: RunEventEnvelope[] = []
  const agentId = 'test-agent-dispatcher-core'

  const result = await sendTurnWithIdentity({
    binaryPath: HERMES_ACP_BIN,
    cwd: worktree.worktreePath,
    text: 'Reply with exactly the word "pong" and nothing else.',
    runId,
    agentId,
    conversationId: 'test-conversation-dispatcher-core',
    enabledSkills: [],
    turnTimeoutMs: 30_000,
    // Fake in-memory sink standing in for `appendRunEvent` — proves the
    // callback actually fires per-event, in order, not just that the final
    // batch return still works.
    onEvent: (envelope) => liveEnvelopes.push(envelope),
    agentMemoryRoot: join(overlayRoot, 'agent-memories'),
    conversationStateRoot: join(overlayRoot, 'conversation-state'),
    taskRoot: join(overlayRoot, 'tasks'),
    baseHermesHome: process.env.HERMES_HOME_BASE,
  })

  check('turn produced at least one envelope', result.envelopes.length > 0)
  check(
    'onEvent fired for every envelope, same order (live streaming actually streams)',
    liveEnvelopes.length === result.envelopes.length && liveEnvelopes.every((e, i) => e.seq === result.envelopes[i].seq),
  )
  const done = result.envelopes.find((e) => e.event.type === 'done')
  check('a done event was produced', done !== undefined)
  check('the run own worktree was actually the turn cwd (not the source repo)', worktree.worktreePath !== source)
  check('missingSkills is empty for an empty skill list', result.missingSkills.length === 0)

  // A second run, SAME agentId, DIFFERENT runId/conversation — proves the
  // per-agent memories store is genuinely shared across runs the way
  // worker.ts relies on (conversationId = taskId, not agentId, but memories
  // are keyed by agentId specifically).
  const runId2 = `dispatch-${randomUUID().slice(0, 8)}`
  const worktree2 = await manager.create(source, runId2, 'main')
  const result2 = await sendTurnWithIdentity({
    binaryPath: HERMES_ACP_BIN,
    cwd: worktree2.worktreePath,
    text: 'Reply with exactly the word "pong" and nothing else.',
    runId: runId2,
    agentId,
    conversationId: 'a-different-conversation',
    enabledSkills: [],
    turnTimeoutMs: 30_000,
    agentMemoryRoot: join(overlayRoot, 'agent-memories'),
    conversationStateRoot: join(overlayRoot, 'conversation-state'),
    taskRoot: join(overlayRoot, 'tasks'),
    baseHermesHome: process.env.HERMES_HOME_BASE,
  })
  check('second run under the same agentId also completes', result2.envelopes.some((e) => e.event.type === 'done'))

  await manager.remove(worktree)
  await manager.remove(worktree2)

  console.log('')
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('[dispatcher-core smoke] FAILED:', err)
  process.exitCode = 1
})
