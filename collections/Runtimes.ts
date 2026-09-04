import type { CollectionConfig } from 'payload'
import { inMyWorkspaces, noOne } from './access'

export const Runtimes: CollectionConfig = {
  slug: 'runtimes',
  // Health rows, written only by the health-check writer
  // (`lib/runtimes/hermes/runtime-health.ts`, via `overrideAccess`). A
  // hand-edited "up" is worse than no health data at all, so nothing may write
  // one over this API.
  access: {
    read: inMyWorkspaces(),
    create: noOne,
    update: noOne,
    delete: noOne,
  },
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
