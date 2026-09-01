import { cache } from 'react'
import { getPayloadClient } from './payload'
import type { Page, Workspace } from '@/payload-types'

/**
 * `WorkspaceLayout` (sidebar tree) and the page route (breadcrumb chain)
 * independently re-ran the SAME two Payload queries on every navigation —
 * "find workspace by slug" and "find every page in the workspace" (the
 * latter at `limit: 5000`). `React.cache()` dedupes calls with the same
 * argument within one request's render pass (including across a layout →
 * page boundary), so wiring both call sites through these instead of their
 * own inline `payload.find` cuts both duplicate round trips per navigation.
 */
export const getWorkspaceBySlug = cache(async (slug: string): Promise<Workspace | null> => {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'workspaces',
    where: { slug: { equals: slug } },
    limit: 1,
    overrideAccess: true,
  })
  return result.docs[0] ?? null
})

export const getWorkspacePages = cache(async (workspaceId: number): Promise<Page[]> => {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'pages',
    where: { workspace: { equals: workspaceId } },
    limit: 5000,
    sort: 'position',
    overrideAccess: true,
  })
  return result.docs
})
