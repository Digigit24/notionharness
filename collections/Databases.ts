import type { CollectionConfig } from 'payload'
import { inMyWorkspaces } from './access'

// ROADMAP P2.3/D4: the generic, backend-owned table an `affine:database`
// block is allowed to hold user-created (queryable) data in. Per D4,
// `affine:database` blocks must never point at a *system* table (tasks,
// projects, etc. — those go through `PayloadDataSource` against their own
// real collections once 2.1 lands) — only at one of these generic
// `databases` docs, via `UserDatabaseDataSource`.
//
// Unlike Teable (a foreign REST API with its own field-resource lifecycle)
// or a Payload collection (fixed, code-defined schema), a user database's
// *schema itself* is end-user-editable at runtime — so it lives as a single
// JSON array on this doc rather than as separate rows/resources. See
// `UserDatabaseDataSource`'s `propertyAdd` for why that materially
// simplifies property CRUD versus `TeableDataSource`'s id-aliasing dance.
export const Databases: CollectionConfig = {
  slug: 'databases',
  // Ordinary workspace content: everyone in the workspace, nobody outside it.
  access: {
    read: inMyWorkspaces(),
    create: inMyWorkspaces(),
    update: inMyWorkspaces(),
    delete: inMyWorkspaces(),
  },
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'name',
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
    },
    {
      name: 'fields',
      type: 'json',
      defaultValue: [],
      admin: {
        description:
          'Array of GenericField-shaped property definitions ({id, name, type, options?, isPrimary?}) — the user-editable schema for this database.',
      },
    },
  ],
}

export default Databases
