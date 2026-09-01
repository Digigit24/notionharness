import type { CollectionConfig } from 'payload'

// ROADMAP P2.6 — "One polymorphic activity table behind every Activity tab
// in the product — task, project, page, later run ... this is what makes
// 'every entity has a timeline' a week of work instead of a rewrite per
// entity, and it is your audit log when you sell this."
//
// `entityType`/`entityId` rather than Payload's native `relationTo: [...]`
// polymorphic relationship: `run` entities (Pillar 4) live in the raw-`pg`
// broker tables, not a Payload collection at all, so there's no single set
// of Payload collection slugs a native polymorphic relation could target
// anyway. `entityId` is `text` (not `number`) for the same reason — it has
// to hold both Payload's integer ids and the broker's own bigint run ids
// uniformly. `run` is listed now even though nothing populates it yet
// ("later run") — the whole point of this table is not needing a schema
// change when that day comes.
export const ACTIVITY_ENTITY_TYPES = ['task', 'project', 'page', 'run'] as const

export const Activity: CollectionConfig = {
  slug: 'activity',
  fields: [
    {
      name: 'entityType',
      type: 'select',
      required: true,
      options: ACTIVITY_ENTITY_TYPES.map((value) => ({ label: value, value })),
      index: true,
    },
    {
      name: 'entityId',
      type: 'text',
      required: true,
      index: true,
    },
    {
      name: 'actor',
      type: 'relationship',
      relationTo: 'users',
      hasMany: false,
      admin: {
        description: 'Nullable: system/automation-generated activity has no human actor.',
      },
    },
    {
      name: 'action',
      type: 'text',
      required: true,
      admin: {
        description: 'Verb describing what happened (e.g. "created", "commented", "status_changed").',
      },
    },
    {
      name: 'payload',
      type: 'json',
      defaultValue: {},
      admin: {
        description: 'Action-specific details (e.g. { from: "todo", to: "done" } for a status_changed action).',
      },
    },
  ],
}

export default Activity
