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
import type { ApprovalOutcome, PermissionOption, RunEvent, RunEventEnvelope } from '@/lib/run-events'
import { TerminalBuffer } from './terminal-buffer'
import { buildSpawnEnv } from './spawn-env'
import { unifiedDiff } from './unified-diff'
import { redactError, redactSecrets } from '@/lib/redact'

// ---------------------------------------------------------------------------
// Public options.
// ---------------------------------------------------------------------------

/** Defined in the shared contract (`lib/run-events.ts`) and re-exported here
 * so long-standing imports keep resolving. One definition, two names. */
export type { ApprovalOutcome } from '@/lib/run-events'

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
  /** Kill the turn after this long with NO activity of any kind (no session
   * update, no client request). Defaults to 2 minutes, capped by
   * `turnTimeoutMs`. See the watchdog in `sendTurn` for why silence is a
   * better wedge signal than elapsed time. */
  inactivityTimeoutMs?: number
  /**
   * Called synchronously for every envelope the instant it's produced, in
   * the same `seq` order as the final `envelopes` array — additive, doesn't
   * change existing callers. Lets a real dispatcher append each event to
   * the broker's `run_messages` as it happens (roadmap: "streams into the
   * task's Activity tab in real time") instead of only ever seeing the
   * whole transcript after the turn already ended.
   */
  onEvent?: (envelope: RunEventEnvelope) => void
  /** Called once, as soon as the session exists, with handles for steering
   * the turn while it runs. Lets a caller (the dispatcher) register a stop
   * control that a user can hit mid-answer. */
  onControl?: (control: { cancel: () => Promise<void> }) => void
  /**
   * An ACP session id from a previous turn of this same conversation.
   *
   * When set and the agent's handshake advertises `loadSession`, this turn
   * calls `session/load` instead of `session/new`, so the agent replays its
   * own history and the prompt we send is just the new message. Without it
   * every turn is turn one: the agent has no memory of the conversation and
   * the only way to give it any would be to re-send the whole transcript in
   * the prompt, which grows without bound and costs tokens on every turn.
   *
   * A session id the agent no longer recognises is not an error — the turn
   * falls back to a fresh session, says so in the transcript, and returns
   * the new id so the caller can store it.
   */
  resumeSessionId?: string | null
}

