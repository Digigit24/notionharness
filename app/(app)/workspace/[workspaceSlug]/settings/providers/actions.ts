'use server'

import { revalidatePath } from 'next/cache'
import { removeProviderApiKey, setActiveModelConfig, setProviderApiKey } from '@/lib/runtimes/hermes/providers'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { guard, raise, type WithFailure } from '@/lib/failures'
import { listHermesProfiles, type HermesProfileSummary } from '@/lib/runtimes/hermes/profiles'

// R12-P1.1 — these three write to Hermes's own config.yaml and .env on this
// machine, which is exactly the class of operation whose failures a person
// most needs to read: "no such profile", "the file is read-only", "the backup
// could not be written". Thrown, every one of those reached the browser as an
// opaque digest (`lib/failures.ts`). Returned, the toast in
// `components/providers/providers-view.tsx` shows the real sentence with no
// change to its catch block.

/** Every Hermes profile on this machine, each with its own active
 * provider/model. The install root is included as the implicit default. */
export async function getHermesProfiles(): Promise<WithFailure<HermesProfileSummary[]>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')
    return listHermesProfiles()
  })
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
}): Promise<WithFailure<void>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')
    await setActiveModelConfig({ provider, model }, profile)
    revalidatePath(`/workspace/${workspaceSlug}/settings/providers`)
  })
}

export async function updateProviderKey({
  workspaceSlug,
  envKeyName,
  value,
}: {
  workspaceSlug: string
  envKeyName: string
  value: string
}): Promise<WithFailure<void>> {
  return guard(async () => {
    const trimmed = value.trim()
    if (!trimmed) raise('invalid_input', 'Enter a key value.')
    await setProviderApiKey({ envKeyName, value: trimmed })
    revalidatePath(`/workspace/${workspaceSlug}/settings/providers`)
  })
}

export async function clearProviderKey({
  workspaceSlug,
  envKeyName,
}: {
  workspaceSlug: string
  envKeyName: string
}): Promise<WithFailure<void>> {
  return guard(async () => {
    await removeProviderApiKey(envKeyName)
    revalidatePath(`/workspace/${workspaceSlug}/settings/providers`)
  })
}
