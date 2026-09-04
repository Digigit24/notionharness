'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { guard, raise, type WithFailure } from '@/lib/failures'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { requireAccess } from '@/lib/permissions'
import { setActiveHermesProfile } from '@/lib/runtimes/hermes/personas'

// R12-P1.1 — switching the active profile is a live change to how this
// install answers real WhatsApp senders, so "that profile no longer exists"
// or a write failure has to reach the person who pressed the button. Thrown,
// it did not (see `lib/failures.ts`); returned, the confirm button's existing
// toast reads it.
//
// PHASE 0 — and for the same reason it needed a readable failure, it needed a
// check at all: this had none. `setActiveHermesProfile` rewrites host-level
// Hermes state, so an unauthenticated POST to this action's generated endpoint
// could repoint every conversation this install answers at a profile of the
// caller's choosing. `administer` is the verb — the profile decides what the
// install says to the outside world, which is precisely the line
// `lib/permissions/model.ts` draws for it.
//
// The workspace is resolved from the SLUG the action already takes, rather
// than trusting a workspace id in the payload. There is only one id in this
// call and it is the one the URL already committed to; accepting a second,
// separate id would create a way to pass one workspace's slug and another's
// permissions.
export async function switchActiveHermesProfile({
  workspaceSlug,
  profileName,
}: {
  workspaceSlug: string
  profileName: string
}): Promise<WithFailure<void>> {
  return guard(async () => {
    const [workspace, user] = await Promise.all([getWorkspaceBySlug(workspaceSlug), getCurrentPayloadUser()])
    if (!user) raise('unauthenticated', 'You are not signed in.')
    if (!workspace) raise('not_found', 'That workspace no longer exists.')
    await requireAccess({
      userId: user.id,
      workspaceId: workspace.id,
      verb: 'administer',
      objectType: 'workspace',
    })

    await setActiveHermesProfile(profileName)
    revalidatePath(`/workspace/${workspaceSlug}/settings/personality`)
  })
}
