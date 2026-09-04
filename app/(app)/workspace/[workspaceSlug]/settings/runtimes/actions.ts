'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import type { RuntimeProfile } from '@/payload-types'
import { probeAcpRuntime } from '@/lib/runtimes/detect'
import { getCurrentPayloadUser } from '@/lib/current-user'

// Phase C, C2 — closes this page's own "add one from the Payload admin"
// stopgap (see page.tsx's empty state). `collections/RuntimeProfiles.ts`
// already exists and is already migrated — this is application code, not a
// schema change, so unlike C1.1/C1.6 it doesn't need the migration-gating
// discipline documented elsewhere in AGENTS.md's Phase C section.
export async function createRuntimeProfile({
  workspaceId,
  workspaceSlug,
  name,
  protocolFamily,
  commandName,
}: {
  workspaceId: number
  workspaceSlug: string
  name: string
  protocolFamily: RuntimeProfile['protocolFamily']
  commandName: string
}): Promise<RuntimeProfile> {
  const trimmedName = name.trim()
  const trimmedCommand = commandName.trim()
  if (!trimmedName) throw new Error('Name is required.')
  if (!trimmedCommand) throw new Error('Command is required.')

  const payload = await getPayloadClient()
  const created = await payload.create({
    collection: 'runtime-profiles',
    data: {
      workspace: workspaceId,
      name: trimmedName,
      protocolFamily,
      commandName: trimmedCommand,
      enabled: true,
    },
    overrideAccess: true,
  })
  revalidatePath(`/workspace/${workspaceSlug}/settings/runtimes`)
  return created
}

export async function toggleRuntimeProfileEnabled({
  workspaceSlug,
  profileId,
  enabled,
}: {
  workspaceSlug: string
  profileId: number
  enabled: boolean
}): Promise<void> {
  const payload = await getPayloadClient()
  await payload.update({
    collection: 'runtime-profiles',
    id: profileId,
    data: { enabled },
    overrideAccess: true,
  })
  revalidatePath(`/workspace/${workspaceSlug}/settings/runtimes`)
}

/**
 * Probes a runtime and records what came back.
 *
 * Two questions, answered separately, because they are two different problems
 * with two different fixes: is the binary on this machine, and does it
 * actually speak ACP. The previous check spawned the binary with Hermes's own
 * `--check` flag, so it could only ever validate Hermes.
 *
 * The agent's own `initialize` response is stored verbatim. We do not fold it
 * into flags of our own, because a capability matrix maintained here is a set
 * of claims about someone else's software that goes stale on their release
 * schedule.
 */
export async function probeRuntimeProfile({
  id,
  workspaceSlug,
}: {
  id: number
  workspaceSlug: string
}): Promise<{ code: string; ok: boolean; detail: string; agentName: string | null }> {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')

  const payload = await getPayloadClient()
  const profile = await payload
    .findByID({ collection: 'runtime-profiles', id, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!profile) throw new Error('Runtime profile not found.')

  const args = Array.isArray(profile.fixedArgs)
    ? profile.fixedArgs.filter((a): a is string => typeof a === 'string')
    : []
  const result = await probeAcpRuntime(profile.commandName, args)

  await payload.update({
    collection: 'runtime-profiles',
    id,
    data: {
      handshake: result.handshake ?? null,
      lastProbeCode: result.code,
      lastProbeDetail: result.detail.slice(0, 500),
      lastProbedAt: new Date().toISOString(),
    } as never,
    overrideAccess: true,
  })

  revalidatePath(`/workspace/${workspaceSlug}/settings/runtimes`)
  return {
    code: result.code,
    ok: result.ok,
    detail: result.detail,
    agentName: result.handshake?.agentName ?? null,
  }
}
