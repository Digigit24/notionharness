'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import type { Agent } from '@/payload-types'
import { pingAcpRuntime, type RuntimePingResult } from '@/lib/runtimes/hermes/ping'
import { enqueueRun, getRun, listRunEvents, TERMINAL_STATUSES } from '@/lib/broker'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { guard, raise, type WithFailure } from '@/lib/failures'
import { requireAccess } from '@/lib/permissions'
import { getActiveModelConfig } from '@/lib/runtimes/hermes/providers'
import { listHermesProfiles, type HermesProfileSummary } from '@/lib/runtimes/hermes/profiles'
import {
  addAgentMemoryEntry,
  deleteAgentMemoryEntry,
  readAgentMemory,
  updateAgentMemoryEntry,
  type AgentMemory,
  type AgentMemoryFile,
  type MemoryTarget,
} from '@/lib/runtimes/hermes/agent-memory'

// R12-P1.1 — every action below that a BUTTON calls returns its failures
// rather than throwing them. A thrown message reaches a production browser as
// `1:E{"digest":…}` and nothing else (the measurement is in
// `lib/failures.ts`), so a rejected agent save has been showing a generic
// React sentence in place of Payload's own validation error — which is the
// only part of it worth reading.

/**
 * The writable surface of an agent, stated as a list rather than left implied.
 *
 * PHASE 0 — this action took `data: Record<string, unknown>` and spread it
 * straight into `payload.update`, so a caller could write ANY field on the
 * collection, including `workspace` (moving somebody else's agent into their
 * own workspace) and any field added to `collections/Agents.ts` later that
 * nobody thought to guard. A whitelist inverts that: a new field is unwritable
 * until it is named here, which is the direction a security boundary has to
 * fail.
 *
 * `workspace` is deliberately ABSENT even though the write sets it. It comes
 * from the `workspaceId` argument the permission check below was performed
 * against, never from `data` — otherwise the check and the write could be
 * about two different workspaces.
 */
const AGENT_WRITABLE_FIELDS = [
  'name',
  'runtimeProfile',
  'model',
  'hermesProfile',
  'runtimeConfig',
  'thinkingLevel',
  'instructions',
  'customEnv',
  'customArgs',
  'mcpConfig',
  'skills',
  'maxConcurrentRuns',
  'permissionMode',
  'enabled',
] as const

function pickWritableAgentFields(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of AGENT_WRITABLE_FIELDS) {
    if (field in data) out[field] = data[field]
  }
  return out
}

/**
 * PHASE 0 — this had no session check at all, on top of the arbitrary-field
 * write above: an unauthenticated POST to this action's generated endpoint
 * could create or rewrite any agent in any workspace.
 *
 * `administer`, not `write`. An agent row names the `runtimeProfile` — the
 * binary and arguments this host will execute — and its `customEnv` and
 * `customArgs`, so editing one decides what runs on this machine and with what
 * environment. That is `lib/permissions/model.ts`'s definition of `administer`
 * ("configuration that costs money or reaches outside") rather than ordinary
 * workspace work, and the collection's own access block draws the same line.
 *
 * Editing an EXISTING agent also re-checks that the agent is in the workspace
 * the caller was authorised against. Without it, holding `administer` on any
 * one workspace would be enough to rewrite every agent in the install by
 * pairing your own `workspaceId` with somebody else's agent id — and the
 * write's own `workspace: workspaceId` would then quietly move it.
 */
