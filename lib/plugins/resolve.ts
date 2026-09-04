// R4.1/R4.2 — turning plugin rows into the MCP server list a session gets.
//
// One function, called once per run, that answers: given this agent in this
// workspace, which tools should exist for the next turn? Everything about
// scope, secrecy and transport is decided here so no caller has to reason
// about it, and so there is exactly one place to audit when the question is
// "how did the agent get that tool".
//
// The output shape is ACP's own `McpServer` union, not a shape of ours. The
// SDK's zod definitions carry `http`, `sse`, `acp` and stdio variants, so
// supporting HTTP is reading the protocol rather than extending it. Agents
// and the tools they use are not necessarily on the same machine here, which
// is the whole reason stdio cannot be the only option.
import { getPayloadClient } from '@/lib/payload'
import type { Plugin } from '@/payload-types'

/** ACP's HTTP header pair. */
interface HttpHeader {
  name: string
  value: string
}

export type ResolvedMcpServer =
  | { type: 'http'; name: string; url: string; headers: HttpHeader[]; _meta?: Record<string, unknown> }
  | { type: 'sse'; name: string; url: string; headers: HttpHeader[]; _meta?: Record<string, unknown> }
  | { name: string; command: string; args: string[]; env: HttpHeader[]; _meta?: Record<string, unknown> }

/**
 * Per-run values a plugin row may reference in its headers or environment.
 *
 * This exists because of a genuine tension: a plugin row is static
 * configuration, and the credential an agent needs is per-run and short
 * lived. Storing a live token in the row would be wrong (it would outlive the
 * run and sit in the database), and giving every plugin the same permanent
 * key would be worse. Substituting at resolve time keeps the row inert and
 * the credential ephemeral.
 *
 * Written as `{{RUN_TOKEN}}` / `{{RUN_ID}}` in a header value.
 */
export interface RunSubstitutions {
  RUN_TOKEN?: string
  RUN_ID?: string
}

/** Replaces `{{NAME}}` with a per-run value. An unknown placeholder is left
 * exactly as written rather than blanked, so a typo is visible in the request
 * the plugin actually makes instead of silently becoming an empty header. */
function substitute(value: string, values: RunSubstitutions): string {
  return value.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) => {
    const replacement = (values as Record<string, string | undefined>)[name]
    return replacement === undefined ? whole : replacement
  })
}

export interface ResolvedPlugins {
  /** Ready to hand straight to `session/new`. */
  servers: ResolvedMcpServer[]
  /** Rows that matched but could not be turned into a server, and why. Surfaced
   * rather than dropped: a plugin that silently does not load is indistinguishable
   * from one that loaded and did nothing. */
  skipped: Array<{ name: string; reason: string }>
}

/**
 * Coerces the loosely-typed JSON columns into `[{ name, value }]`.
 *
 * These are `json` fields, so anything could be in them — a hand-edited row, an
 * older shape, a null. Anything that is not a usable pair is dropped rather
 * than passed through, because a malformed header would otherwise fail the
 * whole `session/new` call and take every other plugin down with it.
 */
function toPairs(value: unknown, values: RunSubstitutions = {}): HttpHeader[] {
  if (!Array.isArray(value)) return []
  const pairs: HttpHeader[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const name = (entry as { name?: unknown }).name
    const raw = (entry as { value?: unknown }).value
    if (typeof name !== 'string' || !name) continue
    const text = typeof raw === 'string' ? raw : String(raw ?? '')
    pairs.push({ name, value: substitute(text, values) })
  }
  return pairs
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * The settings a plugin declares about itself, flattened to `{ id: value }`.
 *
 * Passed through as `_meta` so a plugin can read its own configuration without
 * us inventing a side channel for it. ACP defines `_meta` as free-form on
 * every one of these variants, so this is the intended place for it.
 */
function toMeta(configOptions: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(configOptions) || configOptions.length === 0) return undefined
  const meta: Record<string, unknown> = {}
  for (const option of configOptions) {
    if (!option || typeof option !== 'object') continue
    const id = (option as { id?: unknown }).id
    if (typeof id !== 'string' || !id) continue
    meta[id] = (option as { value?: unknown }).value
  }
  return Object.keys(meta).length > 0 ? { config: meta } : undefined
}

/** True when this plugin row applies to this agent. */
function appliesToAgent(plugin: Plugin, agentId: number): boolean {
  if (plugin.scope === 'workspace') return true
  const agents = plugin.agents
  if (!Array.isArray(agents)) return false
  return agents.some((entry) => (typeof entry === 'number' ? entry : entry?.id) === agentId)
}

export function pluginToMcpServer(
  plugin: Plugin,
  values: RunSubstitutions = {},
): ResolvedMcpServer | { error: string } {
  const meta = toMeta(plugin.configOptions)
  if (plugin.transport === 'stdio') {
    if (!plugin.command) return { error: 'no command is set' }
    return {
      name: plugin.name,
      command: plugin.command,
      args: toStringArray(plugin.args),
      env: toPairs(plugin.env, values),
      ...(meta ? { _meta: meta } : {}),
    }
  }
  if (!plugin.url) return { error: 'no URL is set' }
  // Rejected here rather than at the agent, which would report it as an
  // opaque connection failure halfway through a turn.
  if (!/^https?:\/\//i.test(plugin.url)) return { error: 'URL must start with http:// or https://' }
  return {
    type: plugin.transport === 'sse' ? 'sse' : 'http',
    name: plugin.name,
    url: plugin.url,
    headers: toPairs(plugin.headers, values),
    ...(meta ? { _meta: meta } : {}),
  }
}

/**
 * Every plugin this agent should have for its next turn.
 *
 * Scoped by workspace first and agent second, and filtered to enabled rows —
 * a disabled plugin is ABSENT from the session rather than present and
 * refusing, because an agent that can see a tool it may not use will keep
 * trying to use it and narrate the failure at the user.
 */
export async function resolvePluginsForRun(params: {
  workspaceId: number
  agentId: number
  /** Per-run values a plugin may reference. Absent for a caller that only
   * wants to know which plugins apply (a settings preview, say). */
  substitutions?: RunSubstitutions
}): Promise<ResolvedPlugins> {
  const payload = await getPayloadClient()
  const { docs } = await payload.find({
    collection: 'plugins',
    where: { workspace: { equals: params.workspaceId }, enabled: { equals: true } },
    // The agent relationship is only ever compared by id, so there is no
    // reason to pay for populating it (and a populated object compared to a
    // numeric id is exactly the bug that produced the approvals 403).
    depth: 0,
    limit: 200,
    overrideAccess: true,
  })

  const result: ResolvedPlugins = { servers: [], skipped: [] }
  for (const plugin of docs) {
    if (!appliesToAgent(plugin, params.agentId)) continue
    const server = pluginToMcpServer(plugin, params.substitutions ?? {})
    if ('error' in server) {
      result.skipped.push({ name: plugin.name, reason: server.error })
      continue
    }
    result.servers.push(server)
  }
  return result
}
