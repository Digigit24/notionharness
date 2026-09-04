'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { guard, raise, type WithFailure } from '@/lib/failures'
import type { Project } from '@/payload-types'

// Closes the real gap flagged in this page's own empty state ("Create a
// project from a task's Project field, or via the Payload admin") — the
// task's Project field is a picker over existing projects only, and there
// was no `createProject` action anywhere in the app. This is that action.
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