export async function saveAgent({ workspaceId, workspaceSlug, id, data }: { workspaceId: number; workspaceSlug: string; id?: number; data: Record<string, unknown> }): Promise<WithFailure<Agent>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You are not signed in.')
    await requireAccess({ userId: user.id, workspaceId, verb: 'administer', objectType: 'workspace' })

    const payload = await getPayloadClient()
    if (id !== undefined) {
      const existing = await payload
        .findByID({ collection: 'agents', id, depth: 0, overrideAccess: true, disableErrors: true })
        .catch(() => null)
      const existingWorkspaceId =
        typeof existing?.workspace === 'number' ? existing.workspace : (existing?.workspace?.id ?? null)
      // One sentence for "no such agent" and for "not in this workspace", so
      // the action cannot be used to probe which agent ids exist elsewhere.
      if (!existing || existingWorkspaceId !== workspaceId) raise('not_found', 'That agent no longer exists.')
    }

    const fields = pickWritableAgentFields(data)
    const agent = id
      ? await payload.update({ collection: 'agents', id, data: { ...fields, workspace: workspaceId } as never, overrideAccess: true })
      : await payload.create({ collection: 'agents', data: { ...fields, workspace: workspaceId } as never, overrideAccess: true })
    revalidatePath(`/workspace/${workspaceSlug}/agents`)
    revalidatePath(`/workspace/${workspaceSlug}/agents/${agent.id}`)
    return agent
  })
}

/**
 * The agent detail page's "Test connection" button — pings the agent's own
 * runtime profile binary. Only ACP profiles are supported (see
 * `lib/hermes/ping.ts`'s own comment on what this does and doesn't verify);
 * an MCP profile returns a clear "not supported yet" result rather than
 * silently no-op'ing or guessing at an equivalent MCP health check.
 */
export async function pingAgentRuntime(agentId: number): Promise<WithFailure<RuntimePingResult>> {
  // The in-shape `{ ok: false, output }` returns below stay exactly as they
  // are: "this agent has no runtime profile" is the ping's ANSWER, and belongs
  // on the result line under the button. The envelope is for the ping never
  // happening — a database that will not answer, say.
  return guard(async () => {
    const payload = await getPayloadClient()
    const agent = await payload
      .findByID({ collection: 'agents', id: agentId, depth: 1, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    if (!agent) return { ok: false, output: 'Agent not found.', durationMs: 0 }

    const runtimeProfile = agent.runtimeProfile
    if (!runtimeProfile || typeof runtimeProfile === 'number') {
      return { ok: false, output: 'This agent has no runtime profile configured.', durationMs: 0 }
    }
    if (runtimeProfile.protocolFamily !== 'acp') {
      return { ok: false, output: `Test connection isn't supported yet for ${runtimeProfile.protocolFamily.toUpperCase()} runtime profiles.`, durationMs: 0 }
    }
    return pingAcpRuntime(runtimeProfile.commandName)
  })
}

const MODEL_PING_PROMPT = 'Reply with exactly one word: pong'
const MODEL_PING_TIMEOUT_MS = 45_000
const MODEL_PING_POLL_MS = 1500

/**
 * "Test connection with the model" — unlike `pingAgentRuntime` (which only
 * confirms the binary itself runs via `--check`), this sends a real,
 * trivial turn through the actual dispatcher/Hermes pipeline, so it
 * genuinely exercises whatever AI provider Hermes is currently configured
 * to use. Reuses the same standalone (no task, no page) run shape the "Ask"
 * page's conversations use — see `listRunsForAgentStandalone`'s own comment.
 *
 * Note this tests Hermes's CURRENTLY ACTIVE model/provider (config.yaml's
 * `model:` block — see lib/hermes/providers.ts), not something specific to
 * this one agent: confirmed live this session that `hermes-acp` has no
 * per-invocation model override (no `--model` CLI flag, and
 * `HERMES_WEBUI_DEFAULT_MODEL` is read only by hermes-webui's own server,
 * never by the underlying `hermes-agent` package the ACP CLI shares). A run
 * can reach `status: 'completed'` even when the reply text itself is
 * Hermes's own "API call failed" message (confirmed live against the real
 * Kimi outage this session) — this returns the actual reply text rather
 * than trying to guess-classify it, so the caller can judge for themselves.
 */
export async function pingAgentModel(agentId: number): Promise<WithFailure<RuntimePingResult>> {
  return guard(async () => {
    const start = Date.now()
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')

    const payload = await getPayloadClient()
    const agent = await payload
      .findByID({ collection: 'agents', id: agentId, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    if (!agent || agent.enabled === false) {
      return { ok: false, output: 'Agent not found or disabled.', durationMs: 0 }
    }

    // Resolve what SHOULD answer before asking, so the result can name it. A
    // reply proves something responded; naming the profile and model proves the
    // right thing responded — which is the actual question when an agent is
    // pinned to a non-default profile.
    const profileName = typeof agent.hermesProfile === 'string' ? agent.hermesProfile.trim() : ''
    const expected = await getActiveModelConfig(profileName || null).catch(() => null)
    const attribution = {
      profile: profileName,
      provider: expected?.provider,
      model: expected?.model,
    }

    const run = await enqueueRun({
      agentId,
      originatorUser: user.id,
      accountableUser: user.id,
      prompt: MODEL_PING_PROMPT,
    })

    while (Date.now() - start < MODEL_PING_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, MODEL_PING_POLL_MS))
      const current = await getRun(run.id)
      if (!current) break
      if (TERMINAL_STATUSES.includes(current.status)) {
        const events = await listRunEvents(run.id)
        const messageEvent = events.find((e) => e.event.type === 'message' && e.event.role === 'assistant')
        const replyText = messageEvent && messageEvent.event.type === 'message' ? messageEvent.event.text : null
        return {
          ok: current.status === 'completed' && !!replyText,
          output: replyText ?? current.error ?? `Run ended with status "${current.status}" and no reply.`,
          durationMs: Date.now() - start,
          ...attribution,
        }
      }
    }
    return {
      ok: false,
      output: `Timed out waiting ${MODEL_PING_TIMEOUT_MS / 1000}s for a reply.`,
      durationMs: Date.now() - start,
      ...attribution,
    }
  })
}

/** Profiles offered by the agent settings form's picker. Server-side so the
 * list always reflects the Hermes install on THIS machine rather than
 * anything mirrored into the database. */
export async function listAgentHermesProfiles(): Promise<WithFailure<HermesProfileSummary[]>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')
    return listHermesProfiles()
  })
}

