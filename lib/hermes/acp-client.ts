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
// requests (Pillar 5.4), and it is not the human-facing xterm/node-pty
// terminal workstream (D10 — that's a dedicated raw-byte socket, a wholly
// separate concern owned elsewhere; see `lib/terminal/pty-server.ts`). This
// seam installs the minimum default policies the agent can talk to so a real
// round-trip works end-to-end:
//   * permission requests → deny-once after a short timeout
//     (per roadmap 3.2: "timeout that denies *once* rather than cancelling
//     the turn")
//   * fs/read_text_file, fs/write_text_file → real local file I/O
//   * terminal/* → real `node-pty` sessions, bounded tail buffers, and
//     process-group kill (see `createTerminalRegistry` below) — this is the
//     ACP protocol's own "agent runs a shell command" capability, not D10's
//     human-facing terminal UI, but reuses the same already-vetted `node-pty`
//     dependency for proper PTY semantics.
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
import { constants as osConstants } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalExitStatus,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk'
import * as pty from 'node-pty'

// `RunEvent` and `RunEventEnvelope` come from main's canonical contract at
// `lib/run-events.ts` (merged from a reconciliation task). The local
// worktree is behind main so the file isn't visible here — the lead wires
// it up at merge time, same as for the daemon-ws and broker consumers.
import type { RunEvent, RunEventEnvelope } from '@/lib/run-events'
import { TerminalBuffer } from './terminal-buffer'
import { buildSpawnEnv } from './spawn-env'

// ---------------------------------------------------------------------------
// Public options.
// ---------------------------------------------------------------------------

