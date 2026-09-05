// ACP smoke harness for any runtime in the catalog, or any command at all.
//
// The Hermes-specific version (`hermes-acp-smoke.ts`) proved the seam speaks
// the protocol. This one asks the same question of every CLI the catalog
// knows — Claude Code, Codex, OpenCode — and of a command typed by hand, so
// "does this runtime work here" is one command rather than a settings page,
// a probe button and a run. It is the acceptance test for
// `lib/runtimes/catalog.ts`: an entry whose smoke does not pass is an entry
// that is wrong.
//
// Usage:
//   npx tsx scripts/acp-smoke.ts --runtime codex
//   npx tsx scripts/acp-smoke.ts --runtime opencode "Reply with exactly: pong"
//   npx tsx scripts/acp-smoke.ts --command "opencode acp"
//   npx tsx scripts/acp-smoke.ts --runtime codex --identity     # through the linked-home strategy
//   npx tsx scripts/acp-smoke.ts --all                           # every installed catalog entry
//
// Options:
//   --runtime <id>    a catalog id: hermes | claude-code | codex | opencode | gemini | goose
//   --command <cmd>   any command line; overrides --runtime
//   --identity        run through `sendTurnWithIdentity` with the entry's home
//                     strategy (needs the CLI's real home to exist), instead
//                     of the bare `sendTurn`
//   --all             smoke every catalog entry whose CLI is on PATH
//   --cwd <dir>       working directory for the agent (default: a temp dir)
//   --timeout <ms>    turn timeout (default 90000)
//   --set <id>=<v>    a session config value, repeatable (e.g. --set model=gpt-5.1)
//                     — the ids are the runtime's own, from its handshake
//
// Exit code is 0 only when the turn produced a `done` with status `ok` AND
// the assistant's reply is not a bare JSON error object. The second check
// exists because Codex's adapter reports a provider refusal ("unknown
// model …") as an ordinary assistant message with `end_turn`, which would
// otherwise pass.

import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sendTurn } from '../lib/acp/client'
import { sendTurnWithIdentity } from '../lib/runtimes/hermes/run-with-identity'
import { RUNTIME_CATALOG, catalogEntry, catalogEntryCommandLine, type RuntimeCatalogEntry } from '../lib/runtimes/catalog'
import { resolveCommandPath } from '../lib/runtimes/spawn-command'
import type { RunEvent, RunEventEnvelope } from '@/lib/run-events'

interface Args {
  runtime?: string
  command?: string
  identity: boolean
  all: boolean
  cwd?: string
  timeout: number
  prompt: string
  sessionConfig: Record<string, string>
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    identity: false,
    all: false,
    timeout: 90_000,
    prompt: 'Reply with exactly the word "pong" and nothing else.',
    sessionConfig: {},
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--runtime') args.runtime = argv[++i]
    else if (arg === '--command') args.command = argv[++i]
    else if (arg === '--identity') args.identity = true
    else if (arg === '--all') args.all = true
    else if (arg === '--cwd') args.cwd = argv[++i]
    else if (arg === '--timeout') args.timeout = Number(argv[++i])
    else if (arg === '--set') {
      const [id, ...rest] = (argv[++i] ?? '').split('=')
      if (id && rest.length > 0) args.sessionConfig[id] = rest.join('=')
    } else positional.push(arg)
  }
  if (positional.length > 0) args.prompt = positional.join(' ')
  return args
}

function format(env: RunEventEnvelope): string {
  const e: RunEvent = env.event
  switch (e.type) {
    case 'session':
      return `session         externalId=${e.externalId}`
    case 'message':
      return `message[${e.role}]  ${JSON.stringify(e.text).slice(0, 120)}`
    case 'thought':
      return `thought         ${JSON.stringify(e.text).slice(0, 120)}`
    case 'tool_call':
      return `tool_call       ${e.name ?? ''} status=${e.status ?? ''}`
    case 'usage':
      return `usage           ${e.model ?? ''} tokens=${JSON.stringify(e.tokens)}`
    case 'done':
      return `done            status=${e.status} reason=${e.reason ?? ''}`
    default:
      return `${(e as { type: string }).type}`
  }
}

/** A reply that is one JSON object with an `error` key is a refusal relayed
 * as prose, not an answer. Anything that does not parse is an answer. */
