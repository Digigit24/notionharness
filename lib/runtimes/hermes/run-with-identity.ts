// ROADMAP P3.4 — composes an agent's on-disk identity with the ACP stdio seam
// (`lib/acp/client.ts`) so a caller gets one call that runs a turn
// under the correct per-agent identity and always cleans up afterward,
// success or failure.
//
// Which identity, and how it reaches disk, is decided by the runtime
// profile's `homeStrategy` and resolved through the registry in
// `lib/runtimes/home.ts` — the Hermes overlay for Hermes, a linked home for
// any CLI that relocates through an environment variable (Claude Code, Codex,
// OpenCode — see `lib/runtimes/catalog.ts`), and no home at all for a runtime
// that has none. This used to branch on the literal string 'hermes' and treat
// everything else as 'none', which made every non-Hermes agent an agent with
// no skills, silently.
import { sendTurn, type SendTurnOptions, type SendTurnResult } from '@/lib/acp/client'
import { getRuntimeHomeStrategy } from '@/lib/runtimes/home'
// Side-effect import: registers every strategy the app ships. Without it the
// registry answers 'none' for every id — see that file's header.
import '@/lib/runtimes/registry'
import { buildHermesHomeOverlay, type BuildHermesHomeOverlayOptions } from './home-overlay'

export type SendTurnWithIdentityOptions = Omit<SendTurnOptions, 'env'> &
  Pick<BuildHermesHomeOverlayOptions, 'agentId' | 'conversationId' | 'enabledSkills'> &
  Pick<BuildHermesHomeOverlayOptions, 'baseHermesHome' | 'agentMemoryRoot' | 'conversationStateRoot' | 'taskRoot'> & {
    env?: Record<string, string | undefined>
    /** Which runtime home strategy materialises this agent's identity. See
     * `lib/runtimes/home.ts`. Defaults to Hermes because that is what this
     * function has always done; an unknown id resolves to 'none', and the
     * agent carries its personality in the prompt instead. */
    homeStrategy?: string
  }

export interface SendTurnWithIdentityResult extends SendTurnResult {
  /** Enabled skill names that weren't found in the runtime's skill pool — surface these, don't drop them silently. */
  missingSkills: string[]
  /**
   * Paths where a hardlink substituted for an unavailable real file symlink
   * (unprivileged Windows). Informational — a caller building an
   * ops/diagnostics view may want to know a given run's `state.db` link
   * would go stale if Hermes ever replaced the file wholesale rather than
   * writing in place. Only the Hermes overlay reports these; the generic
   * strategy links config files the same way but nothing downstream reads
   * the list for them.
   */
  hardlinkFallbackFor: string[]
}

/** Everything `sendTurn` takes, minus the identity-only fields this module consumes. */
function turnOptions(opts: SendTurnWithIdentityOptions, env: Record<string, string | undefined>): SendTurnOptions {
  return {
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
    inactivityTimeoutMs: opts.inactivityTimeoutMs,
    onEvent: opts.onEvent,
    onControl: opts.onControl,
    resumeSessionId: opts.resumeSessionId,
    sessionConfig: opts.sessionConfig,
    autoAllowToolPrefixes: opts.autoAllowToolPrefixes,
    authMethodId: opts.authMethodId,
    // Not `{ ...process.env, ...opts.env }` — `spawnBinary` (via
    // `buildSpawnEnv`) is the one place that decides what of the server's
    // own environment a spawned process inherits; passing a raw
    // `process.env` spread here would silently defeat that filter by
    // handing it to `spawnBinary` as an "explicit override" instead.
    env,
  }
}

/**
 * Materialise this run's identity for its runtime, run one turn under it via
 * `sendTurn`, and always tear the disposable overlay down afterward — the
 * persistent stores an overlay links out to (Hermes's per-agent memories and
 * per-conversation state.db, every CLI's real config and credentials)
 * survive regardless of how the turn ends.
 */
export async function sendTurnWithIdentity(opts: SendTurnWithIdentityOptions): Promise<SendTurnWithIdentityResult> {
  const strategyId = opts.homeStrategy ?? 'hermes'

  // Hermes keeps its own, richer path: it takes the profile home and the
  // memory/state roots that the generic contract has no words for.
  if (strategyId === 'hermes') {
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
      const result = await sendTurn(turnOptions(opts, { ...opts.env, HERMES_HOME: overlay.homeDir }))
      return { ...result, missingSkills: overlay.missingSkills, hardlinkFallbackFor: overlay.hardlinkFallbackFor }
    } finally {
      await overlay.cleanup()
    }
  }

  // Every other runtime: the registry decides. 'none' and any id nobody
  // registered resolve to the no-home strategy, which relocates nothing and
  // reports every enabled skill as missing rather than pretending.
  const strategy = getRuntimeHomeStrategy(strategyId)
  const home = await strategy.materialise({
    runId: opts.runId,
    agentId: opts.agentId,
    conversationId: opts.conversationId,
    enabledSkills: Array.isArray(opts.enabledSkills) ? opts.enabledSkills.map(String) : [],
  })
  try {
    const result = await sendTurn(turnOptions(opts, { ...opts.env, ...home.env }))
    return { ...result, missingSkills: home.missingSkills, hardlinkFallbackFor: [] }
  } finally {
    await home.cleanup()
  }
}
