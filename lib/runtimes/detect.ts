// Runtime detection: is this CLI here, and does it actually speak ACP?
//
// Two steps, deliberately reported separately, because they are two different
// problems with two different fixes. "The binary is not on this machine" is
// an install problem. "The binary exists but never completed a handshake" is
// a configuration or version problem. Collapsing them into one "unavailable"
// makes the user guess.
//
// Everything here is protocol-level. There is no Hermes in it, which is the
// point: registering a second ACP CLI should be data, not code. It replaces
// the previous check, which spawned the binary with Hermes's own `--check`
// flag and therefore could only ever validate Hermes.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSpawnEnv } from '@/lib/hermes/spawn-env'
import { batchShimInvocation, resolveCommandPath, splitCommand } from './spawn-command'
import type { AgentHandshake } from './handshake'

// Re-exported so every existing server-side import of these keeps resolving
// from here. They live in `./handshake.ts` because this file spawns processes
// and a client component that imported one helper from it would drag
// `node:child_process` into the browser bundle — which is not hypothetical:
// it broke the build exactly once, which is why the split exists.
export type { AgentHandshake, SessionConfigOption } from './handshake'
export {
  effectiveSessionConfigOptions,
  modelOption,
  sessionConfigOptions,
  sessionModes,
  supportedMcpTransports,
  supportsModelSelection,
  supportsSessionLoad,
} from './handshake'

/**
 * Machine-readable, translation-independent. A UI can map these to sentences
 * and a log can be grepped for them; a localised string can do neither.
 */
export type RuntimeProbeCode =
  | 'ok'
  | 'command_not_found'
  | 'spawn_failed'
  | 'acp_init_failed'
  | 'acp_init_timeout'
  // Never produced by `probeAcpRuntime` itself — the machine-mismatch check
  // in `probeRuntimeProfile` (settings/runtimes/actions.ts) short-circuits
  // before this function is ever called, precisely so a profile scoped to a
  // different machine (`lib/runtimes/host-id.ts`) never gets a real spawn
  // attempt made against it from the wrong one. Without that check this
  // would come back `command_not_found` — true in the narrowest sense (the
  // binary is not on THIS machine) and actively misleading, since it reads
  // like "go install it" rather than "you're looking at the wrong computer".
  | 'wrong_host'

export interface RuntimeProbeResult {
  code: RuntimeProbeCode
  ok: boolean
  /** One sentence for a human. Never the only signal — `code` is. */
  detail: string
  durationMs: number
  handshake: AgentHandshake | null
}

/** Long enough for a cold Python or Node start, short enough that a hung CLI
 * does not hang the request. AionUi's equivalent probe has no timeout at all
 * and their own docs record that it hangs forever when a CLI hangs. */
const PROBE_TIMEOUT_MS = 20_000

/** The follow-up `session/new` is optional detail, not the probe's verdict, so
 * it gets a much shorter budget than the handshake itself. */
const SESSION_PROBE_TIMEOUT_MS = 8_000

/** Must match the version `acp-client.ts` negotiates, or a successful probe
 * would not predict a successful run. */
const PROTOCOL_VERSION = 1

function jsonRpcLine(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
}

/**
 * Step one and step two, in one call.
 *
 * The handshake is spoken directly over stdio rather than through the ACP SDK
 * on purpose: this must be able to answer "does this unknown binary speak the
 * protocol" without the SDK's session machinery, retries or event plumbing
 * getting involved. It is a probe, not a client.
 */
// Command resolution is shared with the run path — see
// `./spawn-command.ts` for why that matters (the probe used to resolve
// correctly while `acp-client.ts` spawned the raw string, so a runtime could
// probe green and fail at ENOENT the first time it was used).
export { resolveCommandPath, resolveSpawnCommand, splitCommand } from './spawn-command'

