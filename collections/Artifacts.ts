import type { CollectionConfig } from 'payload'
import { inMyWorkspaces, noOne } from './access'

/**
 * ROADMAP R8.2 — the artifact data model.
 *
 * This collection was P2.1 scaffolding: a required `task`, a `name` and a
 * required `url`, enough to hang a link off a task and nothing more. R8 makes
 * it the record for "what an agent authored", which the old shape cannot
 * express at all, so this is a widening plus two required→optional changes.
 *
 * The physical change is `migrations/20260904_artifacts.sql`, and the two land
 * together: the backfill in that file (workspace read from each row's task)
 * is what makes `workspace` safe to mark required here.
 *
 * One record type, two payloads (R8.2): `kind: 'page'` stores a pointer into
 * `pages` and nothing else, so the document keeps search, favourites,
 * permissions and history for free rather than getting a second-class copy in
 * this table; `kind: 'html'` stores the document body inline, because there is
 * no other collection that would own it.
 */
export const Artifacts: CollectionConfig = {
  slug: 'artifacts',
  // Read within the workspace; written only by the app, which uses
  // `overrideAccess: true`. An artifact is a record of what a run produced, and
  // one that can be hand-edited over REST is a record of nothing.
  access: {
    read: inMyWorkspaces(),
    create: noOne,
    update: noOne,
    delete: noOne,
  },
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'kind', 'project', 'createdByAgent', 'createdAt'],
  },
  fields: [
    {
      name: 'workspace',
      type: 'relationship',
      relationTo: 'workspaces',
      required: true,
      hasMany: false,
      index: true,
      admin: {
        description: 'The tenancy boundary. Every artifact belongs to exactly one workspace.',
      },
    },
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'kind',
      type: 'select',
      required: true,
      defaultValue: 'page',
      index: true,
      options: [
        { label: 'Page', value: 'page' },
        { label: 'HTML', value: 'html' },
      ],
      admin: {
        description: "'page' points at a real BlockSuite document; 'html' carries its body in htmlContent.",
      },
    },
    {
      name: 'page',
      type: 'relationship',
      relationTo: 'pages',
      hasMany: false,
      index: true,
      admin: {
        description:
          'The document itself, when kind is "page". The artifact is only a pointer — docState, search text and history stay in Pages.',
        condition: (data) => data?.kind !== 'html',
      },
    },
    {
      // Not in the R8.2 field list, and required anyway by R8.5's scoped
      // subtree handle: a run can author several artifacts, so the single
      // `runs.page_subtree_block_id` (already spoken for by the run's task
      // page) cannot hold this. It is per-artifact or it is wrong.
      name: 'pageSubtreeBlockId',
      type: 'text',
      admin: {
        readOnly: true,
        description:
          'BlockSuite block id inside `page` that the authoring run owns and appends under. Set by lib/artifacts.ts; never edited by hand.',
        condition: (data) => data?.kind !== 'html',
      },
    },
    {
      name: 'htmlContent',
      type: 'textarea',
      admin: {
        description: 'The document body, when kind is "html". Rendered sandboxed and never same-origin (R8.7).',
        condition: (data) => data?.kind === 'html',
      },
    },
    {
      name: 'project',
      type: 'relationship',
      relationTo: 'projects',
      hasMany: false,
      index: true,
      admin: {
        description:
          'The field the R8.3 placement rule turns on. Empty means loose — the artifact sits in the Artifacts inbox. Setting it MOVES the artifact (and its page) into that project and out of the inbox.',
      },
    },
    {
      // `session` and `run` are plain numbers, not relationships, and that is
      // deliberate: `chat_sessions` and `runs` are broker tables under
      // `lib/broker/*`, owned by raw pg and never registered as Payload
      // collections, so there is nothing for `relationTo` to name. Making
      // them relationships would mean either inventing shadow collections or
      // moving the broker into Payload, and both are far larger decisions
      // than provenance on an artifact justifies.
      name: 'session',
      type: 'number',
      index: true,
      admin: {
        description: 'chat_sessions.id of the conversation that produced this, if any. Not a foreign key — see the field comment.',
      },
    },
    {
      name: 'run',
      type: 'number',
      admin: {
        description: 'runs.id of the run that produced this, if any. Not a foreign key — see the `session` field comment.',
      },
    },
    {
      name: 'createdByAgent',
      type: 'relationship',
      relationTo: 'agents',
      hasMany: false,
      index: true,
      admin: {
        description: 'Which agent authored it, so the Artifacts list can be filtered by author. Empty for an artifact a human made.',
      },
    },
    {
      // R8.2's breaking change. It was required at P2.1 because an artifact
      // could only ever come from a task; artifacts now come from sessions
      // and from humans, neither of which has one.
      name: 'task',
      type: 'relationship',
      relationTo: 'tasks',
      hasMany: false,
      index: true,
      admin: {
        description: 'The task this came out of, if it came out of one. Optional since R8.2.',
      },
    },
    {
      // Kept, and demoted to optional, purely for the P2.1 rows: their entire
      // content reference is this URL and dropping the field would delete it.
      // Nothing R8 creates writes here.
      name: 'url',
      type: 'text',
      admin: {
        description: 'Legacy P2.1 external reference. Page and HTML artifacts leave this empty; their address derives from the record.',
      },
    },
  ],
}

export default Artifacts
