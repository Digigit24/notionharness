'use server'

import { revalidatePath } from 'next/cache'
import { removeProviderApiKey, setActiveModelConfig, setProviderApiKey } from '@/lib/hermes/providers'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { listHermesProfiles, type HermesProfileSummary } from '@/lib/hermes/profiles'

/** Every Hermes profile on this machine, each with its own active
 * provider/model. The install root is included as the implicit default. */
export async function getHermesProfiles(): Promise<HermesProfileSummary[]> {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')
  return listHermesProfiles()
}

export async function switchActiveProvider({
  workspaceSlug,
  provider,
  model,
  profile,
}: {
  workspaceSlug: string
  provider: string
  model: string
  /** Which profile's config.yaml to edit. Empty/omitted = the install root,
   * which is what this action did before profiles were addressable. */
  profile?: string
}): Promise<void> {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')
  await setActiveModelConfig({ provider, model }, profile)
  revalidatePath(`/workspace/${workspaceSlug}/settings/providers`)
}

export async function updateProviderKey({
  workspaceSlug,
  envKeyName,
  value,
}: {
  workspaceSlug: string
  envKeyName: string
  value: string
}): Promise<void> {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Enter a key value.')
  await setProviderApiKey({ envKeyName, value: trimmed })
  revalidatePath(`/workspace/${workspaceSlug}/settings/providers`)
}

export async function clearProviderKey({
  workspaceSlug,
  envKeyName,
}: {
  workspaceSlug: string
  envKeyName: string
}): Promise<void> {
  await removeProviderApiKey(envKeyName)
  revalidatePath(`/workspace/${workspaceSlug}/settings/providers`)
}
