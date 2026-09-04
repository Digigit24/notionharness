import type { CollectionConfig } from 'payload'

/**
 * Per-object access, for the three things inside a workspace that are worth
 * restricting separately: a project, an agent, and a channel.
 *
 * WHY ONE TABLE INSTEAD OF THREE. The three questions are the same shape —
 * "may this subject do that verb to this object" — and the surfaces that ask
 * them are identical (a share dialog, a members list, a permission check in a
 * server action). Three tables would be three sets of the same query, three
 * migrations every time a role is added, and three places for the check to
 * drift. The cost is a polymorphic `objectId`, which this codebase already
 * accepted for exactly this reason in `collections/Activity.ts`.
 *
 * WHY A SUBJECT CAN BE AN AGENT. An agent is a real actor here — it runs, it
 * writes, it calls tools — and "which agents may read this project" is a
 * question with a different answer from "which people may". Modelling it as a
 * second subject kind rather than as a magic user row means the intersection
 * rule in `lib/permissions` can be stated exactly once.
 *
 * THE ABSENT-ROW RULE. No grant does NOT mean no access: a workspace admin can
 * open every project in their workspace without a row here. A grant only ever
 * ADDS to what workspace membership already gives, and `visibility` on the
 * object itself is what takes access away. That ordering is the thing to keep
 * straight — an ACL that can both add and subtract is one nobody can reason
 * about at three in the morning.
 */
export const GRANT_OBJECT_TYPES = ['project', 'agent', 'channel'] as const
export const GRANT_ROLES = ['viewer', 'editor', 'admin'] as const

export type GrantObjectType = (typeof GRANT_OBJECT_TYPES)[number]
export type GrantRole = (typeof GRANT_ROLES)[number]

export const AccessGrants: CollectionConfig = {
  slug: 'access-grants',
  admin: { useAsTitle: 'id', defaultColumns: ['objectType', 'objectId', 'subjectUser', 'role'] },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  fields: [
    { name: 'workspace', type: 'relationship', relationTo: 'workspaces', required: true, index: true },
    {
      name: 'objectType',
      type: 'select',
      required: true,
      index: true,
      options: GRANT_OBJECT_TYPES.map((value) => ({ label: value, value })),
    },
    {
      name: 'objectId',
      type: 'text',
      required: true,
      index: true,
      admin: { description: 'Text, because a channel id is a broker bigint and a project id is a Payload integer.' },
    },
    {
      name: 'subjectUser',
      type: 'relationship',
      relationTo: 'users',
      index: true,
      admin: { description: 'Exactly one of subjectUser / subjectAgent is set.' },
    },
    { name: 'subjectAgent', type: 'relationship', relationTo: 'agents', index: true },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'viewer',
      options: GRANT_ROLES.map((value) => ({ label: value, value })),
    },
    { name: 'grantedBy', type: 'relationship', relationTo: 'users' },
  ],
}

export default AccessGrants
