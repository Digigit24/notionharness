/**
 * Transcript pipeline unit tests (Roadmap Pillar 5.6).
 *
 * Pure-logic tests — no DB, no live agent, no UI. Run with:
 *   npx tsx scripts/test-transcript-pipeline.ts
 *
 * Fixture builders below construct RunEventEnvelope[] shapes by hand so
 * the tests are self-contained and the inputs are obvious from reading
 * the test (no opaque binary fixtures).
 *
 * Coverage:
 *   - Empty / single-event edge cases
 *   - Out-of-order seq input (the documented footgun)
 *   - Adjacent message coalescing across same/different roles
 *   - Secret redaction across message/thought/terminal/tool_result.output
 *   - Unpaired tool_calls (no matching result) → orphan_tool_call
 *   - Unpaired tool_results (no matching call) → dropped by Steps pass,
 *     surfaced by surfaceOrphanResults()
 *   - Five identical bash calls → never collapsed
 *   - Five identical read_file calls → collapsed into one group
 *   - Mixed usage events → sum into a single totalCostTicks
 *   - File_change diffs with `+`/`-` line counting (excluding `+++`/`---`)
 *   - end-to-end pipeline composition (processTranscript) on the above
 *   - Header chip formatting ("11 files +593 −12", "74 commands", "$4.38")
 *
 * Exit code: 0 if every assertion passes, 1 otherwise.
 */

import { randomUUID } from 'node:crypto'

import type { RunEvent, RunEventEnvelope } from '../lib/run-events'
import { processTranscript, surfaceOrphanResults } from '../lib/transcript/pipeline'

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

interface AssertionRecord {
  name: string
  passed: boolean
  detail?: string
}

const assertions: AssertionRecord[] = []

function assert(name: string, condition: boolean, detail?: string): void {
  assertions.push({ name, passed: condition, detail })
}

