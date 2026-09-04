import type { CollectionConfig } from 'payload'
import { inMyAdministeredWorkspaces } from './access'

/**
 * R4.1 — the plugin layer: tools this product gives an agent, as data.
 *
 * This is deliberately a different thing from the MCP settings screen, and
 * the difference is ownership. That screen reads and toggles servers inside
 * the runtime's OWN config (`config.yaml: mcp_servers`), which Hermes owns
 * and `hermes mcp add` edits behind our back — so we mirror nothing there and
 * write no ownership into it (R4.3). These rows are the opposite: servers
 * WE own, scoped to a workspace, injected into a run at `session/new` time
 * and gone again when the turn ends. The runtime never learns they exist
 * between turns.
 *
 * That separation is what makes per-agent and, later, per-team tool access
 * possible at all. A tool written into a runtime's config file is available
 * to every agent that runtime ever runs, forever, with no scope and no way to
 * revoke it for one agent but not another.
 *
 * Everything here is optional and nothing is implicit: an agent gets exactly
 * the plugins it is scoped to and no others, and a plugin that is disabled is
 * simply absent from the session rather than present-but-refusing.
 */
export const Plugins: CollectionConfig = {
  slug: 'plugins',
  // `headers` and `env` hold third-party API tokens (see those fields' own
  // comments), so this is `administer`-level in BOTH directions — a plain
  // member reading them is already the leak. Demonstrated live before this
  // block existed: a user belonging to no workspace read every plugin row in
  // the install, header values included.
  access: {
    read: inMyAdministeredWorkspaces(),
    create: inMyAdministeredWorkspaces(),
    update: inMyAdministeredWorkspaces(),
    delete: inMyAdministeredWorkspaces(),
  },
  admin: { useAsTitle: 'name', defaultColumns: ['name', 'transport', 'enabled'] },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'workspace', type: 'relationship', relationTo: 'workspaces', required: true, index: true },
    {
      name: 'description',
      type: 'textarea',
      admin: { description: 'Shown wherever this plugin is offered. What it lets an agent do, in a sentence.' },
    },
    // Transport first, because it decides which of the fields below apply.
    // The ACP schema itself carries http, sse and stdio variants — verified in
    // `@agentclientprotocol/sdk`'s own zod definitions, not assumed — so
    // supporting all three is reading the protocol rather than extending it.
    //
    // HTTP is the default on purpose (R4.2). AionUi gates team tool access on
    // `mcpCapabilities.stdio` because their agent processes sit on the same
    // machine as the tools. Ours do not: an agent may run on a different
    // machine from the server hosting the tool, and a stdio-only design would
    // make that arrangement impossible rather than merely awkward.
    {
      name: 'transport',
      type: 'select',
      required: true,
      defaultValue: 'http',
      options: [
        { label: 'HTTP', value: 'http' },
        { label: 'SSE', value: 'sse' },
        { label: 'stdio (local process)', value: 'stdio' },
      ],
    },
    {
      name: 'url',
      type: 'text',
      admin: {
        condition: (data) => data?.transport === 'http' || data?.transport === 'sse',
        description: 'Absolute URL of the MCP endpoint.',
      },
    },
    {
      name: 'command',
      type: 'text',
      admin: { condition: (data) => data?.transport === 'stdio', description: 'Executable to spawn.' },
    },
    {
      name: 'args',
      type: 'json',
      defaultValue: [],
      admin: { condition: (data) => data?.transport === 'stdio' },
    },
    /**
     * Headers for http/sse, as `[{ name, value }]`.
     *
     * This is where an API token for a third-party tool lives, which is why
     * nothing renders a value back to a browser — the settings UI shows names
     * and whether a value is set, never the value itself, matching how this
     * codebase already treats every other credential.
     */
    { name: 'headers', type: 'json', defaultValue: [], admin: { condition: (data) => data?.transport !== 'stdio' } },
    /** Environment for a stdio plugin, as `[{ name, value }]`. Same secrecy rule. */
    { name: 'env', type: 'json', defaultValue: [], admin: { condition: (data) => data?.transport === 'stdio' } },
    { name: 'enabled', type: 'checkbox', defaultValue: true },
    /**
     * Who may use it.
     *
     * `workspace` means every agent in the workspace; `agents` means only the
     * ones listed. Default is `agents` with an empty list, so a freshly
     * created plugin reaches nobody until someone says who — the safe
     * direction for a thing that grants capability.
     */
    {
      name: 'scope',
      type: 'select',
      required: true,
      defaultValue: 'agents',
      options: [
        { label: 'Selected agents only', value: 'agents' },
        { label: 'Every agent in this workspace', value: 'workspace' },
      ],
    },
    {
      name: 'agents',
      type: 'relationship',
      relationTo: 'agents',
      hasMany: true,
      admin: { condition: (data) => data?.scope === 'agents' },
    },
    /**
     * R4.5 — self-describing configuration.
     *
     * `[{ id, label, type: 'select' | 'boolean' | 'string', options?, value }]`,
     * rendered by one generic component. The point is that adding a plugin
     * with settings needs no new screen and no new code: the row describes its
     * own form. Values land in `_meta` on the injected server entry, so a
     * plugin can read its own configuration without us inventing a channel.
     */
    { name: 'configOptions', type: 'json', defaultValue: [] },
  ],
}

export default Plugins
