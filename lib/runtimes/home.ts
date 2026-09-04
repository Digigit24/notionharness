// Runtime home materialisation: giving an agent its identity, whatever CLI
// is behind it.
//
// A personality in this app is four things — instructions, memory, enabled
// skills, and a model preference — and all four are OUR data, stored in our
// database, portable across runtimes. This module is where that data becomes
// something a specific CLI can actually read.
//
// The mechanism was already here, unnamed: the Hermes home overlay builds a
// disposable directory, links in that agent's own memories and skills, and
// points the spawned process at it through an environment variable. That is
// not a Hermes idea. Verified on this machine, Claude Code relocates its home
// with `CLAUDE_CONFIG_DIR` and Codex with `CODEX_HOME`, and both keep a
// `skills/<name>/` pool with the same shape. So the pattern generalises to a
// strategy per runtime rather than a rewrite.
//
// The honest limit, worth stating rather than discovering later: Codex keeps
// memory and session state in SQLite at its home root rather than in
// per-agent files, so isolating agents there means a whole home per agent
// instead of selective links. That is a different strategy, not a broken one,
// which is exactly why this is an interface.
import { supportsModelSelection, type AgentHandshake } from './detect'

export interface RuntimeHomeRequest {
  /** Disambiguates this run's disposable directory. */
  runId: string
  agentId: string | number
  /** Shards per-conversation state where the runtime has any. */
  conversationId: string | number
  /** Skill names this agent has enabled, from our database. */
  enabledSkills: string[]
  /** An existing home to inherit config and credentials from, when the
   * runtime has such a concept and the user chose one. */
  baseHome?: string
}

export interface RuntimeHomeResult {
  /** Environment to merge into the spawn. Empty when the runtime has no home. */
  env: Record<string, string>
  /** Enabled skills that were not found in the pool. Surfaced, never dropped
   * silently — an agent quietly missing a skill is worse than a warning. */
  missingSkills: string[]
  /** Removes only what this call created. Always called, even on failure. */
  cleanup: () => Promise<void>
}

export interface RuntimeHomeStrategy {
  /** Matches `runtime_profiles.protocolFamily` plus an agent label; the
   * registry falls back to `none` for anything unrecognised. */
  id: string
  /** Human name for the settings UI. */
  label: string
  materialise(request: RuntimeHomeRequest): Promise<RuntimeHomeResult>
}

/**
 * The honest fallback for a runtime with no relocatable home.
 *
 * It does not pretend: no memory directory, no skills pool, no per-conversation
 * state. The agent still gets its instructions, because those go into the
 * prompt rather than onto disk, so a personality degrades to "instructions
 * only" rather than to nothing. Reporting the enabled skills as missing is
 * deliberate — the caller can then say so instead of the user wondering why a
 * skill never fired.
 */
export const noHomeStrategy: RuntimeHomeStrategy = {
  id: 'none',
  label: 'No agent home',
  async materialise(request) {
    return {
      env: {},
      missingSkills: [...request.enabledSkills],
      cleanup: async () => {},
    }
  },
}

const strategies = new Map<string, RuntimeHomeStrategy>([[noHomeStrategy.id, noHomeStrategy]])

/** Runtimes register themselves; the core never imports a runtime package. */
export function registerRuntimeHomeStrategy(strategy: RuntimeHomeStrategy): void {
  strategies.set(strategy.id, strategy)
}

export function getRuntimeHomeStrategy(id: string | null | undefined): RuntimeHomeStrategy {
  return (id ? strategies.get(id) : undefined) ?? noHomeStrategy
}

/**
 * Whether this runtime lets us choose a model, answered from its own probe
 * rather than from a matrix we maintain.
 *
 * Three answers, not two. `unknown` means the runtime has not been probed,
 * which is genuinely different from "it told us it cannot" — a control hidden
 * because nobody asked yet is a lie.
 *
 * This used to read `availableModels` off the `initialize` response. That
 * field does not exist in the ACP schema, so it was always absent and this
 * function always said `runtime-settings` — including for runtimes that
 * offer a perfectly good model picker. Model choice lives in `session/new`'s
 * self-describing `configOptions`, which the probe now collects.
 *
 * - `protocol`: the runtime declares a model option we can set over ACP.
 * - `runtime-settings`: probed, but it chooses its own model (Hermes, whose
 *   model comes from the profile's config.yaml).
 * - `unknown`: not probed yet.
 */
export function modelSelectionSupport(
  handshake: AgentHandshake | null | undefined,
): 'protocol' | 'runtime-settings' | 'none' | 'unknown' {
  if (!handshake) return 'unknown'
  const supported = supportsModelSelection(handshake)
  if (supported === undefined) return 'unknown'
  return supported ? 'protocol' : 'runtime-settings'
}
