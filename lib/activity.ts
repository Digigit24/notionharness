import type { BasePayload } from 'payload'
import type { ACTIVITY_ENTITY_TYPES } from '@/collections/Activity'

type EntityType = (typeof ACTIVITY_ENTITY_TYPES)[number]

// ROADMAP P2.6 — the one mechanism behind every Activity tab in the product.
// Every collection that wants a timeline (Tasks, Pages, later Projects/runs)
// calls this from its own `afterChange` hook rather than duplicating the
// "write an activity row, then notify followers" logic — the polymorphic
// `entityType`/`entityId` pair is the only cross-entity plumbing, per D-level
// guidance not to invent a second mechanism alongside it.
//
// Best-effort throughout: a failure here must never fail the write that
// triggered it, so every call site wraps this in try/catch and logs.
export async function recordActivity({
  payload,
  entityType,
  entityId,
  actor,
  action,
  details = {},
}: {
  payload: BasePayload
  entityType: EntityType
  entityId: string
  actor: number | null | undefined
  action: string
  details?: Record<string, unknown>
}) {
  const activity = await payload.create({
    collection: 'activity',
    data: {
      entityType,
      entityId,
      actor: actor ?? undefined,
      action,
      payload: details,
    },
    overrideAccess: true,
  })
  await notifyFollowers({ payload, entityType, entityId, activityId: activity.id, actorId: actor ?? null })
  return activity
}

// "Follows drive notifications" — every follower of this entity except the
// actor who caused the activity (no self-notifying) gets a `notifications`
// row referencing the activity just written. `message` is left unset: the
// notifications UI reads the linked `activity` row (actor + action) for
// display text, per `Notifications.message`'s own doc comment ("fallback...
// for a notification with no backing activity row" — there always is one
// here).
async function notifyFollowers({
  payload,
  entityType,
  entityId,
  activityId,
  actorId,
}: {
  payload: BasePayload
  entityType: EntityType
  entityId: string
  activityId: number
  actorId: number | null
}) {
  const followers = await payload.find({
    collection: 'followers',
    where: { entityType: { equals: entityType }, entityId: { equals: entityId } },
    limit: 500,
    overrideAccess: true,
  })
  const recipients = followers.docs
    .map((f) => (typeof f.user === 'number' ? f.user : f.user.id))
    .filter((userId) => userId !== actorId)

  await Promise.all(
    recipients.map((userId) =>
      payload.create({
        collection: 'notifications',
        data: { user: userId, activity: activityId, isRead: false },
        overrideAccess: true,
      }),
    ),
  )
}

// Depth-agnostic relationship-id extraction — same inline ternary used
// throughout this codebase's actions/hooks, factored out here since the
// update-diff hooks in both Tasks.ts and Pages.ts need it repeatedly.
export function relId(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') return value
  if (typeof value === 'object' && 'id' in (value as { id?: unknown })) {
    return (value as { id: number }).id
  }
  return null
}
