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
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSpawnEnv } from '@/lib/hermes/spawn-env'

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

/**
 * What the agent told us about itself during `initialize`.
 *
 * Stored verbatim rather than mapped into flags we maintain. A capability
 * matrix in our own code goes stale the moment a CLI ships a release, and
 * every entry in it is a claim we cannot verify. The handshake is the
 * agent's own answer, so it is right by construction.
 */
export interface AgentHandshake {
  agentName: string | null
  agentVersion: string | null
  protocolVersion: number | null
  /** Raw `agentCapabilities` from the response. Shape varies by agent. */
  capabilities: Record<string, unknown> | null
  authMethods: unknown[] | null
  /** Present on agents that expose selectable models. Absent means "cannot
   * choose", which is different from "we did not ask". */
  availableModels: unknown[] | null
  availableModes: unknown[] | null
  availableCommands: unknown[] | null
  /** When the probe ran, so staleness is visible. */
  probedAt: string
}

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
/**
 * Splits a stored command that carries its own arguments.
 *
 * Runtime profiles in the wild hold things like
 * `claude --dangerously-skip-permissions` in a single field, and spawning
 * that verbatim fails with ENOENT — reported as "not installed", which is the
 * wrong diagnosis entirely.
 *
 * Deliberately NOT a naive split on whitespace: Windows paths contain spaces
 * (`C:\Program Files\...`), and every real runtime on this machine is an
 * absolute path. So an existing file is always taken whole, and only a
 * non-existent path is treated as a command line.
 */
export function splitCommand(commandName: string, extraArgs: string[] = []): { command: string; args: string[] } {
  const trimmed = commandName.trim()
  if (!trimmed.includes(' ') || existsSync(trimmed)) return { command: trimmed, args: extraArgs }
  const [command, ...inline] = trimmed.split(/\s+/)
  return { command, args: [...inline, ...extraArgs] }
}

/**
 * Step one on its own: is this command actually runnable here?
 *
 * `spawn` without a shell does not consult PATHEXT on Windows, so a bare
 * `claude` fails with ENOENT even when `claude.cmd` sits on PATH — which the
 * probe would then report as "not installed", the wrong diagnosis for a
 * perfectly good install. Asking `where` (or `which`) first resolves that,
 * and it is also the honest shape of step one: presence is a separate
 * question from protocol.
 *
 * Returns the absolute path to spawn, or null when the command genuinely is
 * not here.
 */
export async function resolveCommandPath(command: string): Promise<string | null> {
  if (existsSync(command)) return command
  const finder = process.platform === 'win32' ? 'where' : 'which'
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(finder, [command], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    child.on('error', () => resolve(null))
    child.on('exit', (code) => {
      // `where` prints every match, one per line; the first is what would run.
      // `where` prints every match, and on Windows the FIRST is often an
      // extensionless shim that is not a real file (npm writes `claude`,
      // `claude.cmd` and `claude.ps1` side by side). Take the first line that
      // actually exists, or the probe reports a perfectly good install as
      // missing.
      const candidates = out
        .split(String.fromCharCode(10))
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => existsSync(line))
      // On Windows, npm installs three shims side by side — `claude`,
      // `claude.cmd` and `claude.ps1` — and `where` lists the extensionless
      // one first. That one is a shell script Node cannot execute, so taking
      // it verbatim produced ENOENT and a false "not installed" verdict on a
      // working install. Prefer a real executable, then a batch shim (which
      // the spawn below routes through the command processor), and only then
      // whatever is left.
      const rank = (path: string) => (/\.exe$/i.test(path) ? 0 : /\.(cmd|bat)$/i.test(path) ? 1 : 2)
      const best = candidates.sort((a, b) => rank(a) - rank(b))[0]
      resolve(code === 0 && best ? best : null)
    })
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      resolve(null)
    }, 5_000)
  })
}

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
      // with EINVAL or ENOENT. Route those through the command processor.
      const isBatchShim = /\.(cmd|bat)$/i.test(commandName)
      child = isBatchShim
        ? spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', commandName, ...args], {
            cwd,
            env: buildSpawnEnv() as NodeJS.ProcessEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })
        : spawn(commandName, args, {
            cwd,
            env: buildSpawnEnv() as NodeJS.ProcessEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
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
        if (message.id !== 1) continue
        if (message.error) {
          done(finish('acp_init_failed', message.error.message ?? 'The agent rejected initialize.'))
          return
        }
        const result = message.result ?? {}
        const agentInfo = (result.agentInfo ?? null) as { name?: string; version?: string } | null
        done(
          finish('ok', `Handshake complete with ${agentInfo?.name ?? 'an ACP agent'}.`, {
            agentName: agentInfo?.name ?? null,
            agentVersion: agentInfo?.version ?? null,
            protocolVersion:
              typeof result.protocolVersion === 'number' ? result.protocolVersion : null,
            capabilities:
              result.agentCapabilities && typeof result.agentCapabilities === 'object'
                ? (result.agentCapabilities as Record<string, unknown>)
                : null,
            authMethods: Array.isArray(result.authMethods) ? result.authMethods : null,
            availableModels: Array.isArray(result.availableModels) ? result.availableModels : null,
            availableModes: Array.isArray(result.availableModes) ? result.availableModes : null,
            availableCommands: Array.isArray(result.availableCommands) ? result.availableCommands : null,
            probedAt: new Date().toISOString(),
          }),
        )
        return
      }
    })

    child.on('exit', (code) => {
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

/**
 * Capability questions the UI asks, answered from the handshake.
 *
 * Each returns `undefined` for "the agent has not been probed", which is a
 * genuinely different answer from `false` ("it told us it cannot"). A control
 * hidden because nobody asked yet is a lie; a control hidden because the
 * agent said no is correct.
 */
export function supportsModelSelection(h: AgentHandshake | null): boolean | undefined {
  if (!h) return undefined
  return Array.isArray(h.availableModels) ? h.availableModels.length > 0 : undefined
}

export function supportsSessionLoad(h: AgentHandshake | null): boolean | undefined {
  if (!h?.capabilities) return undefined
  const value = (h.capabilities as { loadSession?: unknown }).loadSession
  return typeof value === 'boolean' ? value : undefined
}

export function supportedMcpTransports(
  h: AgentHandshake | null,
): { stdio?: boolean; http?: boolean; sse?: boolean } | undefined {
  if (!h?.capabilities) return undefined
  const mcp = (h.capabilities as { mcpCapabilities?: unknown }).mcpCapabilities
  return mcp && typeof mcp === 'object' ? (mcp as { stdio?: boolean; http?: boolean; sse?: boolean }) : undefined
}
