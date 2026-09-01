import type { CollectionConfig } from 'payload'

// ROADMAP P2.2/D-level decision — a workspace defines its own named statuses
// (whatever a team calls their workflow stages), but EVERY status carries a
// `category` that is one of exactly 7 fixed values. Board grouping, any
// future automation, and the broker (Pillar 4) must all read `category`,
// never the free-text `name` — "this is how you get custom workflow without
// every consumer having to handle an unknown string, and it is genuinely
// impossible to retrofit." `name` is the only thing the UI ever shows a user.
export const TASK_STATUS_CATEGORIES = ['backlog', 'todo', 'inProgress', 'inReview', 'done', 'blocked', 'cancelled'] as const

export const TaskStatuses: CollectionConfig = {
  slug: 'task-statuses',
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'workspace',
      type: 'relationship',
      relationTo: 'workspaces',
      required: true,
      hasMany: false,
      index: true,
    },
    {
      name: 'name',
      type: 'text',
      required: true,
      admin: {
        description: 'Free-text, per-workspace label (e.g. "Backlog", "In Progress", "Blocked on design"). Never read by anything except the UI — see category.',
      },
    },
    {
      name: 'category',
      type: 'select',
      required: true,
      options: TASK_STATUS_CATEGORIES.map((value) => ({ label: value, value })),
      admin: {
        description: 'The fixed vocabulary every consumer (board grouping, automation, the broker) reads instead of name.',
      },
    },
    {
      name: 'color',
      type: 'text',
      admin: {
        description: 'Optional display color token for the status chip/column header.',
      },
    },
    {
      name: 'position',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Manual ordering of statuses within a workspace (e.g. left-to-right board column order).',
      },
    },
  ],
}

export default TaskStatuses
