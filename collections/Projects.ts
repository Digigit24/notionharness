import type { CollectionConfig } from 'payload'
import { inMyWorkspaces } from './access'

// ROADMAP P2.1 — a workspace's projects, the grouping unit above tasks.
// Deliberately minimal for this pass (2.5's task/project surfaces are what
// actually renders these) — name/icon/description only.
export const Projects: CollectionConfig = {
  slug: 'projects',
  // Ordinary workspace content: everyone in the workspace, nobody outside it.
  access: {
    read: inMyWorkspaces(),
    create: inMyWorkspaces(),
    update: inMyWorkspaces(),
    delete: inMyWorkspaces(),
  },
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
      defaultValue: 'Untitled',
    },
    {
      name: 'workspace',
      type: 'relationship',
      relationTo: 'workspaces',
      required: true,
      hasMany: false,
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
      name: 'description',
      type: 'textarea',
    },
  ],
}

export default Projects
