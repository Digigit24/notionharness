'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import type { Activity, Notification } from '@/payload-types'

// ROADMAP P2.6 — global, cross-workspace notifications: `Notifications` has
// no `workspace` field (a user's notifications span every workspace they're
// in), so this lives under a top-level `app/(app)/notifications/` rather
// than a specific `[workspaceSlug]` route, and the bell that calls it lives
// in the Sidebar (rendered inside every workspace layout) rather than a
// workspace-scoped one.
export interface NotificationView {
  id: number
  isRead: boolean
  createdAt: string
  actorName: string | null
  action: string | null
  href: string | null
}

const NOTIFICATIONS_LIMIT = 30

export async function getUnreadNotificationCount(): Promise<number> {
  const user = await getCurrentPayloadUser()
  if (!user) return 0
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'notifications',
    where: { user: { equals: user.id }, isRead: { equals: false } },
    limit: 1,
    overrideAccess: true,
  })
  return result.totalDocs
}

export async function getNotifications(): Promise<NotificationView[]> {
  const user = await getCurrentPayloadUser()
  if (!user) return []
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'notifications',
    where: { user: { equals: user.id } },
    sort: '-createdAt',
    limit: NOTIFICATIONS_LIMIT,
    overrideAccess: true,
  })
  return Promise.all(result.docs.map((doc) => toView(payload, doc)))
}

export async function markNotificationsRead(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  const payload = await getPayloadClient()
  await Promise.all(
    ids.map((id) => payload.update({ collection: 'notifications', id, data: { isRead: true }, overrideAccess: true })),
  )
  revalidatePath('/', 'layout')
}

async function toView(payload: Awaited<ReturnType<typeof getPayloadClient>>, doc: Notification): Promise<NotificationView> {
  const activity: Activity | null =
    typeof doc.activity === 'object' && doc.activity
      ? doc.activity
      : typeof doc.activity === 'number'
        ? await payload.findByID({ collection: 'activity', id: doc.activity, overrideAccess: true, disableErrors: true }).catch(() => null)
        : null

  const actor = activity && typeof activity.actor === 'object' && activity.actor ? activity.actor : null
  const href = activity ? await hrefForEntity(payload, activity.entityType, activity.entityId) : null

  return {
    id: doc.id,
    isRead: Boolean(doc.isRead),
    createdAt: doc.createdAt,
    actorName: actor?.name || actor?.email || null,
    action: activity?.action ?? doc.message ?? 'updated',
    href,
  }
}

// Only `task`/`page` entities are linkable so far — `project` has no detail
// route yet (P2.5 didn't build one) and `run` is Pillar-4 territory. A few
// extra lookups per notification (task/page -> its workspace, for the slug
// in the URL) is an accepted cost for a "fetch when the panel opens, no
// real-time push" pass with a 30-notification cap.
async function hrefForEntity(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
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
