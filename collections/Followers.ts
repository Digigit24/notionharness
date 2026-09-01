import type { CollectionConfig } from 'payload'

// ROADMAP P2.1/2.6 — "a user follows an entity" ... "follows drive
// notifications." `entityType`/`entityId` (not Payload's native
// `relationTo: [...]` polymorphic-relationship field) for the same reason
// `activity` uses the same pair — see that collection's comment. Extensible:
// adding a new entityType value only needs an `ALTER TYPE ... ADD VALUE`
// migration for the underlying Postgres enum (see
// `migrations/20260902_060000_followers_page_entity_type.ts`), not a
// collection/field shape change. `page` added in P2.6 alongside Pages'
// create-activity auto-follow.
export const FOLLOWABLE_ENTITY_TYPES = ['task', 'project', 'page'] as const

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
