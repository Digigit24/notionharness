import type { CollectionConfig } from 'payload'

// ROADMAP P2.1 — task-only for this pass (generalizing to any entity is a
// later concern if it turns out to matter — no need to build that now).
export const Comments: CollectionConfig = {
  slug: 'comments',
  fields: [
    {
      name: 'task',
      type: 'relationship',
      relationTo: 'tasks',
      required: true,
      hasMany: false,
      index: true,
    },
    {
      name: 'author',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      hasMany: false,
    },
    {
      name: 'body',
      type: 'textarea',
      required: true,
    },
  ],
}

export default Comments
