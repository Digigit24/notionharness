import { checkHermesBashProbePatch } from './install-checks'
import { probeAcpRuntime } from '@/lib/runtimes/detect'

export interface RuntimePingResult {
  ok: boolean
  output: string
  durationMs: number
  /** Which Hermes profile the test actually ran as ('' = install default).
   * Reported so "test connection" answers the question people really have —
   * *which* model just replied — instead of only whether something did. */
  profile?: string
  /** The provider/model that profile's own config.yaml pins. */
  provider?: string
  model?: string
  /** A passing ping with a known problem attached — e.g. the Hermes install
   * check failing even though the binary itself starts fine. */
  warning?: string
}


/**
 * "Test connection" for an agent's runtime profile — spawns the ACP binary
 * with `--check` ("Verify ACP dependencies and adapter imports, then exit",
 * per `hermes-acp --help`), confirmed live to exit fast (~0.5s) with "Hermes
 * ACP check OK" on success. This does NOT verify the agent's actual
 * configured AI provider/model works (that requires a real turn, which is
 * what a full run already does) — it only confirms the binary itself is
 * installed, importable, and runnable on this machine, which is the
 * narrower, safer thing a lightweight ping button should check.
 */
/**
 * "Test connection" for an agent's runtime.
 *
 * Now a real ACP handshake rather than Hermes's own `--check` flag, which
 * could only ever validate Hermes. `probeAcpRuntime` answers the two
 * questions separately — is the binary here, and does it speak the protocol —
 * and returns what the agent said about itself.
 *
 * The Hermes install check rides along because a green handshake still does
 * not mean the first tool call will work: a reverted stdin patch hangs it.
 */
export async function pingAcpRuntime(commandName: string): Promise<RuntimePingResult> {
  const installCheck = checkHermesBashProbePatch()
  const probe = await probeAcpRuntime(commandName)
  const check = await installCheck
  return {
    ok: probe.ok,
    output: probe.ok
      ? `${probe.detail}${probe.handshake?.agentVersion ? ` (v${probe.handshake.agentVersion})` : ''}`
      : `${probe.code}: ${probe.detail}`,
    durationMs: probe.durationMs,
    ...(check.ok ? {} : { warning: check.detail }),
  }
}
