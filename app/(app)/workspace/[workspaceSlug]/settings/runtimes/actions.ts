'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import type { RuntimeProfile } from '@/payload-types'
import { probeAcpRuntime } from '@/lib/runtimes/detect'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { guard, raise, type WithFailure } from '@/lib/failures'

// R12-P1.1 — every refusal below is RETURNED, not thrown. A server action that
// throws reaches a production browser as `1:E{"digest":…}` and nothing else
// (the measurement is in `lib/failures.ts`), so "Command is required." was a
// sentence only ever read in development. `guard()` turns it into a
// `__failure` envelope the button `unwrap()`s in the browser, where the
// message survives.

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
}): Promise<WithFailure<RuntimeProfile>> {
  return guard(async () => {
    const trimmedName = name.trim()
    const trimmedCommand = commandName.trim()
    if (!trimmedName) raise('invalid_input', 'Name is required.')
    if (!trimmedCommand) raise('invalid_input', 'Command is required.')

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
  })
}

export async function toggleRuntimeProfileEnabled({
  workspaceSlug,
  profileId,
  enabled,
}: {
  workspaceSlug: string
  profileId: number
  enabled: boolean
}): Promise<WithFailure<void>> {
  return guard(async () => {
    const payload = await getPayloadClient()
    await payload.update({
      collection: 'runtime-profiles',
      id: profileId,
      data: { enabled },
      overrideAccess: true,
    })
    revalidatePath(`/workspace/${workspaceSlug}/settings/runtimes`)
  })
}

/**
 * R12-P4.1 - save what this runtime does unless an agent says otherwise.
 *
 * The values are the ids the runtime declared for itself in its ACP handshake,
 * so nothing here validates against a list we maintain: a runtime that ships a
 * new option gets a working editor at the next probe. What IS enforced is the
 * shape - a flat map of scalars - because the dispatcher merges this with
 * `agents.runtimeConfig` and a nested value there would be silently ignored by
 * `session/set_config_option`, which takes one scalar per id.
 */
export async function saveRuntimeDefaults({
  workspaceSlug,
  profileId,
  defaults,
}: {
  workspaceSlug: string
  profileId: number
  defaults: Record<string, unknown>
}): Promise<WithFailure<void>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')

    for (const [id, value] of Object.entries(defaults)) {
      const scalar = value === null || ['string', 'number', 'boolean'].includes(typeof value)
      if (!scalar) {
        raise('invalid_input', `"${id}" must be a single value, not a list or an object.`)
      }
    }

    const payload = await getPayloadClient()
    await payload.update({
      collection: 'runtime-profiles',
      id: profileId,
      data: { defaultSessionConfig: defaults },
      overrideAccess: true,
    })
    revalidatePath(`/workspace/${workspaceSlug}/settings/runtimes`)
  })
}

/** What the probe found, as the button renders it. The code is the part the UI
 * branches on; `lib/runtimes/probe-codes.ts` turns it into the sentences. */
export interface RuntimeProbeOutcome {
  code: string
  ok: boolean
  detail: string
  agentName: string | null
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
 *
 * Note that a failed PROBE is not a failed ACTION: a runtime that is not
 * installed answers `command_not_found` as a normal result, which is why that
 * comes back in the success shape rather than as a `__failure`. The envelope
 * is reserved for the probe never happening at all.
 */
export async function probeRuntimeProfile({
  id,
  workspaceSlug,
}: {
  id: number
  workspaceSlug: string
}): Promise<WithFailure<RuntimeProbeOutcome>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')

    const payload = await getPayloadClient()
    const profile = await payload
      .findByID({ collection: 'runtime-profiles', id, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    if (!profile) raise('not_found', 'That runtime profile no longer exists.')

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
  })
}