// ---------------------------------------------------------------------------
// Agent memory — real, on-disk, per agent.
//
// These replace the `/api/hermes/memories*` HTTP proxies, which pointed at a
// Hermes server that has no such endpoint (see lib/hermes/agent-memory.ts's
// header for the full diagnosis of the "Failed to load memories" error).
// Every action re-reads and returns the file it touched, so the client never
// has to guess what the on-disk state became.

async function requireAgent(agentId: number) {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You must be logged in.')
  const payload = await getPayloadClient()
  const agent = await payload
    .findByID({ collection: 'agents', id: agentId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!agent) raise('not_found', 'That agent no longer exists.')
  return agent
}

export async function getAgentMemory(agentId: number): Promise<WithFailure<AgentMemory>> {
  return guard(async () => {
    await requireAgent(agentId)
    return readAgentMemory(agentId)
  })
}

export async function addAgentMemory(
  agentId: number,
  target: MemoryTarget,
  text: string,
): Promise<WithFailure<AgentMemoryFile>> {
  return guard(async () => {
    await requireAgent(agentId)
    const trimmed = text.trim()
    if (!trimmed) raise('invalid_input', 'A memory entry cannot be empty.')
    if (trimmed.length > 20_000) raise('invalid_input', 'That entry is too long (20,000 characters max).')
    return addAgentMemoryEntry(agentId, target, trimmed)
  })
}

export async function updateAgentMemory(
  agentId: number,
  target: MemoryTarget,
  index: number,
  text: string,
): Promise<WithFailure<AgentMemoryFile>> {
  return guard(async () => {
    await requireAgent(agentId)
    const trimmed = text.trim()
    if (!trimmed) raise('invalid_input', 'A memory entry cannot be empty.')
    if (trimmed.length > 20_000) raise('invalid_input', 'That entry is too long (20,000 characters max).')
    return updateAgentMemoryEntry(agentId, target, index, trimmed)
  })
}

export async function deleteAgentMemory(
  agentId: number,
  target: MemoryTarget,
  index: number,
): Promise<WithFailure<AgentMemoryFile>> {
  return guard(async () => {
    await requireAgent(agentId)
    return deleteAgentMemoryEntry(agentId, target, index)
  })
}
