import type { CollectionConfig } from 'payload'
import { inMyWorkspaces } from './access'

// ROADMAP P2.1 — task-only for this pass (generalizing to any entity is a
// later concern if it turns out to matter — no need to build that now).
export const Comments: CollectionConfig = {
  slug: 'comments',
  // One hop: a comment has no workspace of its own, so it borrows its task's.
  access: {
    read: inMyWorkspaces('task.workspace'),
    create: inMyWorkspaces('task.workspace'),
    update: inMyWorkspaces('task.workspace'),
    delete: inMyWorkspaces('task.workspace'),
  },
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
