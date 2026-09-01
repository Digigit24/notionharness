// Hermes ACP stdio seam — Pillar 3.1 of the NotionForge roadmap.
//
// Spawns the real `hermes-acp.exe` binary (the Hermes Agent running as an ACP
// stdio server, confirmed working via `hermes-acp --check`) and speaks the
// Agent Client Protocol over its child-process stdio via the official
// `@agentclientprotocol/sdk`. Normalises the agent's session-update stream
// into the canonical `RunEventEnvelope { runId, seq, event }` shape from
// `@/lib/run-events` (the merged-from-main contract that the daemon-ws and
// broker subsystems already consume — re-defining it here would make it a
// third shape and break their consumers). Every envelope carries a
// daemon-assigned monotonic `seq` so ordering is unambiguous even when the
// agent's notifications arrive in batched/parallel bursts (roadmap Pillar
// 3.1 — "batched inserts return unordered and this is the bug that silently
// scrambles transcripts").
//
// What this module is NOT: it is not a human-in-the-loop UI for permission
// requests (Pillar 5.4), and it is not a real Hermes-side terminal manager
// (the roadmap defers the bounded tail-buffer / process-group-kill work). For
// both, this seam installs the minimum default policies the agent can talk to
// so a real round-trip works end-to-end:
//   * permission requests → deny-once after a short timeout
//     (per roadmap 3.2: "timeout that denies *once* rather than cancelling
//     the turn")
//   * fs/read_text_file, fs/write_text_file → real local file I/O
//   * terminal/* → stub that lets the request resolve (real impl is later)
//
// Wired into the harness via `scripts/hermes-acp-smoke.ts` — that script
// round-trips one real prompt against the live binary and prints the events,
// proving the seam actually talks ACP, not a stub.
//
// Note for the lead's merge reconciliation: this branch was forked from
// 61b8608 (the auth/db/sandbox commit) before `lib/run-events.ts` existed on
// main. The import below will resolve cleanly on main after merge; locally
// the file isn't checked out yet.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

// `RunEvent` and `RunEventEnvelope` come from main's canonical contract at
// `lib/run-events.ts` (merged from a reconciliation task). The local
// worktree is behind main so the file isn't visible here — the lead wires
// it up at merge time, same as for the daemon-ws and broker consumers.
import type { RunEvent, RunEventEnvelope } from '@/lib/run-events'

// ---------------------------------------------------------------------------
// Public options.
// ---------------------------------------------------------------------------

export interface SendTurnOptions {
  /** Absolute path to the `hermes-acp` binary (or `hermes-acp.exe` on Windows). */
  binaryPath: string
  /** Working directory the agent should treat as its workspace root. */
  cwd: string
  /** The user prompt to send on this turn. */
  text: string
  /**
   * Stable identifier for this run. Stamped on every emitted
   * `RunEventEnvelope` so downstream consumers (broker, UI) can demux
   * concurrent runs over a single connection.
   */
  runId: string
  /** Extra environment merged into the child process environment. */
  env?: NodeJS.ProcessEnv
  /** Extra args passed to the binary. */
  args?: string[]
  /** Permission request timeout in ms — defaults to 50ms (smoke-harness tuned). */
  permissionTimeoutMs?: number
  /** Optional MCP server list forwarded to `session/new` (roadmap 3.2 §4). */
  mcpServers?: unknown[]
  /** Wall-clock cap for the whole turn in ms — defaults to 60s. */
  turnTimeoutMs?: number
}

export interface SendTurnResult {
  envelopes: RunEventEnvelope[]
  sessionId: string | null
  agentName: string
}

// ---------------------------------------------------------------------------
// Bridge: child-process stdio ↔ Web Streams (Node 18+ native).
// ---------------------------------------------------------------------------

function childStdioToStreams(child: ChildProcessWithoutNullStreams): {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
} {
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  child.once('exit', () => {
    try {
      readable.cancel()
    } catch {
      // already closed
    }
    try {
      writable.close()
    } catch {
      // already closed
    }
  })
  return { readable, writable }
}

