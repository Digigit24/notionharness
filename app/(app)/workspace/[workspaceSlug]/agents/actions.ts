'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { pingAcpRuntime, type RuntimePingResult } from '@/lib/runtimes/hermes/ping'
import { enqueueRun, getRun, listRunEvents, TERMINAL_STATUSES } from '@/lib/broker'
import { getCurrentPayloadUser } from '@/lib/current-user'
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

export async function saveAgent({ workspaceId, workspaceSlug, id, data }: { workspaceId: number; workspaceSlug: string; id?: number; data: Record<string, unknown> }) {
  const payload = await getPayloadClient()
  const agent = id
    ? await payload.update({ collection: 'agents', id, data: { ...data, workspace: workspaceId } as never, overrideAccess: true })
    : await payload.create({ collection: 'agents', data: { ...data, workspace: workspaceId } as never, overrideAccess: true })
  revalidatePath(`/workspace/${workspaceSlug}/agents`)
  revalidatePath(`/workspace/${workspaceSlug}/agents/${agent.id}`)
  return agent
}

/**
 * The agent detail page's "Test connection" button — pings the agent's own
 * runtime profile binary. Only ACP profiles are supported (see
 * `lib/hermes/ping.ts`'s own comment on what this does and doesn't verify);
 * an MCP profile returns a clear "not supported yet" result rather than
 * silently no-op'ing or guessing at an equivalent MCP health check.
 */
export async function pingAgentRuntime(agentId: number): Promise<RuntimePingResult> {
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
export async function pingAgentModel(agentId: number): Promise<RuntimePingResult> {
  const start = Date.now()
  const user = await getCurrentPayloadUser()
  if (!user) return { ok: false, output: 'You must be logged in.', durationMs: 0 }

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
}

/** Profiles offered by the agent settings form's picker. Server-side so the
 * list always reflects the Hermes install on THIS machine rather than
 * anything mirrored into the database. */
export async function listAgentHermesProfiles(): Promise<HermesProfileSummary[]> {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')
  return listHermesProfiles()
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
  if (!user) throw new Error('You must be logged in.')
  const payload = await getPayloadClient()
  const agent = await payload
    .findByID({ collection: 'agents', id: agentId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!agent) throw new Error('Agent not found.')
  return agent
}

export async function getAgentMemory(agentId: number): Promise<AgentMemory> {
  await requireAgent(agentId)
  return readAgentMemory(agentId)
}

export async function addAgentMemory(
  agentId: number,
  target: MemoryTarget,
  text: string,
): Promise<AgentMemoryFile> {
  await requireAgent(agentId)
  const trimmed = text.trim()
  if (!trimmed) throw new Error('A memory entry cannot be empty.')
  if (trimmed.length > 20_000) throw new Error('That entry is too long (20,000 characters max).')
  return addAgentMemoryEntry(agentId, target, trimmed)
}

export async function updateAgentMemory(
  agentId: number,
  target: MemoryTarget,
  index: number,
  text: string,
): Promise<AgentMemoryFile> {
  await requireAgent(agentId)
  const trimmed = text.trim()
  if (!trimmed) throw new Error('A memory entry cannot be empty.')
  if (trimmed.length > 20_000) throw new Error('That entry is too long (20,000 characters max).')
  return updateAgentMemoryEntry(agentId, target, index, trimmed)
}

export async function deleteAgentMemory(
  agentId: number,
  target: MemoryTarget,
  index: number,
): Promise<AgentMemoryFile> {
  await requireAgent(agentId)
  return deleteAgentMemoryEntry(agentId, target, index)
}
