import type { CollectionConfig } from 'payload'

export const RuntimeProfiles: CollectionConfig = {
  slug: 'runtime-profiles',
  admin: { useAsTitle: 'commandName' },
  fields: [
    { name: 'name', type: 'text', required: true, defaultValue: 'ACP runtime' },
    { name: 'workspace', type: 'relationship', relationTo: 'workspaces', required: true, index: true },
    { name: 'protocolFamily', type: 'select', required: true, options: [{ label: 'ACP', value: 'acp' }, { label: 'MCP', value: 'mcp' }] },
    { name: 'commandName', type: 'text', required: true },
    { name: 'fixedArgs', type: 'json', defaultValue: [] },
    { name: 'enabled', type: 'checkbox', defaultValue: true },
  ],
}

export default RuntimeProfiles
