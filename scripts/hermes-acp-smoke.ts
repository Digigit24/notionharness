// Hermes ACP stdio seam — smoke harness (Roadmap Pillar 3.1).
//
// Spawns the real `hermes-acp.exe` binary, sends one trivial prompt over the
// Agent Client Protocol via `lib/hermes/acp-client.ts`, and prints every
// `RunEventEnvelope` the seam emits. This is the Gate-3 verification
// harness: it proves the Node-side seam actually talks ACP (initialize →
// newSession → prompt → session/update stream → stop), not a stub.
//
// Usage:
//   npx tsx scripts/hermes-acp-smoke.ts
//   npx tsx scripts/hermes-acp-smoke.ts "Reply with exactly: pong"
//
// Env overrides (rarely needed; defaults match the verified machine state):
//   HERMES_ACP_BIN    path to the hermes-acp binary (default: the one
//                     confirmed on this host)
//   HERMES_ACP_CWD    cwd to pass the agent (default: a temp dir)

import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sendTurn } from '../lib/hermes/acp-client'
import type { RunEvent, RunEventEnvelope } from '@/lib/run-events'

const DEFAULT_BINARY =
  'C:\\Users\\hrith\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes-acp.exe'

async function main() {
  const prompt =
    process.argv[2] ?? 'Reply with exactly the word "pong" and nothing else.'
  const binaryPath = process.env.HERMES_ACP_BIN ?? DEFAULT_BINARY
  const cwd = process.env.HERMES_ACP_CWD ?? mkdtempSync(join(tmpdir(), 'hermes-acp-smoke-'))
  const runId = randomUUID()

  console.log(`[smoke] binary:   ${binaryPath}`)
  console.log(`[smoke] cwd:      ${cwd}`)
  console.log(`[smoke] runId:    ${runId}`)
  console.log(`[smoke] prompt:   ${JSON.stringify(prompt)}`)
  console.log('')

  const t0 = Date.now()
  const { envelopes, sessionId, agentName } = await sendTurn({
    binaryPath,
    cwd,
    text: prompt,
    runId,
    turnTimeoutMs: 30_000,
  })
  const elapsed = Date.now() - t0

  console.log(`[smoke] agent:                 ${agentName}`)
  console.log(`[smoke] session id:            ${sessionId ?? '(none)'}`)
  console.log(`[smoke] envelope count:        ${envelopes.length}`)
  console.log(`[smoke] elapsed ms:            ${elapsed}`)
  console.log('')
  console.log('[smoke] envelopes (chronological by daemon-assigned seq):')

  let lastSeq = -1
  let monotonic = true
  let wrongRunId = 0
  for (const env of envelopes) {
    if (env.seq <= lastSeq) monotonic = false
    lastSeq = env.seq
    if (env.runId !== runId) wrongRunId += 1
    console.log(`  seq=${env.seq.toString().padStart(3, ' ')}  ${format(env)}`)
  }

  console.log('')
  console.log(`[smoke] monotonic seq:              ${monotonic ? 'OK' : 'BROKEN'}`)
  console.log(`[smoke] pinned session id present:  ${sessionId ? 'OK' : 'MISSING'}`)
  console.log(`[smoke] all envelopes carry runId:  ${wrongRunId === 0 ? 'OK' : `${wrongRunId} MISMATCH`}`)
  const done = envelopes.find(
    (e): e is RunEventEnvelope & { event: Extract<RunEvent, { type: 'done' }> } => e.event.type === 'done',
  )?.event
  console.log(
    `[smoke] done event:                 ${done ? `${done.status}${done.reason ? ` (${done.reason})` : ''}` : 'MISSING'}`,
  )

  if (!monotonic || !sessionId || wrongRunId > 0 || !done || done.status !== 'ok') {
    process.exitCode = 1
  }
}

function format(env: RunEventEnvelope): string {
  const ev: RunEvent = env.event
  switch (ev.type) {
    case 'message':
      return `message    role=${ev.role}  text=${JSON.stringify(truncate(ev.text, 120))}`
    case 'thought':
      return `thought    text=${JSON.stringify(truncate(ev.text, 120))}`
    case 'tool_call':
      return `tool_call  id=${ev.id}  name=${ev.name}  status=${ev.status}`
    case 'tool_result':
      return `tool_result id=${ev.id}  isError=${ev.isError}  output=${JSON.stringify(truncate(JSON.stringify(ev.output), 120))}`
    case 'usage':
      return `usage      provider=${ev.provider}  model=${ev.model}  tokens=${JSON.stringify(ev.tokens)}  costTicks=${ev.costTicks}`
    case 'session':
      return `session    externalId=${ev.externalId}`
    case 'done':
      return `done       status=${ev.status}${ev.reason ? `  reason=${ev.reason}` : ''}`
    case 'permission':
      return `permission id=${ev.id}  title=${ev.title}`
    case 'file_change':
      return `file_change path=${ev.path}`
    case 'terminal':
      return `terminal   id=${ev.id}  chunk=${JSON.stringify(truncate(ev.chunk, 120))}`
    default:
      return `unknown    ${JSON.stringify(ev)}`
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err)
  process.exitCode = 1
})
