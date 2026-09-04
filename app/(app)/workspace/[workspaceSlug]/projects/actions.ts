'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { guard, raise, type WithFailure } from '@/lib/failures'
import { requireAccess } from '@/lib/permissions'
import type { Project } from '@/payload-types'

// Closes the real gap flagged in this page's own empty state ("Create a
// project from a task's Project field, or via the Payload admin") — the
// task's Project field is a picker over existing projects only, and there
// was no `createProject` action anywhere in the app. This is that action.
//
// PHASE 0 — it had no session check and no permission check: the `workspaceId`
// in the payload was taken on trust, so anyone who could reach the host could
// create a project inside any workspace in the install. `write` is the verb —
// creating a project is ordinary work in a workspace, which a `member` may do
// and a `viewer` may not.
export async function createProject({
  workspaceId,
  workspaceSlug,
  name,
  icon,
  description,
}: {
  workspaceId: number
  workspaceSlug: string
  name: string
  icon?: string
  description?: string
}): Promise<WithFailure<Project>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You are not signed in.')
    await requireAccess({ userId: user.id, workspaceId, verb: 'write', objectType: 'workspace' })

    const trimmedName = name.trim()
    if (!trimmedName) raise('invalid_input', 'Name is required.')

    const payload = await getPayloadClient()
    const created = await payload.create({
      collection: 'projects',
      data: {
        workspace: workspaceId,
        name: trimmedName,
        icon: icon?.trim() || undefined,
        description: description?.trim() || undefined,
      },
      overrideAccess: true,
    })
    revalidatePath(`/workspace/${workspaceSlug}/projects`)
    return created
  })
}
