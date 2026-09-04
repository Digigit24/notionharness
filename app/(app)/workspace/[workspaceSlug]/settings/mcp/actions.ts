'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import {
  listMcpServers,
  listServeProfiles,
  setMcpServerEnabled,
  testMcpServer,
  type ServeMcpServer,
  type ServeProfile,
} from '@/lib/hermes/serve-client'

/**
 * MCP servers, per Hermes profile.
 *
 * The authoritative store is `config.yaml: mcp_servers.<name>` inside the
 * profile, which Hermes owns — so this reads and writes through its API
 * rather than keeping a mirror table here. A mirror would have to be kept in
 * sync with a file another program edits, and would be wrong the first time
 * someone ran `hermes mcp add`.
 *
 * Note the server's own response masks values in `env`, so nothing secret
 * reaches this app, let alone the browser.
 */

async function requireUser() {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')
  return user
}

export interface McpSettings {
  profiles: ServeProfile[]
  profile: string
  servers: ServeMcpServer[]
  error: string | null
}

export async function getMcpSettings(profile: string): Promise<McpSettings> {
  await requireUser()
  const profiles = await listServeProfiles().catch(() => [] as ServeProfile[])
  try {
    const raw = await listMcpServers(profile)
    // Same hardening as the skills list: real rows carry nulls (a stdio
    // server has no `url`, an http one has no `args`), and one null reaching
    // a `.map` or `.localeCompare` takes the whole page down.
    const servers = (Array.isArray(raw) ? raw : []).map((server) => ({
      ...server,
      name: String(server?.name ?? ''),
      transport: String(server?.transport ?? 'unknown'),
      args: Array.isArray(server?.args) ? server.args.map((arg) => String(arg)) : [],
      env: server?.env && typeof server.env === 'object' ? server.env : {},
      enabled: server?.enabled === true,
    })).filter((server) => server.name)
    return { profiles, profile, servers, error: null }
  } catch (err) {
    return {
      profiles,
      profile,
      servers: [],
      error: err instanceof Error ? err.message : 'Could not read MCP servers.',
    }
  }
}

export async function setMcpEnabled(input: {
  workspaceSlug: string
  profile: string
  name: string
  enabled: boolean
}): Promise<void> {
  await requireUser()
  await setMcpServerEnabled(input.name, input.enabled, input.profile)
  revalidatePath(`/workspace/${input.workspaceSlug}/settings/mcp`)
}

export interface McpTestResult {
  ok: boolean
  tools: string[]
  error?: string
}

/**
 * Connects to one server and lists what it actually offers.
 *
 * Worth having as a button because "enabled" only means "configured": a
 * server whose URL moved, whose token expired, or whose command is missing
 * looks identical in the list until something tries to use it mid-turn.
 */
export async function testMcp(profile: string, name: string): Promise<McpTestResult> {
  await requireUser()
  try {
    const raw = (await testMcpServer(name, profile)) as {
      ok?: boolean
      error?: string
      tools?: Array<{ name?: string }>
    }
    return {
      ok: raw.ok === true,
      tools: (raw.tools ?? []).map((tool) => tool?.name ?? '').filter(Boolean),
      error: raw.error,
    }
  } catch (err) {
    return { ok: false, tools: [], error: err instanceof Error ? err.message : 'The test failed.' }
  }
}
