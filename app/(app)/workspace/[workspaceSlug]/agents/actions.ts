'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'

export async function saveAgent({ workspaceId, workspaceSlug, id, data }: { workspaceId: number; workspaceSlug: string; id?: number; data: Record<string, unknown> }) {
  const payload = await getPayloadClient()
  const agent = id
    ? await payload.update({ collection: 'agents', id, data: { ...data, workspace: workspaceId } as never, overrideAccess: true })
    : await payload.create({ collection: 'agents', data: { ...data, workspace: workspaceId } as never, overrideAccess: true })
  revalidatePath(`/workspace/${workspaceSlug}/agents`)
  return agent
}
