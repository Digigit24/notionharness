import type { CollectionConfig } from 'payload'
import { ownedByMe } from './access'

// ROADMAP B5.3 (Batch B-5 "Attention") — per-user, per-event toggles for
// real notification delivery. One row per user, enforced at the DB level by
// `unique: true` on `user` (not application logic) — a duplicate create
// fails outright rather than silently shadowing an earlier row.
//
// Defaults are all "on" for push: the plan's own framing ("agents work
// while I am away... a fact, not a claim") only holds if delivery is
// opt-out, not opt-in-and-therefore-usually-off. The email digest defaults
// "off" since it's a bigger ask (a recurring email) and, honestly, its
// actual sending isn't wired up yet — see lib/notifications/digest.ts's
// header comment for the real vs. not-yet-real split.
//
// NOT YET PHYSICALLY APPLIED — same "written, not applied" discipline as
// collections/PushSubscriptions.ts; see that file's header comment.
export const NotificationPreferences: CollectionConfig = {
  slug: 'notification-preferences',
  // One person's own settings. Nobody else has a reason to read them and
  // nobody at all has a reason to change them on somebody's behalf.
  access: {
    read: ownedByMe(),
    create: ownedByMe(),
    update: ownedByMe(),
    delete: ownedByMe(),
  },
  admin: { useAsTitle: 'user' },
  fields: [
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      unique: true,
      index: true,
    },
    {
      name: 'pushApprovals',
      type: 'checkbox',
      defaultValue: true,
      admin: { description: 'Push a browser notification when a new approval needs this user.' },
    },
    {
      name: 'pushCompletions',
      type: 'checkbox',
      defaultValue: true,
      admin: { description: 'Push a browser notification when a run this user is accountable/originating for completes or fails.' },
    },
    {
      name: 'pushMentions',
      type: 'checkbox',
      defaultValue: true,
      admin: { description: 'Push a browser notification when this user is @mentioned.' },
    },
    {
      name: 'emailDigestEnabled',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description:
          'Opt-in daily email digest (pending approvals + completions since the last digest). The digest query itself is real (lib/notifications/digest.ts); actual email sending/scheduling is an explicitly documented gap, not faked — see that file.',
      },
    },
  ],
}

export default NotificationPreferences