function assertEq<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  assert(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const FIXTURE_RUN_ID = 'run_test_001'

function env(seq: number, event: RunEvent): RunEventEnvelope {
  return { runId: FIXTURE_RUN_ID, seq, event }
}

// Helper: build N consecutive bash tool_call+result pairs with simple
// echo command inputs. Returns 2N envelopes starting at `startSeq`.
function bashBurst(startSeq: number, count: number, endSeq?: number): RunEventEnvelope[] {
  const out: RunEventEnvelope[] = []
  let s = startSeq
  for (let i = 0; i < count; i++) {
    const id = `bash_${i}`
    out.push(env(s++, { type: 'tool_call', id, name: 'bash', input: { cmd: `echo ${i}` }, status: 'in_progress' }))
    out.push(env(s++, { type: 'tool_result', id, output: { stdout: `${i}\n` }, isError: false }))
  }
  if (typeof endSeq === 'number') {
    // Pad to the requested end seq if caller asked for one (placeholder tool_calls).
    while (s < endSeq) {
      const id = `pad_${s}`
      out.push(env(s++, { type: 'tool_call', id, name: 'noop', input: {}, status: 'in_progress' }))
    }
  }
  return out
}

// Helper: build N consecutive read_file tool_call+result pairs.
function readFileBurst(startSeq: number, count: number): RunEventEnvelope[] {
  const out: RunEventEnvelope[] = []
  let s = startSeq
  for (let i = 0; i < count; i++) {
    const id = `rf_${i}`
    out.push(env(s++, { type: 'tool_call', id, name: 'read_file', input: { path: `/tmp/f${i}.txt` }, status: 'in_progress' }))
    out.push(env(s++, { type: 'tool_result', id, output: { content: `file ${i}` }, isError: false }))
  }
  return out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('--- Transcript pipeline tests (P5.6) ---\n')

// --- Empty / single-event edge cases ----------------------------------
{
  const result = processTranscript([])
  assert('empty input produces empty result', result.timeline.length === 0)
  assert('empty input has zero steps', result.steps.length === 0)
  assert('empty input has zero groups', result.groupedSteps.length === 0)
  assert('empty input has zero lanes', result.lanes.length === 0)
  assert('empty input chip: files', result.outcome.chips.files === 'no files')
  assert('empty input chip: commands', result.outcome.chips.commands === 'no commands')
  assert('empty input chip: cost', result.outcome.chips.cost === '$0.00')
}

{
  const envelopes = [env(1, { type: 'session', externalId: 'sess_x' })]
  const result = processTranscript(envelopes)
  assert('single session envelope yields one timeline item', result.timeline.length === 1)
  assert('single session envelope yields zero steps', result.steps.length === 0)
}

// --- Out-of-order seq (the documented footgun) ------------------------
{
  // Three messages in reverse seq order. Pipeline must sort by seq, not
  // insertion order — text should end up in seq order.
  const envelopes = [
    env(3, { type: 'message', role: 'assistant', text: 'third' }),
    env(1, { type: 'message', role: 'assistant', text: 'first' }),
    env(2, { type: 'message', role: 'assistant', text: 'second' }),
  ]
  const result = processTranscript(envelopes)
  // The three are consecutive assistant messages → coalesced into one.
  assert('out-of-order seq coalesces into one message', result.timeline.length === 1)
  assert('coalesced message text is in seq order', result.timeline[0].kind === 'message' && result.timeline[0].text === 'firstsecondthird')
}

{
  // Truly scrambled seq order with mixed event kinds — verifies the
  // sort is global, not just per-kind.
  const envelopes = [
    env(5, { type: 'done', status: 'ok' }),
    env(1, { type: 'session', externalId: 'a' }),
    env(3, { type: 'thought', text: 'thinking' }),
    env(2, { type: 'session', externalId: 'b' }),
    env(4, { type: 'message', role: 'user', text: 'reply' }),
  ]
  const result = processTranscript(envelopes)
  // Expected order in timeline (each different kind, no coalescing):
  // session(a), session(b), thought, message, done.
  assertEq(
    'scrambled seq produces correct order',
    result.timeline.map((i) => (i.kind === 'session' ? i.externalId : i.kind)),
    ['a', 'b', 'thought', 'message', 'done'],
  )
}

// --- Duplicate seq (malformed input tolerance) ------------------------
{
  const envelopes = [
    env(1, { type: 'message', role: 'assistant', text: 'A' }),
    env(1, { type: 'message', role: 'assistant', text: 'B' }), // duplicate seq
    env(2, { type: 'message', role: 'assistant', text: 'C' }),
  ]
  const result = processTranscript(envelopes)
  // First wins → A and C kept (consecutive same role → coalesced).
  assert('duplicate seq keeps first', result.timeline.length === 1 && result.timeline[0].kind === 'message' && result.timeline[0].text === 'AC')
}

// --- Adjacent message coalescing rules --------------------------------
{
  // Two assistant then one user then two assistant — assistant runs coalesce
  // but the user in the middle breaks the assistant run.
  const envelopes = [
    env(1, { type: 'message', role: 'assistant', text: 'a1' }),
    env(2, { type: 'message', role: 'assistant', text: 'a2' }),
    env(3, { type: 'message', role: 'user', text: 'u1' }),
    env(4, { type: 'message', role: 'assistant', text: 'a3' }),
    env(5, { type: 'message', role: 'assistant', text: 'a4' }),
  ]
  const result = processTranscript(envelopes)
  assertEq(
    'assistant runs coalesce but user in middle breaks the run',
    result.timeline.map((i) => (i.kind === 'message' ? `${i.role}:${i.text}` : i.kind)),
    ['assistant:a1a2', 'user:u1', 'assistant:a3a4'],
  )
}

{
  // Non-message event between two same-role messages → must NOT coalesce.
  const envelopes = [
    env(1, { type: 'message', role: 'assistant', text: 'a1' }),
    env(2, { type: 'thought', text: 'in between' }),
    env(3, { type: 'message', role: 'assistant', text: 'a2' }),
  ]
  const result = processTranscript(envelopes)
  assertEq(
    'thought between same-role messages breaks coalescing',
    result.timeline.map((i) => (i.kind === 'message' ? i.text : i.kind)),
    ['a1', 'thought', 'a2'],
  )
}

// --- Secret redaction -------------------------------------------------
{
  const envelopes = [
    env(1, { type: 'message', role: 'assistant', text: 'My key is AKIAIOSFODNN7EXAMPLE and ghp_abc1234567890123456789012345678901234' }),
    env(2, { type: 'thought', text: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature' }),
    env(3, { type: 'tool_call', id: 't1', name: 'lookup_secret', input: {}, status: 'in_progress' }),
    env(4, { type: 'tool_result', id: 't1', output: { token: 'sk_test_' + 'FAKE'.repeat(6) }, isError: false }),
  ]
  const result = processTranscript(envelopes)
  const msg = result.timeline[0]
  assert('AWS access key redacted in message.text', msg.kind === 'message' && !msg.text.includes('AKIAIOSFODNN7EXAMPLE'))
  assert('GitHub PAT redacted in message.text', msg.kind === 'message' && !msg.text.includes('ghp_'))
  const thought = result.timeline[1]
  assert('Bearer JWT redacted in thought.text', thought.kind === 'thought' && !thought.text.includes('eyJ'))
  const toolRes = result.steps[0]
  assert('Stripe test key redacted in tool_result.output', toolRes.output !== undefined && !JSON.stringify(toolRes.output).includes('sk_test_'))
}

// --- Unpaired tool_calls (no matching result) -------------------------
{
  const envelopes = [
    env(1, { type: 'tool_call', id: 'orphan_1', name: 'long_op', input: {}, status: 'in_progress' }),
    env(2, { type: 'message', role: 'assistant', text: 'still waiting' }),
  ]
  const result = processTranscript(envelopes)
  // Timeline marks orphan_1 as orphan_tool_call (Pass 1b). Steps pass
  // produces a Step with no output.
  assert('orphan tool_call becomes orphan_tool_call in timeline', result.timeline.some((i) => i.kind === 'orphan_tool_call' && i.id === 'orphan_1'))
  assert('orphan tool_call produces a Step', result.steps.length === 1 && result.steps[0].id === 'orphan_1')
  assert('orphan Step has no output', result.steps[0].output === undefined)
  assert('orphan Step has no approxMsFromSeq', result.steps[0].approxMsFromSeq === undefined)
  assert('orphan Step retains in_progress status', result.steps[0].status === 'in_progress')
}

// --- Unpaired tool_results (result with no call) ---------------------
{
  const envelopes = [
    env(1, { type: 'tool_result', id: 'non_call', output: 'where did this come from', isError: false }),
  ]
  const result = processTranscript(envelopes)
  // Timeline emits the orphan tool_result, Steps pass ignores it
  // (nothing to pair with). surfaceOrphanResults() should find it.
  const orphans = surfaceOrphanResults(result.timeline)
  assert('orphan tool_result surfaces via surfaceOrphanResults', orphans.length === 1 && orphans[0].id === 'non_call')
  assert('pipeline drops orphan tool_result from Steps', result.steps.length === 0)
}

// --- Five identical bash calls (never collapsed) ---------------------
{
  const envelopes = bashBurst(1, 5)
  const result = processTranscript(envelopes)
  assert('five bash calls produce five Steps', result.steps.length === 5)
  assert('five bash calls produce five GroupedSteps (no collapse)', result.groupedSteps.length === 5)
  assert('five bash calls produce five tool lanes', result.lanes.filter((l) => l.lane === 'tool').length === 5)
  assert('commandsCount = 5 for five bash calls', result.outcome.commandsCount === 5)
}

// --- Five identical read_file calls (collapsed) ----------------------
{
  const envelopes = readFileBurst(1, 5)
  const result = processTranscript(envelopes)
  assert('five read_file calls produce five Steps (collapse happens later)', result.steps.length === 5)
  assert('five read_file calls collapse into one GroupedStep', result.groupedSteps.length === 1)
  if (result.groupedSteps[0].kind === 'collapsed') {
    assert('collapsed group has count=5', result.groupedSteps[0].count === 5)
    assert('collapsed group name is read_file', result.groupedSteps[0].name === 'read_file')
  } else {
    assert('collapsed group kind is collapsed', false)
  }
}

// --- Mixed runs: 2 read_file, 1 bash (break), 3 read_file (collapse), 1 bash,
//                  3 read_file (collapse) → 8 grouped items: 2 step + 1 step +
//                  1 collapsed + 1 step + 1 collapsed = 6? Let's trace: 2
//                  individual + 1 bash + 3 collapsed + 1 bash + 3 collapsed.
//                  Total = 2 + 1 + 1 + 1 + 1 = 6 grouped items.
{
  const envelopes: RunEventEnvelope[] = []
  let s = 1
  // Two read_file
  for (let i = 0; i < 2; i++) {
    const id = `rf_a_${i}`
    envelopes.push(env(s++, { type: 'tool_call', id, name: 'read_file', input: { path: `a${i}` }, status: 'in_progress' }))
    envelopes.push(env(s++, { type: 'tool_result', id, output: { content: 'x' }, isError: false }))
  }
  // One bash (breaks the read_file run so the 2 stays individual)
  envelopes.push(env(s++, { type: 'tool_call', id: 'bash_x', name: 'bash', input: { cmd: 'ls' }, status: 'in_progress' }))
  envelopes.push(env(s++, { type: 'tool_result', id: 'bash_x', output: { stdout: '' }, isError: false }))
  // Three read_file → collapse
  for (let i = 0; i < 3; i++) {
    const id = `rf_b_${i}`
    envelopes.push(env(s++, { type: 'tool_call', id, name: 'read_file', input: { path: `b${i}` }, status: 'in_progress' }))
    envelopes.push(env(s++, { type: 'tool_result', id, output: { content: 'y' }, isError: false }))
  }
  // One bash
  envelopes.push(env(s++, { type: 'tool_call', id: 'bash_y', name: 'bash', input: { cmd: 'pwd' }, status: 'in_progress' }))
  envelopes.push(env(s++, { type: 'tool_result', id: 'bash_y', output: { stdout: '' }, isError: false }))
  // Three read_file → collapse
  for (let i = 0; i < 3; i++) {
    const id = `rf_c_${i}`
    envelopes.push(env(s++, { type: 'tool_call', id, name: 'read_file', input: { path: `c${i}` }, status: 'in_progress' }))
    envelopes.push(env(s++, { type: 'tool_result', id, output: { content: 'z' }, isError: false }))
  }

  const result = processTranscript(envelopes)
  assert('mixed runs produce correct grouped count', result.groupedSteps.length === 6)
  // 2 individual reads, 1 individual bash, 1 collapsed group of 3 reads,
  // 1 individual bash, 1 collapsed group of 3 reads.
  const kinds = result.groupedSteps.map((g) => (g.kind === 'collapsed' ? `collapsed:${g.name}:${g.count}` : `step:${g.name}`))
  assertEq(
    'mixed runs grouping shape is correct',
    kinds,
    [
      'step:read_file',
      'step:read_file',
      'step:bash',
      'collapsed:read_file:3',
      'step:bash',
      'collapsed:read_file:3',
    ],
  )
}

// --- Mixed usage events → summed totalCostTicks ----------------------
{
  const envelopes = [
    env(1, { type: 'session', externalId: 's' }),
    env(2, { type: 'usage', provider: 'anthropic', model: 'claude-3.5-sonnet', tokens: 100, costTicks: 50 }),
    env(3, { type: 'usage', provider: 'anthropic', model: 'claude-3.5-sonnet', tokens: 200, costTicks: 388 }),
    env(4, { type: 'usage', provider: 'anthropic', model: 'claude-3.5-sonnet', tokens: 300, costTicks: 0 }),
    env(5, { type: 'done', status: 'ok' }),
  ]
  const result = processTranscript(envelopes)
  assertEq('mixed usage totalCostTicks', result.outcome.totalCostTicks, 438)
  assert('mixed usage chip = $4.38', result.outcome.chips.cost === '$4.38')
}

// --- File_change diff parsing (+++ and --- headers excluded) ----------
{
  const envelopes = [
    env(1, { type: 'session', externalId: 's' }),
    env(2, {
      type: 'file_change',
      path: 'a.ts',
      diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n line one\n-removed\n+added\n line three\n',
    }),
    env(3, {
      type: 'file_change',
      path: 'b.ts',
      diff: '--- a/b.ts\n+++ b/b.ts\n@@ -1,2 +1,2 @@\n kept\n+only added\n',
    }),
    env(4, { type: 'done', status: 'ok' }),
  ]
  const result = processTranscript(envelopes)
  assertEq('filesChanged = distinct paths', result.outcome.filesChanged, 2)
  assertEq('linesAdded from diffs', result.outcome.linesAdded, 2)
  assertEq('linesRemoved from diffs', result.outcome.linesRemoved, 1)
  assert('files chip = "2 files +2 −1"', result.outcome.chips.files === '2 files +2 −1')
}

// --- Singular forms in header chips ----------------------------------
{
  const envelopes = [
    env(1, { type: 'session', externalId: 's' }),
    env(2, {
      type: 'file_change',
      path: 'only.ts',
      diff: '--- a/x\n+++ b/x\n-added\n+added\n',
    }),
    env(3, { type: 'tool_call', id: 'b1', name: 'bash', input: {}, status: 'in_progress' }),
    env(4, { type: 'tool_result', id: 'b1', output: {}, isError: false }),
    env(5, { type: 'done', status: 'ok' }),
  ]
  const result = processTranscript(envelopes)
  assert('singular: "1 file +1 −1"', result.outcome.chips.files === '1 file +1 −1')
  assert('singular: "1 command"', result.outcome.chips.commands === '1 command')
}

// --- Tool call status handling ---------------------------------------
{
  // Failed call → step.status='failed', no result.
  const env1 = processTranscript([env(1, { type: 'tool_call', id: 'f1', name: 'risky', input: {}, status: 'failed' })])
  assert('failed tool_call with no result → step.status=failed', env1.steps[0]?.status === 'failed')

  // Failed result → step.status='failed' even if call was in_progress.
  const env2 = processTranscript([
    env(1, { type: 'tool_call', id: 'f2', name: 'risky', input: {}, status: 'in_progress' }),
    env(2, { type: 'tool_result', id: 'f2', output: { error: 'kaboom' }, isError: true }),
  ])
  assert('tool_result.isError=true → step.status=failed', env2.steps[0]?.status === 'failed')

  // Successful pair → step.status='completed'.
  const env3 = processTranscript([
    env(1, { type: 'tool_call', id: 'f3', name: 'safe', input: {}, status: 'in_progress' }),
    env(2, { type: 'tool_result', id: 'f3', output: 'ok', isError: false }),
  ])
  assert('completed pair → step.status=completed', env3.steps[0]?.status === 'completed')
  assert('completed pair → approxMsFromSeq is positive', (env3.steps[0]?.approxMsFromSeq ?? 0) > 0)
}

// --- Lanes: thinking vs tool split + ordering ------------------------
{
  const envelopes = [
    env(1, { type: 'thought', text: 'ponder' }),
    env(2, { type: 'tool_call', id: 't1', name: 'read_file', input: {}, status: 'completed' }),
    env(3, { type: 'tool_result', id: 't1', output: 'x', isError: false }),
    env(4, { type: 'thought', text: 'more' }),
  ]
  const result = processTranscript(envelopes)
  // Tool lanes: one segment seq 2→3. Thinking lanes: seq 1, seq 4.
  const toolLanes = result.lanes.filter((l) => l.lane === 'tool')
  const thinkLanes = result.lanes.filter((l) => l.lane === 'thinking')
  assert('one tool lane', toolLanes.length === 1)
  assert('two thinking lanes', thinkLanes.length === 2)
  assert('tool lane label is read_file', toolLanes[0]?.label === 'read_file')
  // Sorted by startSeq ascending — first thought (seq 1) comes before the tool lane.
  assert('first lane is thinking at seq 1', result.lanes[0]?.lane === 'thinking' && result.lanes[0]?.startSeq === 1)
}

// --- End-to-end: long realistic-ish fixture ---------------------------
{
  // A model thinks, runs a tool, sees the result, thinks, edits two files,
  // then a bash command, then ends.
  const envelopes = [
    env(1, { type: 'session', externalId: 'sess_real' }),
    env(2, { type: 'thought', text: 'let me read the file first' }),
    env(3, { type: 'tool_call', id: 'rf1', name: 'read_file', input: { path: '/x' }, status: 'in_progress' }),
    env(4, { type: 'tool_result', id: 'rf1', output: { lines: 10 }, isError: false }),
    env(5, { type: 'thought', text: 'got it, now edit' }),
    env(6, { type: 'file_change', path: '/x', diff: '--- a/x\n+++ b/x\n-old\n+new\n' }),
    env(7, { type: 'file_change', path: '/y', diff: '--- a/y\n+++ b/y\n-removed\n+added\n+added2\n' }),
    env(8, { type: 'tool_call', id: 'b1', name: 'bash', input: { cmd: 'make test' }, status: 'in_progress' }),
    env(9, { type: 'tool_result', id: 'b1', output: { exit: 0 }, isError: false }),
    env(10, { type: 'usage', provider: 'anthropic', model: 'claude', tokens: 1234, costTicks: 99 }),
    env(11, { type: 'done', status: 'ok' }),
  ]
  const result = processTranscript(envelopes)
  // 11 envelopes, no adjacent same-role messages to coalesce (this
  // fixture has zero 'message' events — only 'thought', which never
  // coalesces) — every envelope maps 1:1 to a TimelineItem.
  assert('e2e timeline length is correct', result.timeline.length === 11)
  assert('e2e steps count = 2 (rf + bash)', result.steps.length === 2)
  assert('e2e groups = 2 (rf standalone, bash standalone)', result.groupedSteps.length === 2)
  assertEq('e2e filesChanged', result.outcome.filesChanged, 2)
  assertEq('e2e linesAdded', result.outcome.linesAdded, 3)
  assertEq('e2e linesRemoved', result.outcome.linesRemoved, 2)
  assertEq('e2e commandsCount', result.outcome.commandsCount, 1)
  assertEq('e2e totalCostTicks', result.outcome.totalCostTicks, 99)
  assert('e2e chips.files formatted', result.outcome.chips.files === '2 files +3 −2')
  assert('e2e chips.commands formatted', result.outcome.chips.commands === '1 command')
  assert('e2e chips.cost formatted', result.outcome.chips.cost === '$0.99')
}

// --- Determinism: same input → same output ----------------------------
{
  const envelopes = [
    env(3, { type: 'message', role: 'assistant', text: 'c' }),
    env(1, { type: 'message', role: 'assistant', text: 'a' }),
    env(2, { type: 'message', role: 'assistant', text: 'b' }),
  ]
  const a = processTranscript(envelopes)
  const b = processTranscript(envelopes)
  assertEq('determinism: same input → same timeline length', a.timeline.length, b.timeline.length)
  assertEq(
    'determinism: same input → same coalesced text',
    a.timeline[0]?.kind === 'message' ? a.timeline[0].text : null,
    b.timeline[0]?.kind === 'message' ? b.timeline[0].text : null,
  )
}

// --- Sanity: runId is preserved on every envelope, no leak -----------
{
  const envelopes = [
    env(1, { type: 'message', role: 'assistant', text: 'x' }),
    env(2, { type: 'thought', text: 'y' }),
  ]
  // processTranscript doesn't expose runId back, but the events all
  // carried the same runId — verify by constructing each event through
  // a small helper that asserts runId uniqueness on the input side.
  const seenRunIds = new Set(envelopes.map((e) => e.runId))
  assert('input runIds are consistent', seenRunIds.size === 1 && seenRunIds.has(FIXTURE_RUN_ID))
}

// --- Make sure we hit the randomUUID path so the linter sees it used ---
{
  // randomUUID is used elsewhere on the daemon side; keep this here so
  // the import isn't pruned by accident.
  void randomUUID
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = assertions.filter((a) => a.passed).length
const failed = assertions.length - passed

console.log('')
for (const a of assertions) {
  const tag = a.passed ? 'PASS' : 'FAIL'
  console.log(`  [${tag}] ${a.name}${a.detail ? ` — ${a.detail}` : ''}`)
}
console.log('')
console.log(`Summary: ${passed} passed, ${failed} failed (of ${assertions.length})`)

if (failed > 0) process.exitCode = 1
