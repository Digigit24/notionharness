import type { CollectionConfig } from 'payload'

// ROADMAP B-4 "Work" — saved views for the tasks board/list/table. A view is
// a named, scoped snapshot of a `TaskViewConfig` (lib/task-views/types.ts):
// filters/sort/groupBy/columns/density. Scoping mirrors the plan text
// verbatim ("Named, scoped (workspace / project / mine)"):
//   - 'workspace' — visible to everyone in the workspace.
//   - 'project'   — visible to everyone with access to `project`.
//   - 'mine'      — private to `owner`.
// `config` is stored as Payload's `json` field type (jsonb at the DB layer)
// rather than as individual typed fields, matching the precedent already set
// by `Agents.customEnv`/`customArgs`/`mcpConfig` for "opaque structured blob
// the collection itself doesn't need to understand."
//
// NOT YET PHYSICALLY APPLIED — this collection is registered in
// `payload.config.ts` (declaring the schema, matching `payload generate:types`'
// expectations) and a hand-written migration exists
// (`migrations/20260902_120000_saved_views.ts`) creating the `saved_views`
// table, but per this batch's hard rule ("do NOT run any migration against
// the live DB — write it, don't apply it"), neither has been applied. A human
// must run the migration (and re-run `payload generate:types` to regenerate
// `payload-types.ts` for real — this branch hand-edited that generated file
// as a stopgap so the new server actions here type-check without a build) —
// see this batch's final summary for the exact steps. Until that happens,
// any `payload.find`/`create` call against `collection: 'saved-views'` will
// fail against the live DB with "relation does not exist," the same honest
// failure mode as every other "written, not applied" migration in this repo
// (e.g. `collections/Pages.ts`'s still-missing `project` field).
export const SAVED_VIEW_SCOPES = ['workspace', 'project', 'mine'] as const
export type SavedViewScope = (typeof SAVED_VIEW_SCOPES)[number]

export const SavedViews: CollectionConfig = {
  slug: 'saved-views',
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'scope',
      type: 'select',
      required: true,
      defaultValue: 'workspace',
      options: SAVED_VIEW_SCOPES.map((value) => ({ label: value, value })),
      index: true,
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
      admin: {
        description: "Only set (and only meaningful) when scope is 'project' — cleared by this collection's own beforeChange hook otherwise.",
      },
    },
    {
      name: 'owner',
      type: 'relationship',
      relationTo: 'users',
      hasMany: false,
      index: true,
      admin: {
        description: "Only set (and only meaningful) when scope is 'mine' — cleared by this collection's own beforeChange hook otherwise. The CRUD actions (saved-views-actions.ts) always scope 'mine' reads/writes to the requesting user's own id, never trusting a client-supplied owner.",
      },
    },
    {
      name: 'createdBy',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      admin: {
        description: 'Who created this view — same explicit-caller pattern as Tasks.createdBy (no req.user inside Payload hooks in this app; see collections/Tasks.ts).',
      },
    },
    {
      name: 'config',
      type: 'json',
      required: true,
      defaultValue: {},
      admin: {
        description: 'Serialized TaskViewConfig (lib/task-views/types.ts) — filters/sort/groupBy/columns/density. Opaque to Payload, same pattern as Agents.customEnv/customArgs/mcpConfig.',
      },
    },
  ],
  hooks: {
    beforeChange: [
      ({ data }) => {
        // Scope is the source of truth for which of project/owner applies —
        // never leave a stale value from a scope switch lying around.
        if (data.scope !== 'project') data.project = null
        if (data.scope !== 'mine') data.owner = null
        return data
      },
    ],
  },
}

export default SavedViews
