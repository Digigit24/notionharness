// Does the approval card actually say what is being asked?
//
// The bug: `session/request_permission` carries a `toolCall`, not
// `title`/`detail`, and the handler read the fields that do not exist. Every
// card said "Permission requested" with no indication of what would happen —
// a prompt to approve something unnamed, which people click through by habit.
//
// Runs a real turn that must ask permission, and inspects the event.
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readFileSync } from 'node:fs'

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

const COMMAND = process.argv[2] ?? 'claude-agent-acp'
const cwd = mkdtempSync(join(tmpdir(), 'perm-'))

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const result = await sendTurn({
  binaryPath: COMMAND,
  cwd,
  runId: randomUUID(),
  text: 'Create a file called permission-probe.txt containing the single word hello-from-permission-test. Do it now.',
  // 'ask' with no callback denies after the timeout, which is fine: the
  // permission EVENT is emitted either way and that is what is being checked.
  permissionMode: 'ask',
  permissionTimeoutMs: 1_500,
  turnTimeoutMs: 180_000,
  env: process.env.HERMES_TEST_HOME ? { HERMES_HOME: process.env.HERMES_TEST_HOME } : undefined,
  // Manual mode: always ask before making changes. Set explicitly so the test
  // does not depend on whatever the runtime's default happens to be.
  sessionConfig: { mode: 'default' },
})

const permissions = result.envelopes
  .map((e) => e.event)
  .filter((e): e is Extract<typeof e, { type: 'permission' }> => e.type === 'permission')

console.log(`permission events: ${permissions.length}`)
if (permissions.length === 0) {
  console.log('FAIL  the agent never asked for permission — cannot verify')
  process.exit(1)
}

const first = permissions[0]
console.log('')
console.log(`title:  ${first.title}`)
console.log(`detail: ${JSON.stringify(first.detail).slice(0, 300)}`)
console.log(`options: ${first.options.map((o) => o.label ?? o.optionId).join(' | ')}`)
console.log('')

check('the card names the action instead of "Permission requested"', first.title !== 'Permission requested', first.title)
check('the card says what will actually happen', first.detail.trim().length > 0, first.detail.slice(0, 120))
check(
  'the detail names the file or command involved',
  first.detail.includes('permission-probe') || first.detail.includes('hello-from-permission-test'),
  first.detail.slice(0, 200),
)
check(
  'the options carry the agent\'s own wording',
  first.options.length > 0 && first.options.every((o) => Boolean(o.label)),
  first.options.map((o) => String(o.label)).join(' | '),
)

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
