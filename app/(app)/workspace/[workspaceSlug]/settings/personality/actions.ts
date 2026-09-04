'use server'

import { revalidatePath } from 'next/cache'
import { setActiveHermesProfile } from '@/lib/runtimes/hermes/personas'

export async function switchActiveHermesProfile({
  workspaceSlug,
  profileName,
}: {
  workspaceSlug: string
  profileName: string
}): Promise<void> {
  await setActiveHermesProfile(profileName)
  revalidatePath(`/workspace/${workspaceSlug}/settings/personality`)
}
