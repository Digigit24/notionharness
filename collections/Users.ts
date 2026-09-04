import type { CollectionConfig } from 'payload'
import { isAppAdmin } from './access'

/**
 * Phase 0 — the account table, and the one collection where an open default
 * was an escalation path rather than a disclosure.
 *
 * Payload 3.88 defaults a collection with no `access` block to
 * `({ req: { user } }) => Boolean(user)` (verified in
 * `node_modules/payload/dist/auth/defaultAccess.js`), which on THIS collection
 * meant any authenticated Payload user could PATCH any other user's `role`,
 * `email` or `password` over the REST API, and — because `useAPIKey` is on —
 * mint a long-lived API key on somebody else's account. Nothing in the app
 * depends on that: every user read and write in `lib/current-user.ts` and
 * everywhere else goes through the Local API with `overrideAccess: true`.
 *
 * So writes here are the operator's alone, and a person can read themselves.
 * REJECTED ALTERNATIVE: letting a user update their own row so they could edit
 * `name`/`avatar` over REST. No screen does that — the app writes those through
 * the Local API — and allowing self-update would have to be paired with
 * field-level guards on `role`, `email`, `password` and the two injected API-key
 * fields, four of which Payload adds itself and one of which it would keep
 * adding as the auth feature grows. A narrower rule that cannot rot beats a
 * wider one that depends on remembering to guard every future field.
 */
export const Users: CollectionConfig = {
  slug: 'users',
  access: {
    // Yourself, or the operator. Listing the install's users is not something
    // a workspace member needs from this API — the app renders member lists
    // from `workspace-members` through the Local API.
    read: ({ req }) => {
      if (!req.user) return false
      if (isAppAdmin(req.user)) return true
      return { id: { equals: req.user.id } }
    },
    create: ({ req }) => isAppAdmin(req.user),
    update: ({ req }) => isAppAdmin(req.user),
    delete: ({ req }) => isAppAdmin(req.user),
    // Who may open Payload's own `/admin` panel at all. Nobody signs in there
    // as part of using the product (`getCurrentPayloadUser` gives every shadow
    // account a random 32-byte password nothing ever reveals), so this is the
    // operator's door and should read as one.
    admin: ({ req }) => isAppAdmin(req.user),
  },
  auth: {
    useAPIKey: true,
  },
  admin: {
    useAsTitle: 'email',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
    },
    {
      name: 'avatar',
      type: 'text',
      admin: {
        description: 'URL to the user avatar image',
      },
    },
    {
      // Belt and braces on top of the collection-level `update` above: this is
      // the field that decides who is the operator, so it states its own rule
      // rather than inheriting one that a later edit could widen by accident.
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'member',
      access: {
        create: ({ req }) => isAppAdmin(req.user),
        update: ({ req }) => isAppAdmin(req.user),
      },
      options: [
        { label: 'Admin', value: 'admin' },
        { label: 'Member', value: 'member' },
      ],
    },
  ],
}

export default Users
