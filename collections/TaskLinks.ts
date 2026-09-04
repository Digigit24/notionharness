import type { CollectionConfig } from 'payload'
import { inMyWorkspaces } from './access'

// ROADMAP P2.1 — a directed relationship between two tasks. Kept to a small
// vocabulary on purpose: each type's inverse is implied by swapping
// from/to (fromTask "blocks" toTask == toTask "is blocked by" fromTask), so
// there's no separate stored reverse-direction row or reverse enum value to
// keep in sync.
export const TASK_LINK_TYPES = ['blocks', 'relatesTo', 'parentOf'] as const

export const TaskLinks: CollectionConfig = {
  slug: 'task-links',
  // One hop, through the originating task. Both ends of a link are always in
  // the same workspace, so checking `fromTask` checks both.
  access: {
    read: inMyWorkspaces('fromTask.workspace'),
    create: inMyWorkspaces('fromTask.workspace'),
    update: inMyWorkspaces('fromTask.workspace'),
    delete: inMyWorkspaces('fromTask.workspace'),
  },
  admin: {
    useAsTitle: 'linkType',
  },
  fields: [
    {
      name: 'fromTask',
      type: 'relationship',
      relationTo: 'tasks',
      required: true,
      hasMany: false,
      index: true,
    },
    {
      name: 'toTask',
      type: 'relationship',
      relationTo: 'tasks',
      required: true,
      hasMany: false,
      index: true,
    },
    {
      name: 'linkType',
      type: 'select',
      required: true,
      options: TASK_LINK_TYPES.map((value) => ({ label: value, value })),
    },
  ],
}

export default TaskLinks
