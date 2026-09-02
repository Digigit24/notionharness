import { getPayloadClient } from '@/lib/payload'
import type { Activity } from '@/payload-types'

type PayloadClient = Awaited<ReturnType<typeof getPayloadClient>>

// ROADMAP P2.6/P5.5 — single shared "activity entity → deep link" resolver.
// The notifications bell (app/(app)/notifications/actions.ts) and the Inbox
// home screen (workspace/[workspaceSlug]/inbox) both build hrefs from the
// polymorphic `activity.entityType`/`entityId` pair, so the lookup logic lives
// here once instead of being duplicated per call site.
//
// Only `task`/`page` entities are linkable so far — `project` has no detail
// route yet (P2.5 didn't build one) and `run` is Pillar-4 territory. A few
// extra lookups per notification (task/page -> its workspace, for the slug in
// the URL) is an accepted cost for a "fetch when the panel opens, no real-time
// push" pass with a 30-item cap.
export async function hrefForEntity(
  payload: PayloadClient,
  entityType: Activity['entityType'],
  entityId: string,
): Promise<string | null> {
  const id = Number(entityId)
  if (!Number.isFinite(id)) return null

  if (entityType === 'task') {
    const task = await payload.findByID({ collection: 'tasks', id, overrideAccess: true, disableErrors: true }).catch(() => null)
    if (!task) return null
    const workspaceId = typeof task.workspace === 'number' ? task.workspace : task.workspace.id
    const workspace = await payload
      .findByID({ collection: 'workspaces', id: workspaceId, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    return workspace ? `/workspace/${workspace.slug}/tasks?task=${task.id}` : null
  }

  if (entityType === 'page') {
    const page = await payload.findByID({ collection: 'pages', id, overrideAccess: true, disableErrors: true }).catch(() => null)
    if (!page) return null
    const workspaceId = typeof page.workspace === 'number' ? page.workspace : page.workspace.id
    const workspace = await payload
      .findByID({ collection: 'workspaces', id: workspaceId, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    return workspace ? `/workspace/${workspace.slug}/p/${page.id}` : null
  }

  return null
}