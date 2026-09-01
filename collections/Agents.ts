import type { CollectionConfig } from 'payload'

export const Agents: CollectionConfig = {
  slug: 'agents',
  admin: { useAsTitle: 'name' },
  fields: [
    { name: 'name', type: 'text', required: true, defaultValue: 'New agent' },
    { name: 'workspace', type: 'relationship', relationTo: 'workspaces', required: true, index: true },
    { name: 'runtimeProfile', type: 'relationship', relationTo: 'runtime-profiles', required: true },
    { name: 'model', type: 'text' },
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
