import type { CollectionConfig } from 'payload'

/**
 * A third-party app this workspace has switched on, and where it applies.
 *
 * CONNECTOR IS NOT THE SAME THING AS A CONNECTION. This row says "Gmail is
 * available to agents on project 12". `collections/Connections.ts` says "Ritik
 * authorised his own Gmail". The first is configuration a workspace admin
 * makes once; the second is a credential each person grants for themselves.
 * Collapsing the two is the mistake that ends with one person's mailbox being
 * read under somebody else's name, and it cannot be undone after the fact
 * because the audit trail never had the distinction in it.
 *
 * CONNECTOR IS ALSO NOT THE SAME THING AS AN MCP SERVER. An MCP server is a
 * tool surface; a connector is an authorised identity at a third party.
 * Composio sells both, which is why they get conflated. They have different
 * lifecycles — a revoked OAuth token is an identity event, a tool that started
 * returning 500s is a surface event — and one table answers neither well.
 * Our own MCP plugins stay in `collections/Plugins.ts` where they already are.
 *
 * SCOPE, AND WHY RESOLUTION IS A UNION RATHER THAN A PRECEDENCE.
 * A connector row is attached at exactly one level — the workspace, one
 * project, or one agent. What an agent can reach is the UNION of the levels
 * that apply to it, and that is not the obvious choice: a `sessionConfig`-style
 * merge, where the most specific level wins, would mean adding one agent-level
 * connector silently DELETED every workspace-level one for that agent. Tool
 * availability is additive; configuration is not. They look alike and they are
 * not, and getting this backwards produces an agent that mysteriously loses
 * tools the moment somebody grants it one.
 */
export const CONNECTOR_SCOPES = ['workspace', 'project', 'agent'] as const
export type ConnectorScope = (typeof CONNECTOR_SCOPES)[number]

export const Connectors: CollectionConfig = {
  slug: 'connectors',
  admin: { useAsTitle: 'name', defaultColumns: ['name', 'toolkitSlug', 'scopeType', 'enabled'] },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  fields: [
    { name: 'workspace', type: 'relationship', relationTo: 'workspaces', required: true, index: true },
    {
      name: 'provider',
      type: 'select',
      required: true,
      defaultValue: 'composio',
      options: [{ label: 'Composio', value: 'composio' }],
      admin: {
        description:
          'One value today. It is a column rather than an assumption so that a second broker — or a direct OAuth integration we own — does not need a migration.',
      },
    },
    {
      name: 'toolkitSlug',
      type: 'text',
      required: true,
      index: true,
      admin: { description: "Composio's own identifier, e.g. `gmail`, `slack`, `github`. Never a display name." },
    },
    { name: 'name', type: 'text', required: true, admin: { description: 'What a person calls it. Defaults to the toolkit name.' } },
    {
      name: 'scopeType',
      type: 'select',
      required: true,
      defaultValue: 'workspace',
      index: true,
      options: CONNECTOR_SCOPES.map((value) => ({ label: value, value })),
    },
    {
      name: 'scopeId',
      type: 'text',
      index: true,
      admin: { description: 'The project or agent id. Null when `scopeType` is `workspace`.' },
    },
    {
      name: 'authConfigId',
      type: 'text',
      admin: {
        description:
          "Composio's auth-config id for this toolkit. Created once per toolkit per workspace and reused by every person who connects — it is configuration, not a credential.",
      },
    },
    {
      name: 'allowedTools',
      type: 'json',
      defaultValue: [],
      admin: {
        description:
          'Tool slugs an agent may call, or empty for all of them. A connector that grants a whole toolkit when the job needs one action is the difference between "read my calendar" and "send mail as me".',
      },
    },
    { name: 'enabled', type: 'checkbox', defaultValue: true, index: true },
    { name: 'createdBy', type: 'relationship', relationTo: 'users' },
  ],
}

export default Connectors
