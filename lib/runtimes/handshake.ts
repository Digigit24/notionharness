// What a runtime said about itself, and the pure questions we ask of it.
//
// Deliberately separate from `./detect.ts`, and the separation is load-bearing
// rather than tidiness. `detect.ts` spawns processes, so it imports
// `node:child_process` and `node:fs/promises`; the moment a `'use client'`
// component imported one helper from it, webpack tried to bundle the whole
// spawn machinery for the browser and the build failed outright. R1.5 exists
// in the roadmap precisely because this was foreseeable.
//
// So: types and pure functions live here and are safe anywhere. Anything that
// touches a process lives in `./detect.ts`, which re-exports this file so
// existing server-side imports keep working unchanged.

/**
 * What the agent told us about itself during `initialize`, plus what it
 * declared when we opened a probe session.
 *
 * Stored verbatim rather than mapped into flags we maintain. A capability
 * matrix in our own code goes stale the moment a CLI ships a release, and
 * every entry in it is a claim we cannot verify. The handshake is the agent's
 * own answer, so it is right by construction.
 */
export interface AgentHandshake {
  agentName: string | null
  agentVersion: string | null
  protocolVersion: number | null
  /** Raw `agentCapabilities` from the response. Shape varies by agent. */
  capabilities: Record<string, unknown> | null
  authMethods: unknown[] | null
  /**
   * Self-describing settings the agent offers for a session, verbatim from
   * `session/new`.
   *
   * This is where model choice actually lives. An earlier version read
   * `availableModels` off the `initialize` response, which was written from an
   * assumption about the protocol rather than from the protocol:
   * `availableModels` appears nowhere in the ACP schema, so that field was
   * always null and every capability question built on it always answered
   * "unknown". Verified against the real Claude adapter, which declares
   * `model`, `effort`, `fast` and `mode` here — each with a name, a
   * description and its allowed values, which is everything a UI needs and
   * none of it specific to Claude.
   *
   * `null` means no session response was ever received; `[]` means the
   * runtime was asked and declares none. Those are different answers.
   */
  sessionConfigOptions: unknown[] | null
  /** Permission/behaviour modes from `session/new`'s `modes.availableModes`. */
  availableModes: unknown[] | null
  /** The mode the agent starts a session in. */
  currentModeId: string | null
  availableCommands: unknown[] | null
  /**
   * True when the probe's throwaway `session/new` was refused with ACP's
   * authentication-required error. The handshake itself succeeded — the
   * binary is installed and speaks the protocol — but no run will open a
   * session until someone signs the CLI in on this machine. Absent on
   * handshakes stored before this field existed, which reads as "not
   * observed" rather than "not required".
   */
  authRequired?: boolean
  /** When the probe ran, so staleness is visible. */
  probedAt: string
}

/** One entry of `availableModes`, as ACP defines it. */
export interface SessionModeOption {
  id: string
  name: string
  description?: string | null
}

function isSessionMode(value: unknown): value is SessionModeOption {
  if (!value || typeof value !== 'object') return false
  const mode = value as Record<string, unknown>
  return typeof mode.id === 'string' && typeof mode.name === 'string'
}

/** The modes a runtime offers, if its probe session reported any. */
export function sessionModes(h: AgentHandshake | null): SessionModeOption[] {
  if (!h || !Array.isArray(h.availableModes)) return []
  return h.availableModes.filter(isSessionMode)
}

/**
 * The runtime's declared config options plus, when it offers session modes
 * and does not already declare a `mode` option, a synthesised one.
 *
 * ACP has two mechanisms for the same idea: Claude's adapter exposes its
 * permission mode as a config option named `mode`, Codex's adapter exposes
 * read-only / agent / full-access as `availableModes` set through
 * `session/set_mode`. A settings screen should not make a person learn which
 * is which, so both surface as one select called Mode; `sendTurn` reads the
 * chosen value and sends whichever request that session actually accepts.
 */
export function effectiveSessionConfigOptions(h: AgentHandshake | null): SessionConfigOption[] | undefined {
  const declared = sessionConfigOptions(h)
  const modes = sessionModes(h)
  if (modes.length === 0) return declared
  if (declared?.some((option) => option.id === 'mode')) return declared
  const synthesised: SessionConfigOption = {
    id: 'mode',
    name: 'Mode',
    description: 'How much the agent may do on its own in this session.',
    category: 'mode',
    type: 'select',
    currentValue: h?.currentModeId ?? undefined,
    options: modes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description ?? null })),
  }
  return [...(declared ?? []), synthesised]
}

/**
 * One self-describing setting a runtime offers, as ACP defines it.
 *
 * Rendered by a generic component rather than mapped into fields of ours: the
 * whole value of the runtime declaring these is that a new runtime's settings
 * need no new screen, and a new model needs no release from us.
 */
export interface SessionConfigOption {
  id: string
  name: string
  description?: string | null
  category?: string | null
  type: 'select' | 'boolean'
  currentValue?: unknown
  options?: Array<{ value: string; name: string; description?: string | null }>
}

function isSessionConfigOption(value: unknown): value is SessionConfigOption {
  if (!value || typeof value !== 'object') return false
  const option = value as Record<string, unknown>
  return typeof option.id === 'string' && typeof option.name === 'string'
}

/**
 * The settings this runtime offers for a session, if it declared any.
 *
 * `undefined` means it was never asked; an empty array means it was asked and
 * offers none. The UI shows different things for those, which is the point of
 * keeping them distinct.
 */
export function sessionConfigOptions(h: AgentHandshake | null): SessionConfigOption[] | undefined {
  if (!h || h.sessionConfigOptions === null) return undefined
  return h.sessionConfigOptions.filter(isSessionConfigOption)
}

/** The option a runtime uses for model choice, by ACP's own category. */
export function modelOption(h: AgentHandshake | null): SessionConfigOption | undefined {
  const options = sessionConfigOptions(h)
  if (!options) return undefined
  return (
    options.find((o) => o.category === 'model') ??
    // Category is optional in the schema, so fall back to the conventional id
    // rather than showing nothing for a runtime that simply omitted it.
    options.find((o) => o.id === 'model')
  )
}

export function supportsModelSelection(h: AgentHandshake | null): boolean | undefined {
  if (!h || h.sessionConfigOptions === null) return undefined
  return modelOption(h) !== undefined
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
