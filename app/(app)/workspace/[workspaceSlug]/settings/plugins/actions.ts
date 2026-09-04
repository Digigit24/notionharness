'use server'

import { revalidatePath } from 'next/cache'

import { getCurrentPayloadUser } from '@/lib/current-user'
import { guard, raise, type WithFailure } from '@/lib/failures'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { pluginToMcpServer } from '@/lib/plugins/resolve'

/**
 * R4.1 — the plugin registry's write surface.
 *
 * Note what is deliberately absent: nothing here ever returns a header or
 * environment VALUE to the browser. The list below reports which names are
 * set and whether each has a value, which is everything a person needs to
 * manage them and nothing an onlooker can use. That matches how this codebase
 * already treats provider keys and Hermes `auth.json`.
 *
 * R12-P1.1 — the three WRITES return their failures rather than throwing
 * them, since "That plugin no longer exists." is how this file refuses an id
 * belonging to another workspace, and that refusal has to be readable. The
 * two reads still throw: both are awaited by the server component in
 * `page.tsx`, where a throw IS delivered (see `lib/failures.ts`).
 */

async function requireUser() {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You must be logged in.')
  return user
}

/** A header or env entry, described without disclosing it. */
export interface SecretPairSummary {
  name: string
  hasValue: boolean
  /** True when the value references a per-run placeholder such as
   * `{{RUN_TOKEN}}` — worth showing, because it explains why the stored value
   * is not itself a credential. */
  isTemplated: boolean
}

export interface PluginSummary {
  id: number
  name: string
  description: string | null
  transport: 'http' | 'sse' | 'stdio'
  url: string | null
  command: string | null
  enabled: boolean
  scope: 'agents' | 'workspace'
  agentIds: number[]
  headers: SecretPairSummary[]
  env: SecretPairSummary[]
  configOptions: PluginConfigOption[]
  /** Why this row cannot currently be injected, if it cannot. Computed with
   * the same function the dispatcher uses, so the settings screen and the run
   * can never disagree about whether a plugin is usable. */
  problem: string | null
}

/** R4.5 — a plugin describes its own settings form. */
export interface PluginConfigOption {
  id: string
  label: string
  type: 'string' | 'boolean' | 'select'
  options?: Array<{ label: string; value: string }>
  value?: unknown
}

function summarisePairs(value: unknown): SecretPairSummary[] {
  if (!Array.isArray(value)) return []
  const out: SecretPairSummary[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const name = (entry as { name?: unknown }).name
    if (typeof name !== 'string' || !name) continue
    const raw = (entry as { value?: unknown }).value
    const text = typeof raw === 'string' ? raw : ''
    out.push({ name, hasValue: text.length > 0, isTemplated: /\{\{[A-Z_]+\}\}/.test(text) })
  }
  return out
}

function normaliseConfigOptions(value: unknown): PluginConfigOption[] {
  if (!Array.isArray(value)) return []
  const out: PluginConfigOption[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const option = entry as Record<string, unknown>
    if (typeof option.id !== 'string' || !option.id) continue
    const type = option.type === 'boolean' || option.type === 'select' ? option.type : 'string'
    out.push({
      id: option.id,
      label: typeof option.label === 'string' && option.label ? option.label : option.id,
      type,
      options: Array.isArray(option.options)
        ? option.options
            .filter((o): o is { label: string; value: string } => {
              if (!o || typeof o !== 'object') return false
              const candidate = o as Record<string, unknown>
              return typeof candidate.value === 'string'
            })
            .map((o) => ({ label: String(o.label ?? o.value), value: o.value }))
        : undefined,
      value: option.value,
    })
  }
  return out
}

export async function listPlugins(workspaceSlug: string): Promise<PluginSummary[]> {
  await requireUser()
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) return []
  const payload = await getPayloadClient()
  const { docs } = await payload.find({
    collection: 'plugins',
    where: { workspace: { equals: workspace.id } },
    depth: 0,
    limit: 200,
    sort: 'name',
    overrideAccess: true,
  })
  return docs.map((plugin) => {
    const built = pluginToMcpServer(plugin)
    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description ?? null,
      transport: (plugin.transport ?? 'http') as 'http' | 'sse' | 'stdio',
      url: plugin.url ?? null,
      command: plugin.command ?? null,
      enabled: plugin.enabled !== false,
      scope: (plugin.scope ?? 'agents') as 'agents' | 'workspace',
      agentIds: Array.isArray(plugin.agents)
        ? plugin.agents.map((a) => (typeof a === 'number' ? a : a?.id)).filter((id): id is number => typeof id === 'number')
        : [],
      headers: summarisePairs(plugin.headers),
      env: summarisePairs(plugin.env),
      configOptions: normaliseConfigOptions(plugin.configOptions),
      problem: 'error' in built ? built.error : null,
    }
  })
}