export interface SendTurnResult {
  envelopes: RunEventEnvelope[]
  sessionId: string | null
  agentName: string
  /** True when this turn continued an existing agent-side session rather
   * than starting a new one. */
  resumed: boolean
  /** Set when a resume was asked for and did not happen, with the reason.
   * Never thrown — a forgotten session is a normal, recoverable state. */
  resumeFailure?: string
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
    // R3.8 — the agent's stderr is the single richest source of leaked
    // credentials: a failing provider call prints the request it made, and
    // this line writes it to a log that outlives the turn.
    process.stderr.write(`[hermes-acp stderr] ${redactSecrets(chunk.toString('utf8'))}`)
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

function settleTerminalExit(
  session: TerminalSessionState,
  status: TerminalExitStatus,
  emit?: { id: string; pushEvent: (event: RunEvent) => void },
): void {
  if (session.exitStatus) return // already settled (e.g. create-time failure)
  session.exitStatus = status
  // Emitted from here rather than from each `onExit` because this is the one
  // place every exit path converges — a normal exit, a spawn failure, and a
  // kill all settle through it, so no route can leave the block looking live.
  if (emit) {
    emit.pushEvent({
      type: 'terminal_exit',
      id: emit.id,
      exitCode: status.exitCode ?? null,
      signal: status.signal ?? null,
    })
  }
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
/** How long a single agent shell command may run before the harness kills it.
 * Generous — a build or a test suite legitimately takes minutes — but finite,
 * because an unbounded wait wedges the entire turn (see `onWaitForExit`). */
const TERMINAL_EXIT_TIMEOUT_MS = 5 * 60_000

/** Grace between a cooperative `session/cancel` and killing the process. */
const CANCEL_ESCALATION_MS = 5_000

/** How often the inactivity watchdog checks. Coarse on purpose — it is
 * measuring minutes of silence, so a fine-grained timer would buy nothing. */
const INACTIVITY_POLL_MS = 10_000

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

      // Logged because this is the one ACP call whose failure mode is a
      // silent hang rather than an error, and knowing exactly what the agent
      // asked to run is the difference between diagnosing it in one run and
      // guessing at it across several.
      console.log(
        `[acp] terminal/create ${id}: ${params.command} ${JSON.stringify(params.args ?? [])} (cwd=${params.cwd ?? options.defaultCwd})`,
      )
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
          settleTerminalExit(
            session,
            { exitCode: exitCode ?? null, signal: signalNumberToName(signal) },
            { id, pushEvent: options.pushEvent },
          )
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
        settleTerminalExit(session, { exitCode: 127, signal: null }, { id, pushEvent: options.pushEvent })
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
      // Bounded, because an unbounded wait here is a hang for the WHOLE
      // system, not just for one command: the agent blocks on this JSON-RPC
      // request, so it stops reading its own input, so `session/cancel` is
      // never processed either — the turn cannot be stopped, and the run
      // sits at "running" until the wall-clock turn cap kills the process
      // (observed live: a shell command with no result after 14 minutes,
      // then `ACP connection closed`). Killing the command and reporting a
      // real non-zero exit gives the agent something it can reason about
      // and recover from, which an infinite wait never does.
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          console.error(
            `[acp] terminal ${session.id} did not exit within ${TERMINAL_EXIT_TIMEOUT_MS}ms — killing it.`,
          )
          session.buffer.append(
            `
[harness] Command killed after ${Math.round(TERMINAL_EXIT_TIMEOUT_MS / 1000)}s with no exit.
`,
          )
          options.pushEvent({
            type: 'terminal',
            id: session.id,
            chunk: `
[harness] Command killed after ${Math.round(TERMINAL_EXIT_TIMEOUT_MS / 1000)}s with no exit.
`,
          })
          if (session.term) killTerminalProcess(session.term, 'SIGKILL')
          // Settle explicitly: on Windows in particular, `onExit` is not
          // guaranteed to fire for a pty killed this way, and a kill that
          // produced no exit event would leave this waiting again.
          settleTerminalExit(session, { exitCode: 124, signal: null }, { id: session.id, pushEvent: options.pushEvent })
        }, TERMINAL_EXIT_TIMEOUT_MS)
        timer.unref?.()
        session.exitWaiters.push((status) => {
          clearTimeout(timer)
          resolve({ exitCode: status.exitCode ?? null, signal: status.signal ?? null })
        })
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
  terminals: TerminalRegistry,
  pushEvent: (event: RunEvent) => void,
  touch: () => void,
  onSessionUpdate: (notification: { sessionId?: string; update?: unknown }) => void,
) {
  return (
    client({ name: 'notionforge-harness' })
      // Roadmap 3.2: "timeout that denies *once* rather than cancelling the
      // turn." We respond with the `cancelled` *user-pick outcome* (NOT the
      // Cancel turn-stop outcome) so the agent sees a denial it can work
      // around, not a hard turn-kill.
      .onRequest('session/request_permission', async (ctx) => {
        // Proof of life for the inactivity watchdog in `sendTurn`.
        touch()
        const params = ctx.params as {
          id?: string
          title?: string
          detail?: string
          options?: Array<{ optionId?: string; kind?: string; label?: string }>
        }
        // ACP does not guarantee an `id` on every request, but the transcript
        // needs a stable key to match the "settled" event back to the card it
        // resolves, so synthesize one when the agent omits it.
        const requestId = params.id || `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const options: PermissionOption[] = (params.options ?? []).map((option) => ({
          optionId: option.optionId ?? '',
          kind: option.kind ?? '',
          label: option.label,
        }))
        const title = params.title ?? 'Permission requested'
        const detail = params.detail ?? ''

        // Every permission request enters the transcript, in all three modes.
        // Under `auto` and `deny` it is a record of what the agent was
        // allowed or refused (previously invisible — a run could touch
        // anything and the transcript said nothing); under `ask` it is the
        // live card the human actually answers.
        pushEvent({ type: 'permission', id: requestId, title, detail, options })

        /** Records the decision in the same stream, so a card can never stay
         * interactive after the turn has moved past it. */
        const settle = (outcome: ApprovalOutcome) => {
          pushEvent({
            type: 'permission',
            id: requestId,
            title,
            detail,
            options,
            outcome: outcome.outcome,
            selectedOptionId: outcome.outcome === 'selected' ? outcome.optionId : undefined,
            reason: outcome.outcome === 'cancelled' ? outcome.reason : undefined,
          })
          return { outcome }
        }

        if (permissionMode === 'auto') {
          const allow =
            options.find((option) => option.kind === 'allow_once') ??
            options.find((option) => option.kind === 'allow_always')
          if (allow?.optionId) return settle({ outcome: 'selected', optionId: allow.optionId })
        }

        if (permissionMode === 'ask' && permissionCallback) {
          try {
            const result = await Promise.race([
              permissionCallback({ id: requestId, title, detail, options }),
              delay(permissionTimeoutMs).then(() => ({ outcome: 'cancelled' as const, reason: 'timeout' })),
            ])
            return settle(result)
          } catch {
            return settle({ outcome: 'cancelled', reason: 'callback error' })
          }
        }

        // `deny` (and `ask` with no callback wired) refuses rather than
        // stalling the turn: waiting out a timeout nobody is watching only
        // burns the turn budget before reaching the same answer.
        if (permissionMode === 'deny') return settle({ outcome: 'cancelled', reason: 'denied by policy' })

        await delay(permissionTimeoutMs)
        return settle({ outcome: 'cancelled', reason: 'timeout' })
      })
      .onRequest('fs/read_text_file', async (ctx) => {
        // Proof of life for the inactivity watchdog in `sendTurn`.
        touch()
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
        // Proof of life for the inactivity watchdog in `sendTurn`.
        touch()
        const { readFile, writeFile } = await import('node:fs/promises')
        const params = ctx.params as { path?: string; content?: string }
        if (!params.path) return {}
        const next = params.content ?? ''
        // Read the current contents first so the change can be recorded as a
        // real diff. `file_change` was already consumed in three places
        // (listReviewReadyRuns's "a diff ready to review", lanes.ts's
        // filesChanged/linesAdded stats, and now the transcript's diff view)
        // but nothing had ever emitted one, so all three were permanently
        // empty. A new file simply diffs against "".
        let previous = ''
        try {
          previous = await readFile(params.path, 'utf8')
        } catch {
          previous = ''
        }
        await writeFile(params.path, next, 'utf8')
        try {
          const diff = unifiedDiff(previous, next, params.path)
          // `null` means the write changed nothing — agents rewrite files
          // with identical content routinely, and a diff with no lines in it
          // is noise in the transcript and a false positive for
          // "review-ready".
          if (diff) pushEvent({ type: 'file_change', path: params.path, diff })
        } catch {
          // Recording the change must never be able to fail the write that
          // already succeeded.
        }
        return {}
      })
      .onRequest('terminal/create', async (ctx) => {
        touch()
        return terminals.onCreate(ctx.params)
      })
      .onRequest('terminal/output', async (ctx) => {
        touch()
        return terminals.onOutput(ctx.params)
      })
      .onRequest('terminal/release', async (ctx) => {
        touch()
        return terminals.onRelease(ctx.params)
      })
      .onRequest('terminal/kill', async (ctx) => {
        touch()
        return terminals.onKill(ctx.params)
      })
      .onRequest('terminal/wait_for_exit', async (ctx) => {
        touch()
        return terminals.onWaitForExit(ctx.params)
      })
      // We route `session/update` ourselves rather than through the SDK's
      // `ActiveSession`, for one concrete reason: `ActiveSession` can only be
      // built from a `session/new` response (its constructor is private and
      // `attachSession` is only reachable from the new-session path), so a
      // resumed session would have had no way to receive updates at all.
      // Registering here works for both paths because the SDK's own session
      // router returns `Handled.no`, leaving the notification to fall through
      // to registered handlers — verified in the SDK source, not assumed.
      .onNotification('session/update', async (ctx) => {
        touch()
        onSessionUpdate(ctx.params as { sessionId?: string; update?: unknown })
      })
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

/** ACP `ToolCall.locations` is `[{ path, line? }]`. Flattened to plain paths
 * because that is all the transcript shows, and kept defensively loose since
 * agents vary in whether they send objects or bare strings. */
function extractToolLocations(u: { [k: string]: unknown }): string[] | undefined {
  const raw = u.locations
  if (!Array.isArray(raw)) return undefined
  const paths: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) paths.push(entry)
    else if (entry && typeof entry === 'object') {
      const path = (entry as { path?: unknown }).path
      if (typeof path === 'string' && path.trim()) paths.push(path)
    }
  }
  return paths.length > 0 ? paths : undefined
}

function extractToolKind(u: { [k: string]: unknown }): string | undefined {
  const kind = u.kind
  return typeof kind === 'string' && kind.trim() ? kind : undefined
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

/** One-shot guard so the diagnostic below can't become a log flood. */
let usageShapeLogged = false

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
        locations: extractToolLocations(u),
        kind: extractToolKind(u),
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
          locations: extractToolLocations(u),
          kind: extractToolKind(u),
          input: extractToolInput(u),
          status,
        }
      }
      return null
    }
    case 'usage_update': {
      // Read both the nested (`update.usage.*`) and flat (`update.*`) shapes,
      // and both camelCase and snake_case names. The original read exactly one
      // of those and defaulted everything else, which is why 102 stored usage
      // rows were `unknown/unknown` at 0 tokens while the agent was
      // demonstrably spending: the notification was arriving and every single
      // field was missing its expected key. Being permissive here costs
      // nothing and is the difference between a real cost readout and a
      // permanent $0.00.
      const nested = (u.usage ?? {}) as Record<string, unknown>
      const pick = (...keys: string[]): unknown => {
        for (const key of keys) {
          if (nested[key] != null) return nested[key]
          if (u[key] != null) return u[key]
        }
        return undefined
      }
      const num = (value: unknown): number => {
        const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
        return Number.isFinite(n) ? n : 0
      }
      const str = (value: unknown): string | undefined =>
        typeof value === 'string' && value.trim() ? value : undefined

      const inputTokens = num(pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'))
      const outputTokens = num(pick('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'))
      const totalRaw = pick('totalTokens', 'total_tokens', 'tokens')
      const tokens = totalRaw != null ? num(totalRaw) : inputTokens + outputTokens

      // `cost` may be `{ ticks }`, a bare tick count, or a dollar amount.
      const costRaw = pick('cost', 'costTicks', 'cost_ticks', 'totalCost', 'total_cost')
      let costTicks = 0
      if (costRaw != null && typeof costRaw === 'object') {
        const obj = costRaw as Record<string, unknown>
        costTicks = obj.ticks != null ? num(obj.ticks) : Math.round(num(obj.amount ?? obj.usd ?? 0) * 100)
      } else if (costRaw != null) {
        const n = num(costRaw)
        // Ticks are integer hundredths. A fractional value is dollars.
        costTicks = Number.isInteger(n) ? n : Math.round(n * 100)
      }

      if (tokens === 0 && costTicks === 0 && !usageShapeLogged) {
        usageShapeLogged = true
        // One line, once per process: if this still yields nothing, the raw
        // payload is the only thing that can say why.
        console.log(`[acp] usage_update produced no numbers; raw payload: ${JSON.stringify(u).slice(0, 600)}`)
      }

      // Canonical `usage` RunEvent carries one total `tokens` count, not an
      // input/output breakdown — the breakdown isn't lost, ACP's own
      // `usage_update` notification is still available to anything that
      // subscribes to the raw stream directly.
      return {
        type: 'usage',
        provider: str(pick('provider', 'providerName', 'provider_name')) ?? 'unknown',
        model: str(pick('model', 'modelName', 'model_name', 'modelId', 'model_id')) ?? 'unknown',
        tokens,
        costTicks,
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
 * A one-producer/one-consumer queue for `session/update` notifications.
 *
 * Notifications arrive on the connection's own read loop and must never block
 * it, so they are enqueued synchronously; the turn drains them in order. The
 * queue is closed when the `session/prompt` response settles, and anything
 * already queued still drains before `next()` reports the end — dropping a
 * chunk that arrived microseconds before the stop would silently truncate the
 * last line of a reply.
 */
function createUpdateQueue<T>() {
  const items: T[] = []
  let waiter: ((value: T | null) => void) | null = null
  let closed = false
  return {
    push(item: T): void {
      if (closed) return
      if (waiter) {
        const resolve = waiter
        waiter = null
        resolve(item)
        return
      }
      items.push(item)
    },
    close(): void {
      if (closed) return
      closed = true
      if (waiter && items.length === 0) {
        const resolve = waiter
        waiter = null
        resolve(null)
      }
    },
    /** Resolves the next item, or `null` once the queue is closed and empty. */
    next(): Promise<T | null> {
      const item = items.shift()
      if (item !== undefined) return Promise.resolve(item)
      if (closed) return Promise.resolve(null)
      return new Promise<T | null>((resolve) => {
        waiter = resolve
      })
    },
  }
}

/**
 * Spawn the Hermes ACP binary, open a session, send one prompt, collect all
 * `RunEventEnvelope`s the agent emits until the turn ends, then tear the
 * process down. Suitable for the smoke harness and for one-shot CLI use; a
 * future task can layer long-lived multi-turn support on top of the same
 * building blocks (spawnBinary / buildClientApp / normaliseSessionUpdate).
 */
export async function sendTurn(opts: SendTurnOptions): Promise<SendTurnResult> {
  const turnTimeoutMs = opts.turnTimeoutMs ?? 60_000
  // Comfortably longer than the slowest thing that legitimately produces no
  // output — a cold model call, a big file read — and far shorter than the
  // wall-clock cap it sits inside.
  const inactivityTimeoutMs = opts.inactivityTimeoutMs ?? Math.min(120_000, turnTimeoutMs)
  // Set the moment the turn produces a terminal `done`, so the cancel
  // escalation below can tell "it stopped when asked" from "it ignored us".
  let turnSettled = false
  // Inactivity, not just total elapsed time. A wall-clock cap alone answers
  // the wrong question: a legitimately long run (a build, a big refactor) is
  // constantly emitting chunks, tool calls and client requests, while a
  // WEDGED one emits nothing at all — and only the wall clock could tell them
  // apart, so a wedge cost the full cap (10 minutes of a UI saying "Running…"
  // over a process that was never going to answer; observed live, twice).
  // Silence is the signal that actually distinguishes them.
  let lastActivityAt = Date.now()
  const touch = () => {
    lastActivityAt = Date.now()
  }
  const { child, readable, writable } = spawnBinary(opts)
  const envelopes: RunEventEnvelope[] = []
  let seq = 0
  const allocSeq = () => {
    seq += 1
    return seq
  }
  const pushEvent = (event: RunEvent): void => {
    lastActivityAt = Date.now()
    if (event.type === 'done') turnSettled = true
    const envelope = { runId: opts.runId, seq: allocSeq(), event }
    envelopes.push(envelope)
    opts.onEvent?.(envelope)
  }
  let pinnedSessionId: string | null = null
  let agentName = 'unknown'
  let resumed = false
  let resumeFailure: string | undefined

  // `session/load` makes the agent replay the whole conversation back to us
  // as ordinary `session/update` notifications. We already hold every one of
  // those in the broker — that is where they were stored the first time — so
  // replaying them into the transcript would duplicate the entire history on
  // every turn. Suppressed here rather than de-duplicated downstream, because
  // the replay is bounded and identifiable exactly once: while the load
  // request is in flight.
  let replaying = false
  // How much history the agent handed back during `session/load`. This is the
  // only reliable signal that a resume actually resumed something: Hermes
  // accepts a session id it never minted and reports success, so the load
  // response alone cannot distinguish a real session from a forgotten one.
  let replayedUpdates = 0
  const updates = createUpdateQueue<unknown>()
  const routeUpdate = (notification: { sessionId?: string; update?: unknown }): void => {
    if (replaying) {
      replayedUpdates += 1
      return
    }
    // Before the session exists there is nothing legitimate to receive; after
    // it does, anything for another session id is not ours.
    if (pinnedSessionId && notification.sessionId && notification.sessionId !== pinnedSessionId) return
    if (notification.update !== undefined) updates.push(notification.update)
  }

  const terminals = createTerminalRegistry({ defaultCwd: opts.cwd, defaultEnv: opts.env, pushEvent })

  try {
    const stream = ndJsonStream(writable, readable)
    const app = buildClientApp(
    opts.permissionTimeoutMs ?? 50,
    opts.permissionMode ?? 'ask',
    opts.permissionCallback,
    terminals,
    pushEvent,
    touch,
    routeUpdate,
  )

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
          // the generic `.request(method, params)`.
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

          // Resume when we can, start fresh when we can't. The capability is
          // read from this agent's own handshake rather than from a matrix we
          // maintain (D2) — an agent that does not implement `session/load`
          // must never be sent one.
          const wantsResume = typeof opts.resumeSessionId === 'string' && opts.resumeSessionId.length > 0
          const advertisesLoad =
            (init.agentCapabilities as { loadSession?: unknown } | undefined)?.loadSession === true
          if (wantsResume && !advertisesLoad) {
            resumeFailure = 'the agent does not advertise session/load'
          } else if (wantsResume) {
            const target = opts.resumeSessionId as string
            replaying = true
            try {
              await ctx.request('session/load', { sessionId: target, cwd: opts.cwd, mcpServers })
              // A successful response is NOT proof the session existed.
              // Measured against the real binary: Hermes accepts a session id
              // it never minted, answers `session/load` with success, and
              // resumes into an empty context — so trusting the response
              // would silently produce an agent with no memory and no
              // warning. What does distinguish them is the replay: a real
              // session hands back its history as `session/update`
              // notifications during the load (2 for a one-turn
              // conversation), a session the agent does not have hands back
              // nothing. That is the check.
              if (replayedUpdates === 0) {
                resumeFailure = 'the agent replayed no history for that session id'
              } else {
                pinnedSessionId = target
                resumed = true
              }
            } catch (err) {
              // The overwhelmingly common cause is an agent that has been
              // restarted and no longer holds the session. That is ordinary,
              // not a failure of the turn.
              resumeFailure = String(err instanceof Error ? err.message : err)
            } finally {
              replaying = false
            }
          }

          if (!resumed) {
            const created = (await ctx.request(
              'session/new',
              mcpServers.length > 0 ? { cwd: opts.cwd, mcpServers } : { cwd: opts.cwd, mcpServers: [] },
            )) as { sessionId: string }
            // Pin immediately once the session exists (roadmap 3.2 §1).
            pinnedSessionId = created.sessionId
          }
          const sessionId = pinnedSessionId as string
          pushEvent({ type: 'session', externalId: sessionId })
          if (wantsResume && !resumed) {
            // Said out loud in the transcript, because the alternative is an
            // agent that silently forgot everything and a person wondering
            // why it is asking questions already answered.
            pushEvent({
              type: 'message',
              role: 'system',
              text: `Could not continue the previous agent session (${resumeFailure ?? 'unknown reason'}). Started a new one, so the agent no longer has this conversation's earlier context.`,
            })
          }

          // Start the turn but DON'T await it before draining updates.
          // `prompt()` only settles once the whole turn is over, so awaiting
          // it first meant every `session/update` notification piled up
          // inside the SDK and the loop below drained the entire backlog at
          // once the moment the agent finished. Measured, not theorised:
          // instrumenting the dispatcher showed all ~90 chunks of a reply
          // arriving in the same millisecond, which is why the UI could only
          // ever reveal a response after it was already complete — Hermes
          // itself streams at real model speed the whole time (the CLI shows
          // exactly that), we simply weren't reading until it had finished.
          // Consuming updates concurrently with the in-flight prompt is what
          // makes token-speed streaming actually reach the browser.
          // Hand the caller a way to interrupt this turn while it's still
          // running. `session/cancel` is ACP's own cooperative stop: the
          // agent finishes what it's mid-way through, may emit a few final
          // updates, and then ends the turn with a `cancelled` stop reason
          // (which the loop below turns into a `done` event) — as opposed to
          // killing the process, which would strand the worktree and lose
          // whatever the agent had already produced.
          opts.onControl?.({
            cancel: async () => {
              try {
                await ctx.notify('session/cancel', { sessionId })
              } catch {
                // The pipe is already gone — nothing cooperative is possible,
                // so fall straight through to the escalation below.
              }
              // Cooperative cancel assumes the agent is in a position to read
              // the notification. An agent blocked inside a client request
              // that never returns (a wedged `terminal/wait_for_exit`, live
              // case) is not: it never processes the cancel, the turn never
              // ends, and Stop appears to do nothing at all. So the stop is
              // guaranteed rather than requested — ask nicely, then take the
              // process down if the turn has not ended shortly after.
              setTimeout(() => {
                if (turnSettled) return
                try {
                  child.kill()
                } catch {
                  // Already gone; the `finally` block reaps either way.
                }
              }, CANCEL_ESCALATION_MS).unref?.()
            },
          })

          const promptPromise = ctx.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: opts.text }],
          })
          // A rejection here is surfaced by the await after the loop; attach
          // a no-op catch now so it can never be an unhandled rejection in
          // the window before that await is reached. Closing the queue on
          // BOTH outcomes is what stops the drain loop below from waiting
          // forever on a turn that failed rather than finished.
          promptPromise.then(
            () => updates.close(),
            () => updates.close(),
          )

          for (;;) {
            const update = await updates.next()
            if (update === null) break
            const ev = normaliseSessionUpdate(update)
            if (ev) pushEvent(ev)
          }

          // The queue closed because the prompt settled, so this is already
          // resolved or rejected — awaited so a prompt-level failure still
          // propagates to the catch below rather than being swallowed.
          const stop = (await promptPromise) as { stopReason?: string }
          const stopReason = stop?.stopReason ?? 'end_turn'
          pushEvent({
            type: 'done',
            status: stopReason === 'cancelled' ? 'cancelled' : 'ok',
            reason: stopReason,
          })
          resolve()
        } catch (err) {
          pushEvent({ type: 'done', status: 'error', reason: redactError(err) })
          reject(err)
        }
      }).catch(() => {
        // Already surfaced via reject() above in the normal case; this only
        // absorbs a rejection from connectWith's OWN promise (e.g. the
        // transport closing after we abandon a hung turn), which resolve/
        // reject inside the callback never sees.
      })
    })

    // Two independent caps. The wall clock bounds the worst case; the
    // inactivity check catches a wedge far sooner, which is what actually
    // matters to someone watching the screen.
    let timedOut = false
    let timeoutReason = ''
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timedOut = true
        timeoutReason = `turn exceeded ${turnTimeoutMs}ms wall-clock cap`
        resolve()
      }, turnTimeoutMs)
      void t
    })
    const inactivity = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (turnSettled) {
          clearInterval(interval)
          return
        }
        const silentFor = Date.now() - lastActivityAt
        if (silentFor >= inactivityTimeoutMs) {
          clearInterval(interval)
          timedOut = true
          timeoutReason = `agent produced nothing for ${Math.round(silentFor / 1000)}s — treating the turn as wedged`
          resolve()
        }
      }, INACTIVITY_POLL_MS)
      interval.unref?.()
    })
    await Promise.race([turnPromise, timeout, inactivity])
    if (timedOut) {
      pushEvent({
        type: 'done',
        status: 'error',
        reason: timeoutReason,
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

    return { envelopes, sessionId: pinnedSessionId, agentName, resumed, resumeFailure }
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
