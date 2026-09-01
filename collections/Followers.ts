import type { CollectionConfig } from 'payload'

// ROADMAP P2.1/2.6 — "a user follows an entity" ... "follows drive
// notifications." `entityType`/`entityId` (not Payload's native
// `relationTo: [...]` polymorphic-relationship field) for the same reason
// `activity` uses the same pair — see that collection's comment. Extensible:
// add a new entityType value when a new followable entity shows up, no
// schema change needed.
export const FOLLOWABLE_ENTITY_TYPES = ['task', 'project'] as const

export const Followers: CollectionConfig = {
  slug: 'followers',
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
      name: 'entityType',
      type: 'select',
      required: true,
      options: FOLLOWABLE_ENTITY_TYPES.map((value) => ({ label: value, value })),
    },
    {
      name: 'entityId',
      type: 'text',
      required: true,
      index: true,
    },
  ],
}

export default Followers
