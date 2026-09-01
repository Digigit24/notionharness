import type { CollectionConfig } from 'payload'

export const TeableDatabases: CollectionConfig = {
  slug: 'teable-databases',
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'workspace',
      type: 'relationship',
      relationTo: 'workspaces',
      required: true,
      hasMany: false,
    },
    {
      name: 'teableTableId',
      type: 'text',
      required: true,
      admin: {
        description: 'Teable table ID',
      },
    },
    {
      name: 'teableBaseId',
      type: 'text',
      required: true,
      admin: {
        description: 'Teable base ID (required by the Teable REST API alongside the table ID)',
      },
    },
  ],
}

export default TeableDatabases
