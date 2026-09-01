import type { CollectionConfig } from 'payload'

export const Runtimes: CollectionConfig = {
  slug: 'runtimes',
  admin: { useAsTitle: 'name' },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'workspace', type: 'relationship', relationTo: 'workspaces', required: true, index: true },
    { name: 'runtimeProfile', type: 'relationship', relationTo: 'runtime-profiles', required: true, index: true },
    { name: 'host', type: 'text', required: true },
    { name: 'connectionInfo', type: 'json', defaultValue: {} },
    { name: 'status', type: 'select', required: true, defaultValue: 'unknown', options: [{ label: 'Up', value: 'up' }, { label: 'Down', value: 'down' }, { label: 'Unknown', value: 'unknown' }] },
    { name: 'lastCheckedAt', type: 'date' },
  ],
}

export default Runtimes
