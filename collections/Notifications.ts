import type { CollectionConfig } from 'payload'

// ROADMAP P2.1/2.6 — "follows drive notifications." `activity` is optional:
// most notifications will reference the activity row that caused them, but
// `message` is a fallback minimal shape for anything that doesn't (or
// doesn't yet) have a backing activity row.
export const Notifications: CollectionConfig = {
  slug: 'notifications',
  fields: [
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      hasMany: false,
      index: true,
    },
    {
      name: 'activity',
      type: 'relationship',
      relationTo: 'activity',
      hasMany: false,
    },
    {
      name: 'message',
      type: 'text',
      admin: {
        description: 'Fallback display text for a notification with no backing activity row.',
      },
    },
    {
      name: 'isRead',
      type: 'checkbox',
      defaultValue: false,
      index: true,
    },
  ],
}

export default Notifications
