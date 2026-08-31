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
        description: 'Teable base/table ID',
      },
    },
    {
      name: 'embeddedViewUrl',
      type: 'text',
    },
  ],
}

export default TeableDatabases
