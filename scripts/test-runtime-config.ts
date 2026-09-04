// Does a per-agent runtime setting actually reach the runtime?
//
// The picker is worthless if it changes nothing, so this asks the agent which
// model it is running as, once per model, through the real sendTurn path with
// `sessionConfig` set. Anything less would be testing that a dropdown stores a
// string.
//
//   npx tsx scripts/test-runtime-config.ts
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const file of ['.env', '.env.local']) {
  try {
    for (const line of readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
      const match = /^(HERMES_ACP_BIN|HERMES_HOME_BASE)=(.*)$/.exec(line.trim())
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
    }
  } catch {
    // Absent is fine.
  }
}

import { sendTurn } from '../lib/hermes/acp-client'
import type { RunEventEnvelope } from '@/lib/run-events'

const COMMAND = process.argv[2] ?? 'claude-agent-acp'
const cwd = mkdtempSync(join(tmpdir(), 'rtconfig-'))

function assistantText(envelopes: RunEventEnvelope[]): string {
  return envelopes
    .map((e) => e.event)
    .filter((e): e is { type: 'message'; role: 'user' | 'assistant' | 'system'; text: string } => e.type === 'message')
    .filter((e) => e.role === 'assistant')
    .map((e) => e.text)
    .join('')
    .trim()
}

function systemText(envelopes: RunEventEnvelope[]): string {
  return envelopes
    .map((e) => e.event)
    .filter((e): e is { type: 'message'; role: 'user' | 'assistant' | 'system'; text: string } => e.type === 'message')
    .filter((e) => e.role === 'system')
    .map((e) => e.text)
    .join(' | ')
}

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

async function ask(sessionConfig: Record<string, unknown> | undefined) {
  return sendTurn({
    binaryPath: COMMAND,
    cwd,
    runId: randomUUID(),
    text: 'Which model are you? Reply with just the model name, nothing else.',
    permissionMode: 'auto',
    turnTimeoutMs: 180_000,
    sessionConfig,
  })
}

console.log(`command: ${COMMAND}`)
console.log('')

const haiku = await ask({ model: 'haiku' })
const haikuReply = assistantText(haiku.envelopes)
console.log(`model=haiku  -> ${haikuReply.slice(0, 120)}`)
check('a chosen model reaches the runtime', /haiku/i.test(haikuReply), haikuReply.slice(0, 120))
check('no setting was rejected', !/rejected the setting/.test(systemText(haiku.envelopes)), systemText(haiku.envelopes))

const sonnet = await ask({ model: 'sonnet' })
const sonnetReply = assistantText(sonnet.envelopes)
console.log(`model=sonnet -> ${sonnetReply.slice(0, 120)}`)
check('a different choice produces a different model', /sonnet/i.test(sonnetReply), sonnetReply.slice(0, 120))

// An id the runtime does not know must be reported, not silently ignored and
// not fatal to the turn.
const bogus = await ask({ not_a_real_option: 'x' })
const notice = systemText(bogus.envelopes)
check('an unknown setting is reported in the transcript', /not_a_real_option/.test(notice), notice.slice(0, 200))
check('and the turn still completes', assistantText(bogus.envelopes).length > 0)

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