/** ACP `outcome` union for permission callbacks — matches protocol schema. */
export type ApprovalOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled'; reason?: string }

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
  /**
   * Extra environment overlaid onto the spawned child's environment via
   * `buildSpawnEnv` (see `./spawn-env.ts`) — see `spawnBinary`/
   * `sendTurnWithIdentity`. The child does NOT inherit the full server
   * `process.env`; it gets `spawn-env.ts`'s allowlisted safe subset plus
   * whatever is explicitly set here. Typed as a plain string record, not
   * `NodeJS.ProcessEnv` itself: that interface requires `NODE_ENV` to be
   * present, which an arbitrary partial override (an agent's own
   * `customEnv` JSON field, for instance) has no reason to carry.
   */
  env?: Record<string, string | undefined>
  /** Extra args passed to the binary. */
  args?: string[]
  /** Permission request timeout in ms — defaults to 50ms (smoke-harness tuned). */
  permissionTimeoutMs?: number
  /** Agent permission policy. `ask` is deferred to the approvals UI (P5.4). */
  permissionMode?: 'ask' | 'auto' | 'deny'
  /**
   * Callback for `permissionMode === 'ask'`. When provided, the ACP
   * `session/request_permission` handler calls this instead of just timing
   * out, allowing a real pending approval to be created and waited on.
   * The result must match the ACP `outcome` union.
   */
  permissionCallback?: (params: {
    id: string
    title: string
    detail: string
    options: Array<{ optionId: string; kind: string; label?: string }>
  }) => Promise<ApprovalOutcome>
  /** Optional MCP server list forwarded to `session/new` (roadmap 3.2 §4). */
  mcpServers?: unknown[]
  /** Wall-clock cap for the whole turn in ms — defaults to 60s. */
  turnTimeoutMs?: number
  /**
   * Called synchronously for every envelope the instant it's produced, in
   * the same `seq` order as the final `envelopes` array — additive, doesn't
   * change existing callers. Lets a real dispatcher append each event to
   * the broker's `run_messages` as it happens (roadmap: "streams into the
   * task's Activity tab in real time") instead of only ever seeing the
   * whole transcript after the turn already ended.
   */
  onEvent?: (envelope: RunEventEnvelope) => void
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
    // `ReadableStream#cancel()`/`WritableStream#close()` are always async —
    // they return a Promise rather than throwing synchronously, even when
    // the stream is in a state that can't be cancelled/closed cleanly (e.g.
    // "locked" because the ACP SDK still holds an active reader on it after
    // we've abandoned the turn on timeout). A bare try/catch around a call
    // that never throws synchronously does nothing; the real rejection
    // surfaces later as an unhandled promise rejection, which crashed the
    // whole process the first time this path was actually exercised
    // (confirmed live: `ERR_INVALID_STATE: ReadableStream is locked`).
    try {
      readable.cancel().catch(() => {
        // already closed/locked — nothing more to do
      })
    } catch {
      // already closed
    }
    try {
      writable.close().catch(() => {
        // already closed/locked — nothing more to do
      })
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
    // `node:child_process`'s `SpawnOptions.env` is typed as `NodeJS.
    // ProcessEnv`, which (unlike our own `Record<string, string>`) requires
    // `NODE_ENV` to statically be present — `buildSpawnEnv` filters that key
    // through when it's actually set on the real `process.env`, so this cast
    // reflects an always-true runtime shape, not an unchecked assumption.
    env: buildSpawnEnv(opts.env) as NodeJS.ProcessEnv,
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
// Terminal registry: real ACP `terminal/*` session handling.
//
// This is the ACP protocol's own "agent runs a shell command" capability
// (`terminal/create`, `terminal/output`, `terminal/wait_for_exit`,
// `terminal/kill`, `terminal/release` — see `schema.CLIENT_METHODS.terminal`
// in the installed `@agentclientprotocol/sdk`), talked over the JSON-RPC
// event stream. It is NOT D10's human-facing xterm.js terminal (a dedicated
// raw-byte socket, never inside the JSON event protocol) — that's
// `lib/terminal/pty-server.ts`, a separate workstream. The two happen to
// share `node-pty` because it's the project's already-vetted, already-built
// (see its `prebuilds/`) way to get real PTY semantics instead of a bare
// pipe.
// ---------------------------------------------------------------------------

interface TerminalSessionState {
  id: string
  term: pty.IPty | null
  buffer: TerminalBuffer
  exitStatus: TerminalExitStatus | null
  exitWaiters: Array<(status: TerminalExitStatus) => void>
  disposeOnData: { dispose(): void } | null
  disposeOnExit: { dispose(): void } | null
}

/** Inverse of `os.constants.signals` (`{SIGTERM: 15, ...}` -> `{15: 'SIGTERM', ...}`).
 * node-pty's `onExit` reports the terminating signal as a POSIX signal
 * *number* (`{ exitCode: number, signal?: number }`), but ACP's
 * `TerminalExitStatus.signal` is a *name* string (e.g. `"SIGTERM"|null`) —
 * this bridges the two. */
const SIGNAL_NAME_BY_NUMBER: Record<number, string> = Object.fromEntries(
  Object.entries(osConstants.signals).map(([name, num]) => [num, name])
)

function signalNumberToName(signal: number | undefined): string | null {
  if (signal === undefined || signal === 0) return null
  return SIGNAL_NAME_BY_NUMBER[signal] ?? String(signal)
}

/**
 * Kills the whole process tree a terminal command spawned, not just the
 * immediate child.
 *
 * node-pty's own `UnixTerminal.kill()` only signals `pid` directly (see
 * `node_modules/node-pty/lib/unixTerminal.js`) — the process the pty forked.
 * A real shell command routinely spawns further children (`npm run build` ->
 * `node`, a `tsc --watch` daemon, ...) that outlive a naive single-pid kill
 * and keep running as orphans. The pty always makes its child the leader of
 * a brand-new session (`setsid`), and POSIX session leaders are also the
 * process-group leader of the group they create — so the child's `pid` IS
 * also that group's id, and signalling the *negative* pid reaches every
 * process in the group, not just the leader.
 *
 * Windows has no process-group/signal model to reach here: node-pty's
 * `WindowsTerminal.kill()` throws if given a signal at all, and its no-arg
 * kill already tears down the whole ConPTY agent process tree itself (see
 * `node_modules/node-pty/lib/windowsTerminal.js`, `_agent.kill()`). So on
 * win32 this just degrades to that no-arg kill rather than throwing.
 */
function killTerminalProcess(term: pty.IPty, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (process.platform === 'win32') {
    try {
      term.kill()
    } catch {
      // already gone
    }
    return
  }
  try {
    process.kill(-term.pid, signal)
  } catch {
    // Group already reaped, or we raced the child's own exit — fall back to
    // a direct signal so we at least ask the immediate process to stop.
    try {
      term.kill(signal)
    } catch {
      // already gone
    }
  }
}

function settleTerminalExit(session: TerminalSessionState, status: TerminalExitStatus): void {
  if (session.exitStatus) return // already settled (e.g. create-time failure)
  session.exitStatus = status
  const waiters = session.exitWaiters.splice(0)
  for (const resolve of waiters) resolve(status)
}

/**
 * Builds the live state (session map, id allocator) backing the ACP
 * `terminal/*` handlers registered in `buildClientApp`, plus a `disposeAll`
 * to reap any terminals the agent forgot to `terminal/release` when the turn
 * ends — otherwise a misbehaving/killed agent would leak child processes and
 * `onData`/`onExit` listeners across the life of the harness.
 */
function createTerminalRegistry(options: {
  defaultCwd: string
  defaultEnv?: Record<string, string | undefined>
  pushEvent: (event: RunEvent) => void
}) {
  const sessions = new Map<string, TerminalSessionState>()
  let nextSeq = 0
  const allocTerminalId = (): string => {
    nextSeq += 1
    return `term_${nextSeq}_${Math.random().toString(36).slice(2, 8)}`
  }

  function disposeSession(session: TerminalSessionState): void {
    session.disposeOnData?.dispose()
    session.disposeOnExit?.dispose()
  }

  return {
    async onCreate(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
      const id = allocTerminalId()
      const buffer = new TerminalBuffer(params.outputByteLimit ?? undefined)
      const session: TerminalSessionState = {
        id,
        term: null,
        buffer,
        exitStatus: null,
        exitWaiters: [],
        disposeOnData: null,
        disposeOnExit: null,
      }
      sessions.set(id, session)

      try {
        const env = buildSpawnEnv({
          ...options.defaultEnv,
          ...Object.fromEntries((params.env ?? []).map((entry) => [entry.name, entry.value])),
        })

        const term = pty.spawn(params.command, params.args ?? [], {
          name: 'xterm-256color',
          cwd: params.cwd ?? options.defaultCwd,
          env,
          cols: 80,
          rows: 24,
        })
        session.term = term
        session.disposeOnData = term.onData((chunk) => {
          buffer.append(chunk)
          // Roadmap: stream terminal output into the run's Activity tab as
          // it happens, same pattern as every other handler in this file
          // that turns an ACP happening into a `RunEvent` via `pushEvent`
          // (see `session/request_permission` above and `pushEvent` in
          // `sendTurn` below) — not just on-demand via `terminal/output`.
          options.pushEvent({ type: 'terminal', id, chunk })
        })
        session.disposeOnExit = term.onExit(({ exitCode, signal }) => {
          settleTerminalExit(session, {
            exitCode: exitCode ?? null,
            signal: signalNumberToName(signal),
          })
        })
      } catch (err) {
        // `pty.spawn` can throw synchronously (bad cwd, spawn failure).
        // `terminal/create`'s response shape has no room for an error — only
        // `terminalId` — so surface the failure the way a real shell would
        // (a message plus a non-zero exit) rather than rejecting the
        // JSON-RPC call. The agent discovers it via `terminal/output`'s
        // `exitStatus`/`output`, same as after any other command.
        const message = err instanceof Error ? err.message : String(err)
        buffer.append(`${message}\n`)
        options.pushEvent({ type: 'terminal', id, chunk: `${message}\n` })
        settleTerminalExit(session, { exitCode: 127, signal: null })
      }

      return { terminalId: id }
    },

    async onOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
      const session = sessions.get(params.terminalId)
      if (!session) return { output: '', truncated: false, exitStatus: null }
      return {
        output: session.buffer.output(),
        truncated: session.buffer.isTruncated(),
        exitStatus: session.exitStatus,
      }
    },

    async onWaitForExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
      const session = sessions.get(params.terminalId)
      if (!session) return { exitCode: null, signal: null }
      if (session.exitStatus) {
        return { exitCode: session.exitStatus.exitCode ?? null, signal: session.exitStatus.signal ?? null }
      }
      return new Promise((resolve) => {
        session.exitWaiters.push((status) => resolve({ exitCode: status.exitCode ?? null, signal: status.signal ?? null }))
      })
    },

    async onKill(params: KillTerminalRequest): Promise<KillTerminalResponse> {
      const session = sessions.get(params.terminalId)
      if (session?.term && !session.exitStatus) killTerminalProcess(session.term)
      return {}
    },

    async onRelease(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
      const session = sessions.get(params.terminalId)
      if (!session) return {}
      if (session.term && !session.exitStatus) killTerminalProcess(session.term)
      disposeSession(session)
      sessions.delete(params.terminalId)
      return {}
    },

    /** Reap every still-open terminal — called from `sendTurn`'s `finally`
     * alongside `child.kill()` so a turn that ends (normally, on timeout, or
     * on error) without the agent releasing its terminals doesn't leak
     * child processes or listeners past the life of the turn. */
    disposeAll(): void {
      for (const session of sessions.values()) {
        if (session.term && !session.exitStatus) killTerminalProcess(session.term)
        disposeSession(session)
      }
      sessions.clear()
    },
  }
}

