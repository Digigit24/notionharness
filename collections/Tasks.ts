import type { CollectionConfig } from 'payload'
import { recordActivity, relId } from '@/lib/activity'
import { inMyWorkspaces } from './access'

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
  // Ordinary workspace content: everyone in the workspace, nobody outside it.
  access: {
    read: inMyWorkspaces(),
    create: inMyWorkspaces(),
    update: inMyWorkspaces(),
    delete: inMyWorkspaces(),
  },
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
      name: 'agent',
      type: 'relationship',
      relationTo: 'agents',
      hasMany: false,
      index: true,
    },
    {
      name: 'page',
      type: 'relationship',
      relationTo: 'pages',
      hasMany: false,
      index: true,
      admin: {
        description:
          'The task\'s document (ROADMAP 6.1 — "streams blocks into the task\'s document"). Null until something needs to write into it: lazily created/linked by lib/task-pages.ts\'s ensureTaskPage, not on task creation, so a task an agent never touches never gets a page nobody opens.',
      },
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
    {
      name: 'channelThreadRootId',
      type: 'number',
      index: true,
      admin: {
        description:
          'Optional broker `team_messages.id` — the thread this task was opened as (ROADMAP R14-P0.8), or the shared parent-task thread for a subtask created from inside it. A number rather than a relationship because team_messages lives in the raw-pg broker, not in Payload, the same reason Invitations.channelId and AccessGrants.objectId are plain columns instead. Deliberately NOT team_tasks (the broker\'s own lightweight coordination item) — this points at a project task\'s thread root message, one project task at a time; a task with no thread leaves this null and behaves exactly as it did before this field existed.',
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
      async ({ doc, previousDoc, operation, req }) => {
        // ROADMAP 2.6 — "creator auto-follows on create; follows drive
        // notifications" + "one polymorphic activity table behind every
        // Activity tab." Best-effort throughout: a failure here must never
        // fail the task write itself, so every branch is logged, not thrown.
        //
        // `req.context.actorId` is how the *update* path learns who made the
        // change: there's still no `req.user` in this app's hooks (see class
        // comment), and unlike `create` there's no persisted "who did this"
        // field for updates to read — callers thread it through Payload's
        // built-in hook-only `context` option instead of a new schema field.
        if (operation === 'create') {
          try {
            await recordActivity({
              payload: req.payload,
              entityType: 'task',
              entityId: String(doc.id),
              actor: relId(doc.createdBy),
              action: 'created',
              details: { title: doc.title },
            })
            await req.payload.create({
              collection: 'followers',
              data: { user: doc.createdBy, entityType: 'task', entityId: String(doc.id) },
              overrideAccess: true,
            })
          } catch (err) {
            console.error('[tasks] Failed to record creation activity/auto-follow.', err)
          }
          return
        }

        if (operation === 'update' && previousDoc) {
          const actorId = typeof req.context?.actorId === 'number' ? req.context.actorId : null
          const changes: Array<{ action: string; details: Record<string, unknown> }> = []
          if (relId(previousDoc.status) !== relId(doc.status)) {
            changes.push({ action: 'status_changed', details: { from: relId(previousDoc.status), to: relId(doc.status) } })
          }
          if (relId(previousDoc.assignee) !== relId(doc.assignee)) {
            changes.push({
              action: 'assignee_changed',
              details: { from: relId(previousDoc.assignee), to: relId(doc.assignee) },
            })
          }
          if (relId(previousDoc.agent) !== relId(doc.agent)) {
            changes.push({ action: 'agent_changed', details: { from: relId(previousDoc.agent), to: relId(doc.agent) } })
          }
          if (relId(previousDoc.project) !== relId(doc.project)) {
            changes.push({ action: 'project_changed', details: { from: relId(previousDoc.project), to: relId(doc.project) } })
          }
          if (previousDoc.title !== doc.title) {
            changes.push({ action: 'renamed', details: { from: previousDoc.title, to: doc.title } })
          }
          if (changes.length === 0) return
          try {
            for (const change of changes) {
              await recordActivity({
                payload: req.payload,
                entityType: 'task',
                entityId: String(doc.id),
                actor: actorId,
                action: change.action,
                details: change.details,
              })
            }
          } catch (err) {
            console.error('[tasks] Failed to record update activity.', err)
          }
        }
      },
    ],
  },
}

export default Tasks
