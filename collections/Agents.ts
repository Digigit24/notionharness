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
    { name: 'hermesProfile', type: 'text' },
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
