import type { CollectionConfig } from 'payload'
import { WORKSPACE_ROLES } from './WorkspaceMembers'

/**
 * An invitation to a workspace, optionally landing in a channel.
 *
 * WHY THE TOKEN IS THE WHOLE MECHANISM. An invite has to work for somebody who
 * does not have an account yet — that is most of them — so it cannot be keyed
 * on a user id. It is keyed on a random token that arrives in a link, and the
 * ACCEPT step is what binds it to whoever is signed in at that moment. That
 * ordering matters: binding at send time would mean an invite to
 * `ritik@example.com` could be accepted by anybody who saw the link and had an
 * account, which is the classic invite-link privilege bug.
 *
 * `email` is still recorded and still checked on accept, so a link forwarded to
 * somebody else is refused rather than silently granting them a seat.
 *
 * WHY `channel` IS OPTIONAL AND ON THE INVITE. "Invite somebody to a channel"
 * has two cases. If they are already in the workspace it is not an invite at
 * all — it is adding a row to `team_members`, which needs no token and no
 * email. If they are not, the invite has to carry the channel through the
 * signup so they land where they were invited rather than in an empty
 * workspace wondering what they were sent. One nullable column buys that.
 *
 * EXPIRY IS A COLUMN, NOT A CRON. Nothing sweeps this table. `status` stays
 * `pending` past `expiresAt` and the accept path refuses it — a sweeper that
 * flips rows to `expired` would be a second writer of the same fact and would
 * be wrong for exactly as long as it was down.
 */
export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked'] as const

export const Invitations: CollectionConfig = {
  slug: 'invitations',
  admin: { useAsTitle: 'email', defaultColumns: ['email', 'workspace', 'role', 'status'] },
  access: {
    // The accept path reads by token through the Local API with
    // `overrideAccess`, so this can stay shut to the public API entirely.
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  fields: [
    { name: 'workspace', type: 'relationship', relationTo: 'workspaces', required: true, index: true },
    { name: 'email', type: 'text', required: true, index: true },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'member',
      // `owner` is deliberately absent: ownership is transferred, never
      // invited. Two owners is a state nothing else in the model expects.
      options: WORKSPACE_ROLES.filter((role) => role !== 'owner').map((value) => ({ label: value, value })),
    },
    {
      name: 'token',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: { description: 'Random, single-use. The link is the credential, so it is never displayed after creation.' },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      options: INVITATION_STATUSES.map((value) => ({ label: value, value })),
    },
    { name: 'invitedBy', type: 'relationship', relationTo: 'users', required: true },
    { name: 'acceptedBy', type: 'relationship', relationTo: 'users' },
    { name: 'expiresAt', type: 'date', required: true },
    {
      name: 'channelId',
      type: 'number',
      admin: {
        description:
          'Optional broker `teams.id` to join on accept. A number rather than a relationship because channels live in the raw-pg broker, not in Payload.',
      },
    },
  ],
}

export default Invitations
