import type { CollectionConfig } from 'payload'

export const Workspaces: CollectionConfig = {
  slug: 'workspaces',
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
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
    },
    {
      name: 'icon',
      type: 'text',
      admin: {
        description: 'Emoji or icon identifier',
      },
    },
    {
      name: 'owner',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      hasMany: false,
    },
    {
      name: 'members',
      type: 'relationship',
      relationTo: 'users',
      hasMany: true,
    },
    {
      name: 'taskPrefix',
      type: 'text',
      admin: {
        description: 'Short, human-readable task-id prefix for this workspace (e.g. "ENG") — combined with taskCounter for IDs like ENG-142. Not yet surfaced in any UI.',
      },
    },
    {
      name: 'taskCounter',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Last-issued sequence number for this workspace\'s human-readable task IDs — increment and read atomically when actually wiring ENG-142-style IDs.',
      },
    },
  ],
}

export default Workspaces
