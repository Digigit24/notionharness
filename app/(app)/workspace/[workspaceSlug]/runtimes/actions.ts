'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import type { RuntimeProfile } from '@/payload-types'

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
  revalidatePath(`/workspace/${workspaceSlug}/runtimes`)
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
  revalidatePath(`/workspace/${workspaceSlug}/runtimes`)
}