type TerminalRegistry = ReturnType<typeof createTerminalRegistry>

// ---------------------------------------------------------------------------
// Build the default client app with stubs for the request shapes the agent
// needs to talk to us.
// ---------------------------------------------------------------------------

function buildClientApp(
  permissionTimeoutMs: number,
  permissionMode: 'ask' | 'auto' | 'deny',
  permissionCallback: SendTurnOptions['permissionCallback'],
  terminals: TerminalRegistry
) {
  return (
    client({ name: 'notionforge-harness' })
      // Roadmap 3.2: "timeout that denies *once* rather than cancelling the
      // turn." We respond with the `cancelled` *user-pick outcome* (NOT the
      // Cancel turn-stop outcome) so the agent sees a denial it can work
      // around, not a hard turn-kill.
      .onRequest('session/request_permission', async (ctx) => {
        if (permissionMode === 'auto') {
          const params = ctx.params as { options?: Array<{ optionId?: string; kind?: string }> }
          const allow = params.options?.find((option) => option.kind === 'allow_once') ??
            params.options?.find((option) => option.kind === 'allow_always')
          if (allow?.optionId) return { outcome: { outcome: 'selected' as const, optionId: allow.optionId } }
        }

        if (permissionMode === 'ask' && permissionCallback) {
          const params = ctx.params as {
            id?: string
            title?: string
            detail?: string
            options?: Array<{ optionId?: string; kind?: string; label?: string }>
          }
          try {
            const result = await Promise.race([
              permissionCallback({
                id: params.id ?? '',
                title: params.title ?? '',
                detail: params.detail ?? '',
                options: (params.options ?? []).map((o) => ({
                  optionId: o.optionId ?? '',
                  kind: o.kind ?? '',
                  label: o.label,
                })),
              }),
              delay(permissionTimeoutMs).then(() => ({ outcome: 'cancelled' as const, reason: 'timeout' })),
            ])
            return { outcome: result }
          } catch {
            return { outcome: { outcome: 'cancelled' as const, reason: 'callback error' } }
          }
        }

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
      .onRequest('terminal/create', async (ctx) => terminals.onCreate(ctx.params))
      .onRequest('terminal/output', async (ctx) => terminals.onOutput(ctx.params))
      .onRequest('terminal/release', async (ctx) => terminals.onRelease(ctx.params))
      .onRequest('terminal/kill', async (ctx) => terminals.onKill(ctx.params))
      .onRequest('terminal/wait_for_exit', async (ctx) => terminals.onWaitForExit(ctx.params))
  )
}

// ---------------------------------------------------------------------------
// ACP session/update normalisation → RunEvent. Returns null when the update
// has no roadmap-level equivalent (UI hints, command lists, etc.).
// ---------------------------------------------------------------------------

/** Live-verified against the real hermes-acp binary: a `ContentChunk`'s
 * `content` field is a SINGLE `ContentBlock` object (per the ACP schema's
 * `ContentChunk.content: allOf [ContentBlock]`), not an array — every
 * `agent_message_chunk`/`user_message_chunk`/`agent_thought_chunk` update
 * carries one text piece per notification, streamed incrementally. Handling
 * only the array shape silently dropped every real message (confirmed via
 * scripts/hermes-acp-smoke.ts: a real agent reply produced zero `message`
 * envelopes before this fix). Still accepts an array defensively in case a
 * future/other agent batches blocks. */
function extractTextContent(content: unknown): string | null {
  const blocks = Array.isArray(content) ? content : [content]
  const parts: string[] = []
  for (const c of blocks) {
    if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
      const t = (c as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  if (parts.length === 0) return null
  return parts.join('')
}

function extractToolInput(u: { [k: string]: unknown }): Record<string, unknown> {
  const raw = 'rawInput' in u ? u.rawInput : 'input' in u ? u.input : null
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
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
      // Canonical `usage` RunEvent carries one total `tokens` count, not an
      // input/output breakdown — the breakdown isn't lost, ACP's own
      // `usage_update` notification is still available to anything that
      // subscribes to the raw stream directly.
      return {
        type: 'usage',
        provider: usage?.provider ?? 'unknown',
        model: usage?.model ?? 'unknown',
        tokens: usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
        costTicks: usage?.cost?.ticks ?? 0,
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
    const envelope = { runId: opts.runId, seq: allocSeq(), event }
    envelopes.push(envelope)
    opts.onEvent?.(envelope)
  }
  let pinnedSessionId: string | null = null
  let agentName = 'unknown'

  const terminals = createTerminalRegistry({ defaultCwd: opts.cwd, defaultEnv: opts.env, pushEvent })

  try {
    const stream = ndJsonStream(writable, readable)
    const app = buildClientApp(opts.permissionTimeoutMs ?? 50, opts.permissionMode ?? 'ask', opts.permissionCallback, terminals)

    const turnPromise = new Promise<void>((resolve, reject) => {
      // `connectWith` returns its own promise, independent of our
      // resolve/reject calls inside the callback below. When we abandon a
      // hung turn on timeout and force the underlying streams closed (see
      // `childStdioToStreams`), the SDK's own connection object rejects its
      // internal pending state with "ACP connection closed" — confirmed
      // live, an unhandled rejection that crashed the process. `void` alone
      // discards the promise but does not attach a rejection handler.
      app.connectWith(stream, async (ctx) => {
        try {
          // `ClientContext` has no dedicated `.initialize()`/`.newSession()`
          // methods — confirmed against the installed SDK's own type
          // declarations and its `examples/client.js`. Requests go through
          // the generic `.request(method, params)`, and session creation is
          // handled by `buildSession(...).start()`, which returns an
          // `ActiveSession` already carrying `sessionId` — no separate
          // `session/new` round-trip needed.
          const init = await ctx.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: 'notionforge-harness', version: '0.1.0' },
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
          })
          // `agentInfo` is nullable per the ACP schema ("in future versions
          // of the protocol, this will be required").
          agentName = init.agentInfo?.name ?? 'unknown'
          pushEvent({ type: 'session', externalId: agentName })

          const mcpServers = (opts.mcpServers ?? []) as never[]
          const sb = mcpServers.length > 0 ? ctx.buildSession({ cwd: opts.cwd, mcpServers }) : ctx.buildSession(opts.cwd)
          const active = await sb.start()
          // Pin immediately once the session exists (roadmap 3.2 §1).
          pinnedSessionId = active.sessionId
          pushEvent({ type: 'session', externalId: active.sessionId })

          await active.prompt(opts.text)
          for (;;) {
            const msg = await active.nextUpdate()
            if (msg.kind === 'stop') {
              pushEvent({
                type: 'done',
                status: msg.stopReason === 'cancelled' ? 'cancelled' : 'ok',
                reason: msg.stopReason,
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
      }).catch(() => {
        // Already surfaced via reject() above in the normal case; this only
        // absorbs a rejection from connectWith's OWN promise (e.g. the
        // transport closing after we abandon a hung turn), which resolve/
        // reject inside the callback never sees.
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
      // Do NOT await turnPromise here — it lost the race, which means
      // whatever it's doing (most often `active.nextUpdate()` blocked on a
      // stream from a child process that already died without the ACP SDK
      // detecting stream closure) may never settle. Awaiting it turned every
      // timeout into a permanent hang: the `finally` block's `child.kill()`
      // never ran, so the process was never even reaped, let alone the
      // caller (the dispatcher's HTTP request) ever getting a response.
      // Attach a catch without awaiting so a late rejection doesn't surface
      // as an unhandled promise rejection, but let this function return now.
      turnPromise.catch(() => {})
    } else {
      // turnPromise won the race and has already settled — this only
      // drains a rejection it already produced, never blocks.
      await turnPromise.catch(() => {
        // Already recorded as `done: error` above; swallow.
      })
    }

    return { envelopes, sessionId: pinnedSessionId, agentName }
  } finally {
    // Reap any terminals the agent never got around to `terminal/release`ing
    // (a hung/killed turn, an agent bug) so their child processes and
    // onData/onExit listeners don't outlive this turn.
    terminals.disposeAll()
    try {
      child.kill()
    } catch {
      // already gone
    }
  }
}
