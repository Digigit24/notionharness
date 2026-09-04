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

/**
 * The pages the sidebar tree should show.
 *
 * `getWorkspacePages` deliberately returns EVERY page, because breadcrumbs
 * and link resolution have to be able to find a page whatever created it.
 * The sidebar wants a different set: the documents a person made, not every
 * document the app made on their behalf.
 *
 * Two kinds are excluded, and both were cluttering the root of the tree for
 * the same underlying reason — only `createPage` ever sets `parentPage`, so
 * anything created by another path has no parent and `lib/tree.ts` promotes
 * it to a root:
 *
 *   - Pages paired with a table row (`linkedSourceType` set). These are
 *     reachable from their row, which is where they mean something.
 *   - A task's own document. Reachable from the task.
 *
 * Neither becomes unreachable: both keep their own URL, still appear in
 * search, and a favourited one still shows in Favourites — which is the
 * existing "pin it to the sidebar" mechanism.
 */
export const getSidebarPages = cache(async (workspaceId: number): Promise<Page[]> => {
  const payload = await getPayloadClient()
  const [pages, tasks] = await Promise.all([
    getWorkspacePages(workspaceId),
    // Only the `page` column, so this is a cheap index read rather than a
    // second full table scan.
    payload.find({
      collection: 'tasks',
      where: { workspace: { equals: workspaceId }, page: { exists: true } },
      limit: 5000,
      depth: 0,
      select: { page: true },
      overrideAccess: true,
    }),
  ])

  const taskPageIds = new Set<number>()
  for (const task of tasks.docs) {
    const pageId = typeof task.page === 'object' && task.page ? task.page.id : task.page
    if (typeof pageId === 'number') taskPageIds.add(pageId)
  }

  return pages.filter((page) => {
    if (page.isFavorite) return true
    if (page.linkedSourceType) return false
    if (taskPageIds.has(page.id)) return false
    return true
  })
})
