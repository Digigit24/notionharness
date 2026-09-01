import type { CollectionConfig } from 'payload'

export const Pages: CollectionConfig = {
  slug: 'pages',
  admin: {
    useAsTitle: 'title',
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      required: true,
      defaultValue: 'Untitled',
    },
    {
      name: 'icon',
      type: 'text',
      admin: {
        description: 'Emoji used as the page icon',
      },
    },
    {
      name: 'coverImage',
      type: 'text',
      admin: {
        description: 'URL of the page cover image',
      },
    },
    {
      name: 'workspace',
      type: 'relationship',
      relationTo: 'workspaces',
      required: true,
      hasMany: false,
    },
    {
      name: 'linkedSourceType',
      type: 'select',
      options: [
        { label: 'User Database', value: 'userDatabase' },
        { label: 'Payload Collection', value: 'payload' },
      ],
      admin: {
        description:
          'Which DataSource backend this page mirrors a row from, if any — set together with linkedSourceId/linkedRecordId. Empty for a regular, unlinked page.',
      },
    },
    {
      name: 'linkedSourceId',
      type: 'text',
      index: true,
      admin: {
        description: "The linked backend's own identifier: a `databases` doc id for 'userDatabase', or a collection slug for 'payload'.",
      },
    },
    {
      name: 'linkedRecordId',
      type: 'text',
      index: true,
      admin: {
        description: 'The specific row/document id within linkedSourceId.',
      },
    },
    {
      name: 'parentPage',
      type: 'relationship',
      relationTo: 'pages',
      hasMany: false,
      admin: {
        description: 'Parent page for infinite nesting; empty for a top-level page',
      },
    },
    {
      name: 'position',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Manual drag-and-drop ordering within the sidebar',
      },
    },
    {
      name: 'docState',
      type: 'json',
      admin: {
        description: 'BlockSuite / Yjs document snapshot',
      },
    },
    {
      name: 'plainTextContent',
      type: 'textarea',
      admin: {
        description: 'Auto-extracted plain text used for search and agent context',
      },
    },
    {
      name: 'isFavorite',
      type: 'checkbox',
      defaultValue: false,
    },
    {
      name: 'isArchived',
      type: 'checkbox',
      defaultValue: false,
    },
    {
      name: 'isFullWidth',
      type: 'checkbox',
      defaultValue: false,
    },
    {
      name: 'isLocked',
      type: 'checkbox',
      defaultValue: false,
    },
  ],
}

export default Pages
