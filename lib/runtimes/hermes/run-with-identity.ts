// ROADMAP P3.4 — composes the HERMES_HOME overlay (`./home-overlay.ts`) with
// the ACP stdio seam (`./acp-client.ts`, Pillar 3.1/3.2) so a caller gets
// one call that runs a turn under the correct per-agent identity and always
// cleans up its disposable task directory afterward, success or failure.
// (The dispatcher-wiring task also added `onEvent` live streaming and
// relaxed `env`'s type on `acp-client.ts` — additive, no behavior change to
// existing callers.)
import { sendTurn, type SendTurnOptions, type SendTurnResult } from '@/lib/hermes/acp-client'
import { buildHermesHomeOverlay, type BuildHermesHomeOverlayOptions } from './home-overlay'

export type SendTurnWithIdentityOptions = Omit<SendTurnOptions, 'env'> &
  Pick<BuildHermesHomeOverlayOptions, 'agentId' | 'conversationId' | 'enabledSkills'> &
  Pick<BuildHermesHomeOverlayOptions, 'baseHermesHome' | 'agentMemoryRoot' | 'conversationStateRoot' | 'taskRoot'> & {
    env?: Record<string, string | undefined>
    /** Which runtime home strategy materialises this agent's identity. See
     * `lib/runtimes/home.ts`. Defaults to Hermes because that is what this
     * function has always done; a runtime answering 'none' gets no home and
     * carries its personality in the prompt instead. */
    homeStrategy?: string
  }

export interface SendTurnWithIdentityResult extends SendTurnResult {
  /** Enabled skill names that weren't found in the shared skill pool — surface these, don't drop them silently. */
  missingSkills: string[]
  /**
   * Paths where a hardlink substituted for an unavailable real file symlink
   * (unprivileged Windows). Informational — a caller building an
   * ops/diagnostics view may want to know a given run's `state.db` link
   * would go stale if Hermes ever replaced the file wholesale rather than
   * writing in place.
   */
  hardlinkFallbackFor: string[]
}

/**
 * Build this run's HERMES_HOME overlay, run one turn under it via `sendTurn`,
 * and always tear the disposable overlay directory down afterward — the
 * persistent per-agent memories/ store and per-conversation state.db survive
 * regardless of how the turn ends.
 */
export async function sendTurnWithIdentity(opts: SendTurnWithIdentityOptions): Promise<SendTurnWithIdentityResult> {
  // A runtime that declares no home gets none, and says which skills it
  // therefore could not load rather than failing or pretending.
  if ((opts.homeStrategy ?? 'hermes') === 'none') {
    const result = await sendTurn({ ...opts, env: opts.env })
    const declaredSkills = Array.isArray(opts.enabledSkills) ? opts.enabledSkills.map(String) : []
    return { ...result, missingSkills: declaredSkills, hardlinkFallbackFor: [] }
  }

  const overlay = await buildHermesHomeOverlay({
    runId: opts.runId,
    agentId: opts.agentId,
    conversationId: opts.conversationId,
    enabledSkills: opts.enabledSkills,
    baseHermesHome: opts.baseHermesHome,
    agentMemoryRoot: opts.agentMemoryRoot,
    conversationStateRoot: opts.conversationStateRoot,
    taskRoot: opts.taskRoot,
  })

  try {
    const result = await sendTurn({
      binaryPath: opts.binaryPath,
      cwd: opts.cwd,
      text: opts.text,
      runId: opts.runId,
      args: opts.args,
      permissionTimeoutMs: opts.permissionTimeoutMs,
      permissionMode: opts.permissionMode,
      permissionCallback: opts.permissionCallback,
      mcpServers: opts.mcpServers,
      turnTimeoutMs: opts.turnTimeoutMs,
      onEvent: opts.onEvent,
      onControl: opts.onControl,
      resumeSessionId: opts.resumeSessionId,
      sessionConfig: opts.sessionConfig,
      autoAllowToolPrefixes: opts.autoAllowToolPrefixes,
      // Not `{ ...process.env, ...opts.env }` — `spawnBinary` (via
      // `buildSpawnEnv`) is the one place that decides what of the
      // server's own environment a spawned process inherits; passing a
      // raw `process.env` spread here would silently defeat that filter
      // by handing it to `spawnBinary` as an "explicit override" instead.
      env: { ...opts.env, HERMES_HOME: overlay.homeDir },
    })
    return { ...result, missingSkills: overlay.missingSkills, hardlinkFallbackFor: overlay.hardlinkFallbackFor }
  } finally {
    await overlay.cleanup()
  }
}