export interface SavePluginInput {
  id?: number
  name: string
  description?: string
  transport: 'http' | 'sse' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  /** Full replacement. A pair with an empty value is dropped, so clearing a
   * field removes it rather than storing an empty credential. */
  headers?: Array<{ name: string; value: string }>
  env?: Array<{ name: string; value: string }>
  enabled: boolean
  scope: 'agents' | 'workspace'
  agentIds?: number[]
  configOptions?: PluginConfigOption[]
}

export async function savePlugin(
  workspaceSlug: string,
  input: SavePluginInput,
): Promise<WithFailure<{ id: number }>> {
  return guard(async () => {
    await requireUser()
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) raise('not_found', 'That workspace no longer exists.')
    if (!input.name.trim()) raise('invalid_input', 'A plugin needs a name.')

    const payload = await getPayloadClient()
    const data = {
      workspace: workspace.id,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      transport: input.transport,
      url: input.transport === 'stdio' ? null : input.url?.trim() || null,
      command: input.transport === 'stdio' ? input.command?.trim() || null : null,
      args: input.args ?? [],
      headers: (input.headers ?? []).filter((h) => h.name.trim() && h.value.length > 0),
      env: (input.env ?? []).filter((e) => e.name.trim() && e.value.length > 0),
      enabled: input.enabled,
      scope: input.scope,
      agents: input.scope === 'agents' ? (input.agentIds ?? []) : [],
      configOptions: input.configOptions ?? [],
    }

    if (input.id) {
      // Scoped to this workspace so an id from elsewhere cannot be edited by
      // guessing it.
      const existing = await payload
        .findByID({ collection: 'plugins', id: input.id, depth: 0, overrideAccess: true, disableErrors: true })
        .catch(() => null)
      const existingWorkspace = typeof existing?.workspace === 'number' ? existing.workspace : existing?.workspace?.id
      if (!existing || existingWorkspace !== workspace.id) raise('not_found', 'That plugin no longer exists.')
      await payload.update({ collection: 'plugins', id: input.id, data, overrideAccess: true })
      revalidatePath(`/workspace/${workspaceSlug}/settings/plugins`)
      return { id: input.id }
    }

    const created = await payload.create({ collection: 'plugins', data, overrideAccess: true })
    revalidatePath(`/workspace/${workspaceSlug}/settings/plugins`)
    return { id: created.id }
  })
}

export async function setPluginEnabled(
  workspaceSlug: string,
  id: number,
  enabled: boolean,
): Promise<WithFailure<void>> {
  return guard(async () => {
    await requireUser()
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) raise('not_found', 'That workspace no longer exists.')
    const payload = await getPayloadClient()
    const existing = await payload
      .findByID({ collection: 'plugins', id, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    const existingWorkspace = typeof existing?.workspace === 'number' ? existing.workspace : existing?.workspace?.id
    if (!existing || existingWorkspace !== workspace.id) raise('not_found', 'That plugin no longer exists.')
    await payload.update({ collection: 'plugins', id, data: { enabled }, overrideAccess: true })
    revalidatePath(`/workspace/${workspaceSlug}/settings/plugins`)
  })
}

export async function deletePlugin(workspaceSlug: string, id: number): Promise<WithFailure<void>> {
  return guard(async () => {
    await requireUser()
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) raise('not_found', 'That workspace no longer exists.')
    const payload = await getPayloadClient()
    const existing = await payload
      .findByID({ collection: 'plugins', id, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    const existingWorkspace = typeof existing?.workspace === 'number' ? existing.workspace : existing?.workspace?.id
    if (!existing || existingWorkspace !== workspace.id) raise('not_found', 'That plugin no longer exists.')
    await payload.delete({ collection: 'plugins', id, overrideAccess: true })
    revalidatePath(`/workspace/${workspaceSlug}/settings/plugins`)
  })
}

export interface AgentOption {
  id: number
  name: string
}

export async function listAgentOptions(workspaceSlug: string): Promise<AgentOption[]> {
  await requireUser()
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) return []
  const payload = await getPayloadClient()
  const { docs } = await payload.find({
    collection: 'agents',
    where: { workspace: { equals: workspace.id } },
    depth: 0,
    limit: 200,
    sort: 'name',
    overrideAccess: true,
  })
  return docs.map((agent) => ({ id: agent.id, name: agent.name }))
}
