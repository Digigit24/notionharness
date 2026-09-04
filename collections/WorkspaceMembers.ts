import type { CollectionConfig } from 'payload'

/**
 * Who is in a workspace, and what they may do.
 *
 * WHY A JOIN COLLECTION RATHER THAN THE ARRAY THAT WAS THERE.
 * `workspaces.members` was a flat list of user relationships with no role on
 * it, which made three things impossible at once: a member could not be
 * anything other than a full member; "which workspaces am I in" required
 * scanning every workspace document; and there was nowhere to record who added
 * somebody or when. All three are things a paying team asks about on day one.
 *
 * The old array is deliberately LEFT IN PLACE and kept in sync rather than
 * dropped. Payload's own collection `access` rules read it
 * (`collections/Workspaces.ts`), the workspace layout reads it, and rewriting
 * every one of those in the same change as introducing roles would mean the
 * permission model and the migration failing together. It is the legacy index;
 * this is the truth.
 *
 * ROLES, AND WHY ONLY FOUR.
 * `owner` (exactly one, the person who created it — can delete the workspace
 * and transfer it), `admin` (everything but delete/transfer), `member` (the
 * normal working role) and `viewer` (read-only). A fifth role is a support
 * question every time somebody has to explain the difference between two of
 * them; four is the smallest set that separates "can change the bill" from
 * "can change the work" from "can only look".
 */
export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export const WorkspaceMembers: CollectionConfig = {
  slug: 'workspace-members',
  admin: { useAsTitle: 'id', defaultColumns: ['workspace', 'user', 'role'] },
  // Every read in the app goes through the Local API with `overrideAccess`,
  // and the permission layer (`lib/permissions`) is what actually decides.
  // These rules exist only to close Payload's own public REST/GraphQL surface,
  // which defaults to fully open.
  access: {
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  fields: [
    { name: 'workspace', type: 'relationship', relationTo: 'workspaces', required: true, index: true },
    { name: 'user', type: 'relationship', relationTo: 'users', required: true, index: true },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'member',
      index: true,
      options: WORKSPACE_ROLES.map((value) => ({ label: value, value })),
    },
    {
      name: 'invitedBy',
      type: 'relationship',
      relationTo: 'users',
      admin: { description: 'Null for the owner row created with the workspace itself.' },
    },
  ],
}

export default WorkspaceMembers
