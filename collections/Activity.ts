import type { CollectionConfig } from 'payload'
import { appAdminOnly, noOne } from './access'

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
// `workspace` was added for people management (invite sent/accepted/revoked,
// role changed, member removed). None of the other four describes a membership
// change, and filing one under `project` would make the audit log lie about
// what the row is. Its `entityId` is the workspace id, so the audit view can
// scope these rows the same way it scopes every other kind.
export const ACTIVITY_ENTITY_TYPES = ['task', 'project', 'page', 'run', 'workspace', 'connector', 'agent', 'channel'] as const

export const Activity: CollectionConfig = {
  slug: 'activity',
  // The audit log. `entityType`/`entityId` is a deliberate non-relationship
  // (see this file's header), so there is no join to a workspace and inventing
  // one here would be a guess with a security consequence: the operator sees it
  // over this API, nobody else does, and the in-app views read it through
  // `overrideAccess` with their own workspace filter. An audit log its subjects
  // can rewrite is not an audit log, hence `noOne` on every write.
  access: {
    read: appAdminOnly,
    create: noOne,
    update: noOne,
    delete: noOne,
  },
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
