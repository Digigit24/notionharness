// R3.1 verification — does `session/load` actually carry a conversation
// across two separate agent processes?
//
// This is the only test that answers the real question. Two turns in one
// process would prove nothing: the agent would still be holding the session
// in memory. Each `sendTurn` here spawns the binary, runs one turn, and tears
// the process down, so turn two can only know what turn one said if the
// agent genuinely persisted and replayed the session.
//
// Usage: npx tsx scripts/test-session-resume.ts
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readFileSync } from 'node:fs'

// Scripts here run outside Next, so nothing has read `.env` yet. Only the two
// keys this script needs, and only when not already set in the environment.
for (const file of ['.env', '.env.local']) {
  try {
    for (const line of readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
      const match = /^(HERMES_ACP_BIN|HERMES_HOME_BASE|HERMES_ACP_CWD)=(.*)$/.exec(line.trim())
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
    }
  } catch {
    // Absent is fine; the check below reports what is actually missing.
  }
}

import { sendTurn } from '../lib/acp/client'
import type { RunEventEnvelope } from '@/lib/run-events'

function defaultAcpBinary(): string | undefined {
  if (!process.env.HERMES_HOME_BASE) return undefined
  return join(process.env.HERMES_HOME_BASE, 'hermes-agent', 'venv', 'Scripts', 'hermes-acp.exe')
}

function assistantText(envelopes: RunEventEnvelope[]): string {
  return envelopes
    .map((e) => e.event)
    .filter((e): e is { type: 'message'; role: 'user' | 'assistant' | 'system'; text: string } => e.type === 'message')
    .filter((e) => e.role === 'assistant')
    .map((e) => e.text)
    .join('')
    .trim()
}

async function main() {
  const binaryPath = process.env.HERMES_ACP_BIN ?? defaultAcpBinary()
  if (!binaryPath) throw new Error('Set HERMES_ACP_BIN or HERMES_HOME_BASE.')
  const cwd = process.env.HERMES_ACP_CWD ?? mkdtempSync(join(tmpdir(), 'resume-'))
  // A word the agent cannot possibly produce from anything but turn one.
  // A Hermes profile is a complete alternate HERMES_HOME, so this is how the
  // test picks a provider that is actually usable right now.
  const home = process.env.HERMES_TEST_HOME
  const env = home ? { HERMES_HOME: home } : undefined
  const secret = `zircon-${Math.random().toString(36).slice(2, 8)}`

  console.log(`cwd:    ${cwd}`)
  console.log(`secret: ${secret}\n`)

  console.log('--- Turn 1: establish the session -------------------------')
  const first = await sendTurn({
    binaryPath,
    cwd,
    runId: randomUUID(),
    text: `Remember this codeword for later: ${secret}. Reply with exactly: stored`,
    permissionMode: 'auto',
    turnTimeoutMs: 180_000,
    env,
  })
  console.log(`sessionId: ${first.sessionId}`)
  console.log(`resumed:   ${first.resumed}`)
  console.log(`reply:     ${assistantText(first.envelopes).slice(0, 200)}\n`)
  if (!first.sessionId) throw new Error('Turn 1 produced no session id — nothing to resume.')

  console.log('--- Turn 2: NEW process, resume the session ---------------')
  const second = await sendTurn({
    binaryPath,
    cwd,
    runId: randomUUID(),
    text: 'What was the codeword I asked you to remember? Reply with just the codeword.',
    permissionMode: 'auto',
    turnTimeoutMs: 180_000,
    env,
    resumeSessionId: first.sessionId,
  })
  const reply = assistantText(second.envelopes)
  console.log(`sessionId: ${second.sessionId}`)
  console.log(`resumed:   ${second.resumed}`)
  if (second.resumeFailure) console.log(`failure:   ${second.resumeFailure}`)
  console.log(`reply:     ${reply.slice(0, 300)}\n`)

  console.log('--- Turn 3: a session id the agent never minted ------------')
  const third = await sendTurn({
    binaryPath,
    cwd,
    runId: randomUUID(),
    text: 'Reply with exactly: fresh',
    permissionMode: 'auto',
    turnTimeoutMs: 180_000,
    env,
    resumeSessionId: 'this-session-does-not-exist',
  })
  console.log(`resumed:   ${third.resumed}  (expected false)`)
  console.log(`failure:   ${third.resumeFailure ?? '(none — that would be a bug)'}`)
  console.log(`newId:     ${third.sessionId}`)
  const notice = third.envelopes
    .map((e) => e.event)
    .find((e) => e.type === 'message' && e.role === 'system')
  console.log(`notice:    ${notice && notice.type === 'message' ? notice.text : '(none — that would be a bug)'}\n`)

  console.log('=== VERDICT ===============================================')
  const carried = reply.toLowerCase().includes(secret.toLowerCase())
  console.log(`turn 2 resumed the session:      ${second.resumed ? 'YES' : 'NO'}`)
  console.log(`turn 2 recalled turn 1's secret: ${carried ? 'YES' : 'NO'}`)
  console.log(`unknown id fell back cleanly:    ${!third.resumed && third.sessionId ? 'YES' : 'NO'}`)
  process.exit(second.resumed && carried && !third.resumed && third.sessionId ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
