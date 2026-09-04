'use server'

import { revalidatePath } from 'next/cache'
import { guard, type WithFailure } from '@/lib/failures'
import { setActiveHermesProfile } from '@/lib/runtimes/hermes/personas'

// R12-P1.1 — switching the active profile is a live change to how this
// install answers real WhatsApp senders, so "that profile no longer exists"
// or a write failure has to reach the person who pressed the button. Thrown,
// it did not (see `lib/failures.ts`); returned, the confirm button's existing
// toast reads it.
export async function switchActiveHermesProfile({
  workspaceSlug,
  profileName,
}: {
  workspaceSlug: string
  profileName: string
}): Promise<WithFailure<void>> {
  return guard(async () => {
    await setActiveHermesProfile(profileName)
    revalidatePath(`/workspace/${workspaceSlug}/settings/personality`)
  })
}
