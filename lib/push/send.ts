// ROADMAP B5.3 (Batch B-5 "Attention") — real Web Push delivery. This is the
// one function every "notify this user right now" call site in the app
// (approval creation, run settlement) reaches for.
//
// Three real, independent prerequisites this file is honest about rather
// than faking around:
//   1. `web-push` must actually be `npm install`ed — it's declared in
//      package.json but this worktree could not run npm install (repo rule
//      for this batch). See package.json's dependency comment.
//   2. `NEXT_PUBLIC_VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` must be real,
//      generated keys (`npx web-push generate-vapid-keys`) set as env vars —
//      these are genuine cryptographic keypairs this agent cannot fabricate
//      or generate without executing code. `ensureConfigured` reads them
//      from `process.env` and no-ops (does not throw) when absent, since an
//      environment with no keys configured yet is this feature's expected
//      starting state, not a bug.
//   3. `migrations/20260902_140000_push_notifications.ts` must actually be
//      applied — until then, both `push-subscriptions` and
//      `notification-preferences` reads below fail with "relation does not
//      exist" and are caught, degrading to a silent no-op (never throwing
//      into the caller, matching every other best-effort notify call in
//      this codebase — see lib/activity.ts's `notifyFollowers`).
import { getPayloadClient } from '@/lib/payload'
import type { NotificationPreference, PushSubscription as StoredPushSubscription } from '@/payload-types'

export type PushEvent = 'approval' | 'completion' | 'mention'

export interface PushMessage {
  title: string
  body: string
  /** App-relative URL the notification should open on click, if any. */
  url?: string | null
}

const PREFERENCE_FIELD: Record<PushEvent, keyof Pick<NotificationPreference, 'pushApprovals' | 'pushCompletions' | 'pushMentions'>> = {
  approval: 'pushApprovals',
  completion: 'pushCompletions',
  mention: 'pushMentions',
}

let vapidConfigured: boolean | null = null

// `webpush` is imported lazily, inside the function that needs it, not at
// module top level — this module is imported from `lib/dispatcher/worker.ts`
// and the approval helper, both of which must keep working (via the no-op
// path below) even when `web-push` genuinely isn't installed yet in a given
// environment. A top-level `import webpush from 'web-push'` would throw at
// module-load time in that case and take down everything that imports this
// file with it.
async function loadWebPush() {
  try {
    const mod = await import('web-push')
    return (mod as unknown as { default?: typeof mod }).default ?? mod
  } catch {
    return null
  }
}

function ensureVapidConfigured(webpush: Awaited<ReturnType<typeof loadWebPush>>): boolean {
  if (!webpush) return false
  if (vapidConfigured !== null) return vapidConfigured

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) {
    console.warn(
      '[push] NEXT_PUBLIC_VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push sends are no-ops until a human generates real VAPID keys (`npx web-push generate-vapid-keys`) and sets both env vars.',
    )
    vapidConfigured = false
    return false
  }

  const subject = process.env.VAPID_SUBJECT || 'mailto:notifications@notionforge.local'
  webpush.setVapidDetails(subject, publicKey, privateKey)
  vapidConfigured = true
  return true
}

/**
 * Sends a real Web Push notification to every subscription `userId` has
 * registered, honoring their per-event NotificationPreferences toggle (a
 * missing preference row — the common case, since a row is only created
 * once a user visits the settings page — defaults to "send," matching the
 * collection's own field defaults). Best-effort throughout: never throws,
 * matching every other fire-and-forget notify call in this codebase (see
 * lib/activity.ts's `notifyFollowers`, worker.ts's live-event append). A
 * subscription the push service reports as gone (410/404) is deleted so it
 * stops being retried on every future event.
 */
export async function sendPushToUser(userId: number, event: PushEvent, message: PushMessage): Promise<void> {
  try {
    const webpush = await loadWebPush()
    if (!ensureVapidConfigured(webpush) || !webpush) return

    const payload = await getPayloadClient()

    const prefsResult = await payload
      .find({
        collection: 'notification-preferences',
        where: { user: { equals: userId } },
        limit: 1,
        overrideAccess: true,
      })
      .catch(() => ({ docs: [] as NotificationPreference[] }))
    const prefs = prefsResult.docs[0]
    const field = PREFERENCE_FIELD[event]
    // Only an explicit `false` opts out — an absent row, or a row that
    // simply hasn't set this field, defaults to "send."
    if (prefs && prefs[field] === false) return

    const subsResult = await payload
      .find({
        collection: 'push-subscriptions',
        where: { user: { equals: userId } },
        limit: 50,
        overrideAccess: true,
      })
      .catch(() => ({ docs: [] as StoredPushSubscription[] }))
    if (subsResult.docs.length === 0) return

    const body = JSON.stringify({ title: message.title, body: message.body, url: message.url ?? null })

    await Promise.all(
      subsResult.docs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
          )
        } catch (err) {
          const statusCode = (err as { statusCode?: number })?.statusCode
          if (statusCode === 404 || statusCode === 410) {
            // The push service says this subscription is dead — prune it so
            // it isn't retried (and doesn't fail loudly) on every future event.
            await payload.delete({ collection: 'push-subscriptions', id: sub.id, overrideAccess: true }).catch(() => undefined)
          } else {
            console.error(`[push] Failed to send to subscription ${sub.id} for user ${userId}.`, err)
          }
        }
      }),
    )
  } catch (err) {
    console.error(`[push] sendPushToUser(${userId}, ${event}) failed unexpectedly.`, err)
  }
}
