import type { CollectionConfig } from 'payload'

// ROADMAP P2.1 — the core unit of work. Three details called out explicitly
// as "cheap now and structural later":
// - `position` (Postgres `numeric`, matching this codebase's existing
//   `database_rows.position` convention — see migration): fractional
//   drag-ordering, so reordering one card on a board never requires
//   renumbering its neighbors.
// - `revision` (Postgres `bigint`): optimistic-concurrency counter,
//   incremented on every update via this collection's own `beforeChange`
//   hook (not left to the client) — full conflict handling (reject/merge a
//   stale write) is NOT wired up in this pass, but the value is always
//   correct and available for a future check to compare against.
// - `lastActivityAt` (Postgres `timestamptz`): denormalized so board/list
//   sorting by "most recently active" never joins the `activity` table.
//
// `createdBy` exists specifically to make the roadmap 2.6 auto-activity/
// auto-follow hook below actually work: this app's server actions call
// Payload's Local API directly (`overrideAccess: true`, no Payload-session
// `req.user`, since login is Better Auth, not Payload's own auth) — there is
// no `req.user` inside a hook to read "who did this" from, so the caller
// must pass `createdBy` explicitly on create.
export const Tasks: CollectionConfig = {
  slug: 'tasks',
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
      name: 'workspace',
      type: 'relationship',
      relationTo: 'workspaces',
      required: true,
      hasMany: false,
      index: true,
    },
    {
      name: 'project',
      type: 'relationship',
      relationTo: 'projects',
      hasMany: false,
      index: true,
    },
    {
      name: 'status',
      type: 'relationship',
      relationTo: 'task-statuses',
      required: true,
      hasMany: false,
      index: true,
    },
    {
      name: 'assignee',
      type: 'relationship',
      relationTo: 'users',
      hasMany: false,
    },
    {
      name: 'createdBy',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      admin: {
        description: 'Who created this task — passed explicitly by the caller (see class comment above for why this can\'t be read off req.user).',
      },
    },
    {
      name: 'position',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Fractional manual ordering (e.g. within a board column) — see collection comment.',
      },
    },
    {
      name: 'revision',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Optimistic-concurrency counter, incremented automatically on every update. Clients should send back the revision they read; rejecting/merging a stale write is not yet wired up.',
        readOnly: true,
      },
    },
    {
      name: 'lastActivityAt',
      type: 'date',
      admin: {
        description: 'Denormalized "most recently active" timestamp, updated automatically on every change, so sorting never has to join activity.',
        readOnly: true,
      },
    },
  ],
  hooks: {
    beforeChange: [
      ({ data, operation }) => {
        // `revision`/`lastActivityAt` are server-owned — always overwrite
        // whatever (if anything) the caller sent, never trust a client value.
        if (operation === 'update') {
          data.revision = (typeof data.revision === 'number' ? data.revision : 0) + 1
        }
        data.lastActivityAt = new Date().toISOString()
        return data
      },
    ],
    afterChange: [
      async ({ doc, operation, req }) => {
        if (operation !== 'create') return
        // ROADMAP 2.6 — "creator auto-follows on create; follows drive
        // notifications" + "one polymorphic activity table behind every
        // Activity tab." Best-effort: a failure here must never fail the
        // task creation itself, so it's logged, not thrown.
        try {
          await req.payload.create({
            collection: 'activity',
            data: {
              entityType: 'task',
              entityId: String(doc.id),
              actor: doc.createdBy,
              action: 'created',
              payload: { title: doc.title },
            },
            overrideAccess: true,
          })
          await req.payload.create({
            collection: 'followers',
            data: { user: doc.createdBy, entityType: 'task', entityId: String(doc.id) },
            overrideAccess: true,
          })
        } catch (err) {
          console.error('[tasks] Failed to record creation activity/auto-follow.', err)
        }
      },
    ],
  },
}

export default Tasks
