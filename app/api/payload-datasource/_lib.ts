// ROADMAP P2.3 — `PayloadDataSource` bridges a real Payload collection into
// BlockSuite's `DataView`. Deliberately NOT a generic "any collection,
// introspected at runtime" bridge: that would let a database block query or
// mutate collections it has no business touching (`users`, `databases`,
// internal config). This is a small, explicit, server-owned registry of which
// collections are exposed this way and what a database-block "property" maps
// to on each — the same allowlist discipline the Teable proxy routes already
// use for which Teable API key gets which level of access.

import type { Payload } from 'payload'

export interface PayloadPropertyDef {
  /** Also the Payload document's actual field name — Payload docs don't have
   * per-field ids, so the field name doubles as the property id here. */
  id: string
  name: string
  type: 'text' | 'number' | 'checkbox' | 'select' | 'multi-select' | 'date'
  isPrimary?: boolean
  choices?: { id: string; name: string; color: string }[]
}

export interface PayloadCollectionSchema {
  properties: PayloadPropertyDef[]
  /** Data every newly-created doc needs beyond what a property maps to
   * (e.g. `pages` requires a `workspace` relationship). `payload`/`userId`
   * are threaded through so a collection with its own required fields the
   * generic bridge can't infer from a property alone (ROADMAP B3.4 —
   * `tasks` needs a real `status` and `createdBy`, not just `workspace`)
   * can resolve them itself rather than the route handler special-casing
   * per collection. Async because `tasks` needs a lookup (the workspace's
   * first status by position) before it can return. */
  defaultCreateData: (ctx: { workspaceId: number; payload: Payload; userId: number | null }) => Promise<Record<string, unknown>> | Record<string, unknown>
}

export const PAYLOAD_DATASOURCE_COLLECTIONS: Record<string, PayloadCollectionSchema> = {
  pages: {
    properties: [
      { id: 'title', name: 'Title', type: 'text', isPrimary: true },
      { id: 'icon', name: 'Icon', type: 'text' },
      { id: 'isFavorite', name: 'Favorite', type: 'checkbox' },
      { id: 'isArchived', name: 'Archived', type: 'checkbox' },
      { id: 'isLocked', name: 'Locked', type: 'checkbox' },
    ],
    defaultCreateData: ({ workspaceId }) => ({ title: 'Untitled', workspace: workspaceId }),
  },
  // ROADMAP B3.4/B3.5 — "PayloadDataSource already exists; expose it in the
  // slash menu so 'insert a view of this project's tasks' is two keystrokes."
  // Deliberately just `title` for now, not `status`/`assignee`/`project`:
  // those are `collections/Tasks.ts` relationship fields, and
  // `PayloadPropertyDef.type` has no `'relation'` case today (only
  // text/number/checkbox/select/multi-select/date) — building relation-aware
  // columns into this bridge is real new data-source infrastructure, not the
  // "small, surgical" addition this pass scoped for. A real, editable title
  // column backed by the genuine `tasks` table beats a fabricated richer
  // view; the task block (`components/editor/blocks/task/`) is where
  // status/assignee actually live and edit for now.
  tasks: {
    properties: [{ id: 'title', name: 'Title', type: 'text', isPrimary: true }],
    defaultCreateData: async ({ workspaceId, payload, userId }) => {
      if (!userId) throw new Error('You must be logged in to create a task.')
      const statuses = await payload.find({
        collection: 'task-statuses',
        where: { workspace: { equals: workspaceId } },
        sort: 'position',
        limit: 1,
        overrideAccess: true,
      })
      const statusId = statuses.docs[0]?.id
      if (!statusId) throw new Error('This workspace has no task statuses configured yet.')
      return { title: 'Untitled', workspace: workspaceId, status: statusId, createdBy: userId }
    },
  },
}

export function isAllowedCollection(slug: string): slug is keyof typeof PAYLOAD_DATASOURCE_COLLECTIONS {
  return Object.prototype.hasOwnProperty.call(PAYLOAD_DATASOURCE_COLLECTIONS, slug)
}