function looksLikeErrorReply(reply: string): boolean {
  const trimmed = reply.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown }
    return parsed !== null && typeof parsed === 'object' && 'error' in parsed
  } catch {
    return false
  }
}

async function smokeOne(target: { label: string; commandName: string; args: string[]; entry?: RuntimeCatalogEntry }, opts: Args): Promise<boolean> {
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'acp-smoke-'))
  const runId = randomUUID()
  console.log(`\n[smoke] runtime:  ${target.label}`)
  console.log(`[smoke] command:  ${target.commandName}${target.args.length ? ' ' + target.args.join(' ') : ''}`)
  console.log(`[smoke] cwd:      ${cwd}`)
  console.log(`[smoke] prompt:   ${JSON.stringify(opts.prompt)}`)
  if (opts.identity) console.log(`[smoke] identity: ${target.entry?.homeStrategy ?? 'none'}`)

  const t0 = Date.now()
  try {
    const common = {
      binaryPath: target.commandName,
      args: target.args,
      cwd,
      text: opts.prompt,
      runId,
      turnTimeoutMs: opts.timeout,
      permissionMode: 'auto' as const,
      sessionConfig: Object.keys(opts.sessionConfig).length > 0 ? opts.sessionConfig : undefined,
    }
    const result = opts.identity
      ? await sendTurnWithIdentity({
          ...common,
          agentId: 'smoke',
          conversationId: runId,
          enabledSkills: [],
          homeStrategy: target.entry?.homeStrategy ?? 'none',
        })
      : await sendTurn(common)
    const elapsed = Date.now() - t0
    console.log(`[smoke] agent:    ${result.agentName}`)
    console.log(`[smoke] session:  ${result.sessionId ?? '(none)'}`)
    console.log(`[smoke] elapsed:  ${elapsed}ms`)
    const missingSkills = (result as { missingSkills?: string[] }).missingSkills ?? []
    if (missingSkills.length > 0) console.log(`[smoke] missing skills: ${missingSkills.join(', ')}`)
    for (const env of result.envelopes) console.log(`  seq=${String(env.seq).padStart(3, ' ')}  ${format(env)}`)
    const done = result.envelopes.find((e) => e.event.type === 'done')?.event
    const doneOk = done?.type === 'done' && done.status === 'ok'
    const reply = result.envelopes
      .filter((e) => e.event.type === 'message' && e.event.role === 'assistant')
      .map((e) => (e.event as { text: string }).text)
      .join('')
    const providerError = looksLikeErrorReply(reply)
    const ok = doneOk && !providerError
    console.log(`[smoke] reply:    ${JSON.stringify(reply).slice(0, 200)}`)
    console.log(`[smoke] verdict:  ${ok ? 'OK' : providerError ? 'FAILED — the reply is a provider error, not an answer' : 'FAILED'}`)
    return ok
  } catch (err) {
    console.log(`[smoke] verdict:  FAILED — ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const targets: Array<{ label: string; commandName: string; args: string[]; entry?: RuntimeCatalogEntry }> = []

  if (opts.command) {
    targets.push({ label: 'custom', commandName: opts.command, args: [] })
  } else if (opts.all) {
    for (const entry of RUNTIME_CATALOG) {
      const found = await resolveCommandPath(entry.detectCommand)
      if (!found) {
        console.log(`[smoke] ${entry.displayName}: ${entry.detectCommand} not on PATH — skipped`)
        continue
      }
      targets.push({ label: entry.displayName, commandName: catalogEntryCommandLine(entry), args: [], entry })
    }
  } else {
    const entry = catalogEntry(opts.runtime)
    if (!entry) {
      throw new Error(`Pass --runtime <${RUNTIME_CATALOG.map((e) => e.id).join('|')}>, --command "<cmd>", or --all.`)
    }
    targets.push({ label: entry.displayName, commandName: catalogEntryCommandLine(entry), args: [], entry })
  }

  if (targets.length === 0) throw new Error('Nothing to smoke: no catalog CLI is installed on this machine.')

  let failures = 0
  for (const target of targets) {
    if (!(await smokeOne(target, opts))) failures += 1
  }
  console.log(`\n[smoke] ${targets.length - failures}/${targets.length} passed`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
