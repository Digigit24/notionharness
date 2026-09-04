import type { CollectionConfig } from 'payload'

export const Agents: CollectionConfig = {
  slug: 'agents',
  admin: { useAsTitle: 'name' },
  fields: [
    { name: 'name', type: 'text', required: true, defaultValue: 'New agent' },
    { name: 'workspace', type: 'relationship', relationTo: 'workspaces', required: true, index: true },
    { name: 'runtimeProfile', type: 'relationship', relationTo: 'runtime-profiles', required: true },
    { name: 'model', type: 'text' },
    // Which Hermes profile this agent runs as. Empty/absent = the install
    // default, i.e. exactly today's behaviour. A profile directory IS a
    // complete HERMES_HOME (own config.yaml, auth.json, SOUL.md, skills,
    // memories), so this is what makes a different MODEL per agent possible
    // without any CLI flag — `hermes-acp` has none. Stored as a plain name,
    // not a relationship, because the Hermes install on disk is the
    // authority for which profiles exist; mirroring that into this database
    // would only create a second copy to desynchronise.
    // Hermes-specific: a Hermes profile directory is a complete alternate
    // HERMES_HOME, so choosing one chooses that agent's model, provider and
    // credentials. Meaningless for any other runtime, which is why the
    // settings form only offers it when the selected runtime uses the Hermes
    // home strategy.
    { name: 'hermesProfile', type: 'text' },
    /**
     * Values for the settings this agent's RUNTIME declares about itself.
     *
     * `{ [optionId]: value }`, applied with `session/set_config_option` after
     * the session opens. Deliberately opaque: the option ids, their types and
     * their allowed values all come from the runtime's own `session/new`
     * response, so a new runtime's settings need no schema change and no new
     * screen here. Storing a typed field per known option would put us back
     * in the business of maintaining a capability matrix, which D2 exists to
     * avoid.
     */
    { name: 'runtimeConfig', type: 'json', defaultValue: {} },
    { name: 'thinkingLevel', type: 'select', defaultValue: 'medium', options: [{ label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }] },
    { name: 'instructions', type: 'textarea' },
    { name: 'customEnv', type: 'json', defaultValue: {} },
    { name: 'customArgs', type: 'json', defaultValue: [] },
    { name: 'mcpConfig', type: 'json', defaultValue: {} },
    { name: 'skills', type: 'json', defaultValue: [] },
    { name: 'maxConcurrentRuns', type: 'number', min: 1, defaultValue: 1 },
    { name: 'permissionMode', type: 'select', required: true, defaultValue: 'ask', options: [{ label: 'Ask before actions', value: 'ask' }, { label: 'Auto-approve', value: 'auto' }, { label: 'Deny actions', value: 'deny' }] },
    { name: 'enabled', type: 'checkbox', defaultValue: true },
  ],
}

export default Agents
