// ROADMAP P3.4 — composes the HERMES_HOME overlay (`./home-overlay.ts`) with
// the ACP stdio seam (`./acp-client.ts`, Pillar 3.1/3.2) so a caller gets
// one call that runs a turn under the correct per-agent identity and always
// cleans up its disposable task directory afterward, success or failure.
// (The dispatcher-wiring task also added `onEvent` live streaming and
// relaxed `env`'s type on `acp-client.ts` — additive, no behavior change to
// existing callers.)
import { sendTurn, type SendTurnOptions, type SendTurnResult } from './acp-client'
import { buildHermesHomeOverlay, type BuildHermesHomeOverlayOptions } from './home-overlay'

export type SendTurnWithIdentityOptions = Omit<SendTurnOptions, 'env'> &
  Pick<BuildHermesHomeOverlayOptions, 'agentId' | 'conversationId' | 'enabledSkills'> &
  Pick<BuildHermesHomeOverlayOptions, 'baseHermesHome' | 'agentMemoryRoot' | 'conversationStateRoot' | 'taskRoot'> & {
    env?: Record<string, string | undefined>
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
      mcpServers: opts.mcpServers,
      turnTimeoutMs: opts.turnTimeoutMs,
      onEvent: opts.onEvent,
      env: { ...process.env, ...opts.env, HERMES_HOME: overlay.homeDir },
    })
    return { ...result, missingSkills: overlay.missingSkills, hardlinkFallbackFor: overlay.hardlinkFallbackFor }
  } finally {
    await overlay.cleanup()
  }
}
