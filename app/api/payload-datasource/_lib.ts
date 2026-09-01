// ROADMAP P2.3 — `PayloadDataSource` bridges a real Payload collection into
// BlockSuite's `DataView`. Deliberately NOT a generic "any collection,
// introspected at runtime" bridge: that would let a database block query or
// mutate collections it has no business touching (`users`, `teable-databases`,
// internal config). This is a small, explicit, server-owned registry of which
// collections are exposed this way and what a database-block "property" maps
// to on each — the same allowlist discipline the Teable proxy routes already
// use for which Teable API key gets which level of access.

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
   * (e.g. `pages` requires a `workspace` relationship) — `workspaceId` is
   * substituted in at request time. */
  defaultCreateData: (workspaceId: number) => Record<string, unknown>
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
    defaultCreateData: (workspaceId) => ({ title: 'Untitled', workspace: workspaceId }),
  },
}

export function isAllowedCollection(slug: string): slug is keyof typeof PAYLOAD_DATASOURCE_COLLECTIONS {
  return Object.prototype.hasOwnProperty.call(PAYLOAD_DATASOURCE_COLLECTIONS, slug)
}