export async function probeAcpRuntime(
  rawCommand: string,
  extraArgs: string[] = [],
): Promise<RuntimeProbeResult> {
  const split = splitCommand(rawCommand, extraArgs)
  const args = split.args
  const start = Date.now()
  const resolved = await resolveCommandPath(split.command)
  if (!resolved) {
    return {
      code: 'command_not_found',
      ok: false,
      detail: `${split.command} is not on this machine, or not on PATH.`,
      durationMs: Date.now() - start,
      handshake: null,
    }
  }
  const commandName = resolved
  // A throwaway cwd: an agent may create state on initialize, and it must not
  // land in a real workspace.
  const cwd = await mkdtemp(join(tmpdir(), 'nf-probe-'))

  const finish = (code: RuntimeProbeCode, detail: string, handshake: AgentHandshake | null = null) => ({
    code,
    ok: code === 'ok',
    detail,
    durationMs: Date.now() - start,
    handshake,
  })

  return new Promise<RuntimeProbeResult>((resolve) => {
    let settled = false
    const done = (result: RuntimeProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      void rm(cwd, { recursive: true, force: true }).catch(() => undefined)
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      // A Windows batch shim (`.cmd`/`.bat`, which is how npm installs a CLI)
      // is not an executable image — `spawn` cannot run it directly and fails
      // with EINVAL or ENOENT. Route those through the command processor,
      // quoted the one way `cmd /s /c` accepts (`batchShimInvocation`), so
      // the probe and the run path cannot disagree about a shim under a
      // directory with a space in its name.
      const invocation = /\.(cmd|bat)$/i.test(commandName)
        ? batchShimInvocation(commandName, args)
        : { command: commandName, args, viaShell: false, windowsVerbatimArguments: false }
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env: buildSpawnEnv() as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      })
    } catch (err) {
      void rm(cwd, { recursive: true, force: true }).catch(() => undefined)
      resolve(finish('spawn_failed', err instanceof Error ? err.message : String(err)))
      return
    }

    const timer = setTimeout(
      () =>
        done(
          finish(
            'acp_init_timeout',
            `No handshake within ${PROBE_TIMEOUT_MS / 1000}s. The binary started but never answered.`,
          ),
        ),
      PROBE_TIMEOUT_MS,
    )

    child.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT is the "not installed" case, and it deserves its own code so
      // the UI can say "install it" rather than "it did not respond".
      done(
        err.code === 'ENOENT'
          ? finish('command_not_found', `${commandName} is not on this machine.`)
          : finish('spawn_failed', err.message),
      )
    })

    // Held between the two round trips: `initialize` fills it, `session/new`
    // enriches it, and either path can be the one that finishes the probe.
    let pendingHandshake: AgentHandshake | null = null
    let sessionTimer: ReturnType<typeof setTimeout> | null = null
    const finishWithHandshake = () => {
      if (sessionTimer) {
        clearTimeout(sessionTimer)
        sessionTimer = null
      }
      if (!pendingHandshake) return
      const handshake = pendingHandshake
      pendingHandshake = null
      const who = handshake.agentName ?? 'an ACP agent'
      done(
        finish(
          'ok',
          handshake.authRequired
            ? `Handshake complete with ${who}, but it refused to open a session until this machine signs in.`
            : `Handshake complete with ${who}.`,
          handshake,
        ),
      )
    }

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000)
    })

    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      // ACP over stdio is newline-delimited JSON-RPC. Agents also print
      // non-JSON banner lines, so skip anything that does not parse rather
      // than failing the probe on noise.
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } }
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 1) {
          if (message.error) {
            done(finish('acp_init_failed', message.error.message ?? 'The agent rejected initialize.'))
            return
          }
          const result = message.result ?? {}
          const agentInfo = (result.agentInfo ?? null) as { name?: string; version?: string } | null
          pendingHandshake = {
            agentName: agentInfo?.name ?? null,
            agentVersion: agentInfo?.version ?? null,
            protocolVersion: typeof result.protocolVersion === 'number' ? result.protocolVersion : null,
            capabilities:
              result.agentCapabilities && typeof result.agentCapabilities === 'object'
                ? (result.agentCapabilities as Record<string, unknown>)
                : null,
            authMethods: Array.isArray(result.authMethods) ? result.authMethods : null,
            sessionConfigOptions: null,
            availableModes: null,
            currentModeId: null,
            availableCommands: Array.isArray(result.availableCommands) ? result.availableCommands : null,
            probedAt: new Date().toISOString(),
          }
          // A handshake alone cannot answer "which models does this runtime
          // offer", because ACP does not put that on `initialize` at all. It
          // arrives on `session/new`, so the probe opens one throwaway session
          // in its own temp directory to ask.
          //
          // Best-effort by design: a runtime that will not open a session here
          // is still a working runtime, and failing the probe because an
          // optional question went unanswered would repeat exactly the mistake
          // this replaced — reporting a capability from an assumption rather
          // than from the agent.
          child.stdin?.write(jsonRpcLine(2, 'session/new', { cwd, mcpServers: [] }))
          sessionTimer = setTimeout(finishWithHandshake, SESSION_PROBE_TIMEOUT_MS)
          sessionTimer.unref?.()
          continue
        }

        if (message.id === 2) {
          // An error here is ordinary — the agent may need auth, or may not
          // allow a session in an empty directory. The handshake still stands.
          // One error is worth recording by name: ACP's authentication-
          // required refusal (`-32000`), because its fix is a sign-in, not a
          // reinstall, and the UI can say exactly that.
          if (message.error && pendingHandshake) {
            const code = (message.error as { code?: unknown }).code
            const text = String(message.error.message ?? '')
            if (code === -32000 && /auth/i.test(text)) {
              pendingHandshake = { ...pendingHandshake, authRequired: true }
            }
          }
          if (!message.error && pendingHandshake) {
            const result = message.result ?? {}
            const modes = (result.modes ?? null) as
              | { currentModeId?: string; availableModes?: unknown[] }
              | null
            pendingHandshake = {
              ...pendingHandshake,
              // The session answered, so this is a real answer even when it
              // is empty: `[]` means "asked, declares none" (Hermes, whose
              // model comes from its profile's config.yaml) and `null` means
              // "never got that far". Collapsing the two would make a runtime
              // that genuinely offers no model choice indistinguishable from
              // one nobody has probed.
              sessionConfigOptions: Array.isArray(result.configOptions) ? result.configOptions : [],
              availableModes: Array.isArray(modes?.availableModes) ? modes.availableModes : null,
              currentModeId: typeof modes?.currentModeId === 'string' ? modes.currentModeId : null,
            }
          }
          finishWithHandshake()
        }
      }
    })

    child.on('exit', (code) => {
      // A process that exits after answering `initialize` but before answering
      // `session/new` still probed fine — take what we have rather than
      // reporting a working runtime as broken.
      if (pendingHandshake) {
        finishWithHandshake()
        return
      }
      // Exited before answering. The stderr tail is usually the real reason.
      done(
        finish(
          'acp_init_failed',
          `${commandName} exited with code ${code} before completing a handshake.${
            stderr ? ` ${stderr.trim().split('\n').slice(-2).join(' ')}` : ''
          }`,
        ),
      )
    })

    child.stdin?.write(
      jsonRpcLine(1, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'notionforge-harness', version: '0.1.0' },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      }),
    )
  })
}
