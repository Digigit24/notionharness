import type { CollectionConfig } from 'payload'

/**
 * One person's authorised account at one third-party app.
 *
 * THE MAPPING DECISION THIS TABLE EXISTS TO ENFORCE: a Composio entity is OUR
 * USER, never our workspace. If entities were workspaces, everyone in a
 * workspace would share one Gmail connection and no audit record could ever
 * say whose mailbox an agent read. That is not a gap you can close later —
 * the information was never captured. So: one row per (user, workspace,
 * toolkit), and the entity id we hand Composio is derived from the user.
 *
 * WHY IT IS SCOPED TO A WORKSPACE TOO, GIVEN THE ENTITY IS THE USER. Because
 * leaving a workspace has to be able to remove your access to its agents
 * without revoking a connection you also use somewhere else. The row is the
 * grant of that connection TO that workspace; the credential itself lives at
 * Composio under your entity.
 *
 * NO TOKENS ARE STORED HERE. Composio holds the credential; this holds its id
 * and its status. That is deliberate and it is most of the reason for using a
 * broker at all — a refresh token in this database is a breach waiting for a
 * backup to be copied somewhere careless.
 */
export const CONNECTION_STATUSES = ['pending', 'active', 'failed', 'revoked'] as const

export const Connections: CollectionConfig = {
  slug: 'connections',
  admin: { useAsTitle: 'toolkitSlug', defaultColumns: ['user', 'toolkitSlug', 'status'] },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  fields: [
    { name: 'workspace', type: 'relationship', relationTo: 'workspaces', required: true, index: true },
    { name: 'user', type: 'relationship', relationTo: 'users', required: true, index: true },
    { name: 'toolkitSlug', type: 'text', required: true, index: true },
    {
      name: 'composioConnectedAccountId',
      type: 'text',
      index: true,
      admin: { description: "Composio's id for this authorised account. Null while the auth flow is still open." },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      options: CONNECTION_STATUSES.map((value) => ({ label: value, value })),
    },
    {
      name: 'statusDetail',
      type: 'text',
      admin: { description: "Whatever the provider said when it went wrong. The most useful string on the screen when it does." },
    },
    {
      name: 'redirectUrl',
      type: 'text',
      admin: {
        description:
          'The URL the person has to visit to authorise. Held while the flow is open so a run parked on a connection can show the same link again rather than starting a second flow.',
      },
    },
    {
      name: 'requestedByRun',
      type: 'number',
      admin: {
        description:
          'The broker run id that asked for this connection, when an agent asked mid-turn. A number because runs are raw-pg, not Payload.',
      },
    },
    { name: 'lastCheckedAt', type: 'date' },
  ],
}

export default Connections
