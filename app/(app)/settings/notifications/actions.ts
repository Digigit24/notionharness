'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import type { NotificationPreference } from '@/payload-types'

// ROADMAP B5.3 (Batch B-5 "Attention") — real per-event notification
// preferences, one row per user (collections/NotificationPreferences.ts's
// `unique: true` on `user` is the actual guarantee; this file additionally
// upserts defensively rather than assuming a row already exists, since the
// common case for a user's first visit to this page is "no row yet"). All
// four fields exist on the collection; a field left `undefined` in an
// update call is left untouched by Payload, not nulled out.
//
// Requires migrations/20260902_140000_push_notifications.ts to be applied —
// see collections/NotificationPreferences.ts's header comment. Until then
// these calls throw the same honest "relation does not exist" error every
// other unapplied-migration collection in this repo produces; the page
// component below catches that and renders an honest "not set up yet" state
// instead of crashing.

export interface NotificationPreferencesView {
  pushApprovals: boolean
  pushCompletions: boolean
  pushMentions: boolean
  emailDigestEnabled: boolean
}

const DEFAULTS: NotificationPreferencesView = {
  pushApprovals: true,
  pushCompletions: true,
  pushMentions: true,
  emailDigestEnabled: false,
}

function toView(doc: NotificationPreference | undefined): NotificationPreferencesView {
  if (!doc) return DEFAULTS
  return {
    pushApprovals: doc.pushApprovals ?? true,
    pushCompletions: doc.pushCompletions ?? true,
    pushMentions: doc.pushMentions ?? true,
    emailDigestEnabled: doc.emailDigestEnabled ?? false,
  }
}

export async function getNotificationPreferences(): Promise<NotificationPreferencesView> {
  const user = await getCurrentPayloadUser()
  if (!user) return DEFAULTS
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'notification-preferences',
    where: { user: { equals: user.id } },
    limit: 1,
    overrideAccess: true,
  })
  return toView(result.docs[0])
}

export async function updateNotificationPreferences(patch: Partial<NotificationPreferencesView>): Promise<void> {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in to change notification preferences.')

  const payload = await getPayloadClient()
  const existing = await payload.find({
    collection: 'notification-preferences',
    where: { user: { equals: user.id } },
    limit: 1,
    overrideAccess: true,
  })

  if (existing.docs[0]) {
    await payload.update({
      collection: 'notification-preferences',
      id: existing.docs[0].id,
      data: patch,
      overrideAccess: true,
    })
  } else {
    await payload.create({
      collection: 'notification-preferences',
      data: { user: user.id, ...DEFAULTS, ...patch },
      overrideAccess: true,
    })
  }

  revalidatePath('/settings/notifications')
}
