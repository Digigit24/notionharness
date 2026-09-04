import { execFile } from 'node:child_process'
import { buildSpawnEnv } from './spawn-env'
import { checkHermesBashProbePatch } from './install-checks'

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

const PING_TIMEOUT_MS = 10_000

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
export async function pingAcpRuntime(commandName: string): Promise<RuntimePingResult> {
  const start = Date.now()
  // Runs alongside the spawn, not after it — a stat plus at most one file
  // read, so it never adds to the ping's wall-clock.
  const installCheck = checkHermesBashProbePatch()
  const result = await new Promise<RuntimePingResult>((resolve) => {
    execFile(
      commandName,
      ['--check'],
      { env: buildSpawnEnv() as NodeJS.ProcessEnv, timeout: PING_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - start
        if (error) {
          resolve({ ok: false, output: (stderr || error.message).trim(), durationMs })
          return
        }
        resolve({ ok: true, output: (stdout || stderr || '').trim(), durationMs })
      },
    )
  })
  // `--check` proves the binary imports and starts; it says nothing about
  // whether the first tool call will hang. Surface that here, where someone
  // pressing "Test connection" is actually looking.
  const check = await installCheck
  return check.ok ? result : { ...result, warning: check.detail }
}