function spawnBinary(opts: SendTurnOptions): {
  child: ChildProcessWithoutNullStreams
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
} {
  const child = spawn(opts.binaryPath, opts.args ?? [], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams
  // Hermes logs to stderr; the ACP protocol is on stdout. Surface stderr so
  // the harness can see what the agent is doing without blocking on it.
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[hermes-acp stderr] ${chunk.toString('utf8')}`)
  })
  return { child, ...childStdioToStreams(child) }
}

// ---------------------------------------------------------------------------
// Build the default client app with stubs for the request shapes the agent
// needs to talk to us.
// ---------------------------------------------------------------------------

function buildClientApp(permissionTimeoutMs: number) {
  return (
    client({ name: 'notionforge-harness' })
      // Roadmap 3.2: "timeout that denies *once* rather than cancelling the
      // turn." We respond with the `cancelled` *user-pick outcome* (NOT the
      // Cancel turn-stop outcome) so the agent sees a denial it can work
      // around, not a hard turn-kill.
      .onRequest('session/request_permission', async () => {
        await delay(permissionTimeoutMs)
        return { outcome: { outcome: 'cancelled' as const } }
      })
      .onRequest('fs/read_text_file', async (ctx) => {
        const { readFile } = await import('node:fs/promises')
        const path = (ctx.params as { path?: string }).path
        if (!path) return { content: '' }
        try {
          return { content: await readFile(path, 'utf8') }
        } catch {
          return { content: '' }
        }
      })
      .onRequest('fs/write_text_file', async (ctx) => {
        const { writeFile } = await import('node:fs/promises')
        const params = ctx.params as { path?: string; content?: string }
        if (params.path) await writeFile(params.path, params.content ?? '', 'utf8')
        return {}
      })
      .onRequest('terminal/create', async () => ({
        terminalId: `term_${Math.random().toString(36).slice(2, 10)}`,
      }))
      .onRequest('terminal/output', async () => ({ output: '', truncated: false, exitStatus: null }))
      .onRequest('terminal/release', async () => ({}))
      .onRequest('terminal/kill', async () => ({}))
      .onRequest('terminal/wait_for_exit', async () => ({ exitCode: null, signal: null }))
  )
}

// ---------------------------------------------------------------------------
// ACP session/update normalisation → RunEvent. Returns null when the update
// has no roadmap-level equivalent (UI hints, command lists, etc.).
// ---------------------------------------------------------------------------

function extractTextContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const c of content) {
    if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
      const t = (c as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  if (parts.length === 0) return null
  return parts.join('')
}

function extractToolInput(u: { [k: string]: unknown }): unknown {
  if ('rawInput' in u) return u.rawInput
  if ('input' in u) return u.input
  return null
}

function normaliseToolStatus(
  s: unknown,
): 'pending' | 'in_progress' | 'completed' | 'failed' | null {
  switch (s) {
    case 'pending':
    case 'in_progress':
    case 'completed':
    case 'failed':
      return s
    default:
      return null
  }
}

function isToolErrorContent(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false
  return (c as { type?: string }).type === 'error'
}

function normaliseSessionUpdate(update: unknown): RunEvent | null {
  if (!update || typeof update !== 'object') return null
  const u = update as { sessionUpdate?: string; [key: string]: unknown }
  const kind = u.sessionUpdate
  switch (kind) {
    case 'agent_message_chunk': {
      const text = extractTextContent(u.content)
      if (text === null) return null
      return { type: 'message', role: 'assistant', text }
    }
    case 'user_message_chunk': {
      const text = extractTextContent(u.content)
      if (text === null) return null
      return { type: 'message', role: 'user', text }
    }
    case 'agent_thought_chunk': {
      const text = extractTextContent(u.content)
      if (text === null) return null
      return { type: 'thought', text }
    }
    case 'tool_call': {
      const id = String(u.toolCallId ?? '')
      const name = String((u.title as string | undefined) ?? 'unknown')
      return {
        type: 'tool_call',
        id,
        name,
        input: extractToolInput(u),
        status: 'pending',
      }
    }
    case 'tool_call_update': {
      const id = String(u.toolCallId ?? '')
      const status = normaliseToolStatus(u.status)
      const content = u.content
      if (Array.isArray(content) && content.length > 0) {
        const isError = content.some(isToolErrorContent)
        return {
          type: 'tool_result',
          id,
          output: content,
          isError,
        }
      }
      if (status) {
        return {
          type: 'tool_call',
          id,
          name: String((u.title as string | undefined) ?? ''),
          input: extractToolInput(u),
          status,
        }
      }
      return null
    }
    case 'usage_update': {
      const usage = u.usage as
        | {
            provider?: string
            model?: string
            inputTokens?: number
            outputTokens?: number
            totalTokens?: number
            cost?: { ticks?: number }
          }
        | undefined
      return {
        type: 'usage',
        provider: usage?.provider ?? null,
        model: usage?.model ?? null,
        tokens:
          usage?.inputTokens !== undefined || usage?.outputTokens !== undefined
            ? {
                input: usage?.inputTokens ?? 0,
                output: usage?.outputTokens ?? 0,
                total: usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
              }
            : null,
        costTicks: usage?.cost?.ticks ?? null,
      }
    }
    case 'plan': {
      const text = Array.isArray(u.entries)
        ? (u.entries as Array<{ content?: string; title?: string }>)
            .map((e) => e.title ?? e.content ?? '')
            .filter(Boolean)
            .join('\n')
        : ''
      if (!text) return null
      return { type: 'thought', text }
    }
    case 'session_info_update': {
      const id = String((u.sessionId as string | undefined) ?? '')
      if (!id) return null
      return { type: 'session', externalId: id }
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Public seam: one-call "spawn + round-trip a single turn" entry point.
// ---------------------------------------------------------------------------

/**
 * Spawn the Hermes ACP binary, open a session, send one prompt, collect all
 * `RunEventEnvelope`s the agent emits until the turn ends, then tear the
 * process down. Suitable for the smoke harness and for one-shot CLI use; a
 * future task can layer long-lived multi-turn support on top of the same
 * building blocks (spawnBinary / buildClientApp / normaliseSessionUpdate).
 */
export async function sendTurn(opts: SendTurnOptions): Promise<SendTurnResult> {
  const turnTimeoutMs = opts.turnTimeoutMs ?? 60_000
  const { child, readable, writable } = spawnBinary(opts)
  const envelopes: RunEventEnvelope[] = []
  let seq = 0
  const allocSeq = () => {
    seq += 1
    return seq
  }
  const pushEvent = (event: RunEvent): void => {
    envelopes.push({ runId: opts.runId, seq: allocSeq(), event })
  }
  let pinnedSessionId: string | null = null
  let agentName = 'unknown'

  try {
    const stream = ndJsonStream(writable, readable)
    const app = buildClientApp(opts.permissionTimeoutMs ?? 50)

    const turnPromise = new Promise<void>((resolve, reject) => {
      void app.connectWith(stream, async (ctx) => {
        try {
          const init = await ctx.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: 'notionforge-harness', version: '0.1.0' },
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
          })
          agentName = init.agentInfo.name
          // Emit a session event with the agent's name first so the harness
          // sees "who" answered; then the real session id once newSession
          // resolves (roadmap 3.2 §1: pin immediately).
          pushEvent({ type: 'session', externalId: init.agentInfo.name })

          const newRes = await ctx.newSession({
            cwd: opts.cwd,
            mcpServers: (opts.mcpServers ?? []) as never,
          })
          pinnedSessionId = newRes.sessionId
          pushEvent({ type: 'session', externalId: newRes.sessionId })

          const sb = ctx.buildSession({ cwd: opts.cwd, mcpServers: (opts.mcpServers ?? []) as never })
          const active = await sb.start()
          await active.prompt(opts.text)
          for (;;) {
            const msg = await active.nextUpdate()
            if (msg.kind === 'stop') {
              const stop = (msg as { stopReason?: string }).stopReason ?? 'end_turn'
              pushEvent({
                type: 'done',
                status: stop === 'cancelled' ? 'cancelled' : 'ok',
                reason: stop,
              })
              break
            }
            const ev = normaliseSessionUpdate(msg.update)
            if (ev) pushEvent(ev)
          }
          resolve()
        } catch (err) {
          pushEvent({ type: 'done', status: 'error', reason: String(err) })
          reject(err)
        }
      })
    })

    // Wall-clock cap so a misbehaving agent can't hang the harness forever.
    let timedOut = false
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timedOut = true
        resolve()
      }, turnTimeoutMs)
      void t
    })
    await Promise.race([turnPromise, timeout])
    if (timedOut) {
      pushEvent({
        type: 'done',
        status: 'error',
        reason: `turn exceeded ${turnTimeoutMs}ms wall-clock cap`,
      })
    }
    await turnPromise.catch(() => {
      // Already recorded as `done: error` above; swallow.
    })

    return { envelopes, sessionId: pinnedSessionId, agentName }
  } finally {
    try {
      child.kill()
    } catch {
      // already gone
    }
  }
}
