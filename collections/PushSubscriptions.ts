import type { CollectionConfig } from 'payload'

// ROADMAP B5.3 (Batch B-5 "Attention") — one row per browser subscription a
// user has granted for Web Push (a user can have several: multiple browsers/
// devices). `endpoint` is globally unique per the Push API spec (it encodes
// the push service plus a per-subscription id), so it doubles as the
// natural dedupe key on re-subscribe — `app/api/notifications/subscribe/
// route.ts` upserts on it rather than blindly inserting. `p256dh`/`auth` are
// the subscription's public key and auth secret exactly as
// `PushSubscription.toJSON().keys` returns them from the browser — opaque
// strings this app never decodes, only hands back to the `web-push` library
// verbatim when sending (see lib/push/send.ts).
//
// NOT YET PHYSICALLY APPLIED — same "written, not applied" discipline as
// every other schema change this session (see collections/SavedViews.ts's
// header comment for the exact shape of that discipline: this collection IS
// registered in payload.config.ts, and a hand-written migration exists
// (migrations/20260902_140000_push_notifications.ts), but neither has been
// run against the live DB — that's a deliberate human step. Until then, any
// `payload.find`/`create` against `collection: 'push-subscriptions'` fails
// with "relation does not exist," same honest failure mode as every other
// unapplied migration in this repo.
export const PushSubscriptions: CollectionConfig = {
  slug: 'push-subscriptions',
  admin: { useAsTitle: 'endpoint' },
  fields: [
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      index: true,
      admin: { description: 'Who this browser subscription belongs to. A user can have many (multiple browsers/devices).' },
    },
    {
      name: 'endpoint',
      type: 'text',
      required: true,
      unique: true,
      admin: { description: "The PushSubscription's endpoint URL — globally unique per subscription; the upsert key on re-subscribe." },
    },
    {
      name: 'p256dh',
      type: 'text',
      required: true,
      admin: { description: "PushSubscription.toJSON().keys.p256dh — the subscription's public key." },
    },
    {
      name: 'auth',
      type: 'text',
      required: true,
      admin: { description: "PushSubscription.toJSON().keys.auth — the subscription's auth secret." },
    },
    {
      name: 'userAgent',
      type: 'text',
      required: false,
      admin: { description: 'Best-effort context for a human pruning stale subscriptions; never parsed programmatically.' },
    },
  ],
}

export default PushSubscriptions
