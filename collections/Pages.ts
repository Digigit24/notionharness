import type { CollectionConfig } from 'payload'
import { recordActivity } from '@/lib/activity'

export const Pages: CollectionConfig = {
  slug: 'pages',
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
      name: 'icon',
      type: 'text',
      admin: {
        description: 'Emoji used as the page icon',
      },
    },
    {
      name: 'coverImage',
      type: 'text',
      admin: {
        description: 'URL of the page cover image',
      },
    },
    {
      name: 'workspace',
      type: 'relationship',
      relationTo: 'workspaces',
      required: true,
      hasMany: false,
    },
    {
      name: 'linkedSourceType',
      type: 'select',
      options: [
        { label: 'User Database', value: 'userDatabase' },
        { label: 'Payload Collection', value: 'payload' },
      ],
      admin: {
        description:
          'Which DataSource backend this page mirrors a row from, if any — set together with linkedSourceId/linkedRecordId. Empty for a regular, unlinked page.',
      },
    },
    {
      name: 'linkedSourceId',
      type: 'text',
      index: true,
      admin: {
        description: "The linked backend's own identifier: a `databases` doc id for 'userDatabase', or a collection slug for 'payload'.",
      },
    },
    {
      name: 'linkedRecordId',
      type: 'text',
      index: true,
      admin: {
        description: 'The specific row/document id within linkedSourceId.',
      },
    },
    {
      name: 'parentPage',
      type: 'relationship',
      relationTo: 'pages',
      hasMany: false,
      admin: {
        description: 'Parent page for infinite nesting; empty for a top-level page',
      },
    },
    {
      // ROADMAP B-1 (project detail, Pages tab) — paired with
      // migrations/20260902_100000_pages_project.ts's project_id column;
      // both land together, never as two separate steps (see that
      // migration's own header comment for why).
      name: 'project',
      type: 'relationship',
      relationTo: 'projects',
      hasMany: false,
      index: true,
      admin: {
        description: 'Project this page belongs to, if any — scopes it into the project detail page\'s Pages tab.',
      },
    },
    {
      name: 'position',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Manual drag-and-drop ordering within the sidebar',
      },
    },
    {
      name: 'docState',
      type: 'json',
      admin: {
        description: 'BlockSuite / Yjs document snapshot',
      },
    },
    {
      name: 'plainTextContent',
      type: 'textarea',
      admin: {
        description: 'Auto-extracted plain text used for search and agent context',
      },
    },
    {
      name: 'isFavorite',
      type: 'checkbox',
      defaultValue: false,
    },
    {
      name: 'isArchived',
      type: 'checkbox',
      defaultValue: false,
    },
    {
      name: 'isFullWidth',
      type: 'checkbox',
      defaultValue: false,
    },
    {
      name: 'isLocked',
      type: 'checkbox',
      defaultValue: false,
    },
  ],
  hooks: {
    afterChange: [
      // ROADMAP P2.6 — generalizing the activity spine beyond tasks: at
      // least create/rename for pages, via the same `recordActivity`
      // mechanism (see `lib/activity.ts`), not a second one. Pages has no
      // `createdBy`-style field (unlike Tasks), so both branches read the
      // actor from `req.context.actorId`, threaded by the calling server
      // action (`createPage`/`renamePage` in `app/(app)/actions.ts`) via
      // Payload's built-in hook-only `context` option — best-effort, a
      // failure here must never fail the page write itself.
      //
      // Deliberately NOT hooked into `docState`/`plainTextContent` updates:
      // those come from `syncPageDoc`, a debounced autosave that fires on
      // every keystroke and must stay silent (see that action's own
      // comment) — an activity row per keystroke would drown out every
      // other entity's timeline. Title is the only diffed field for
      // `update`, so autosave writes correctly produce no activity at all.
      async ({ doc, previousDoc, operation, req }) => {
        const actorId = typeof req.context?.actorId === 'number' ? req.context.actorId : null
        if (operation === 'create') {
          try {
            await recordActivity({
              payload: req.payload,
              entityType: 'page',
              entityId: String(doc.id),
              actor: actorId,
              action: 'created',
              details: { title: doc.title },
            })
            if (actorId) {
              await req.payload.create({
                collection: 'followers',
                data: { user: actorId, entityType: 'page', entityId: String(doc.id) },
                overrideAccess: true,
              })
            }
          } catch (err) {
            console.error('[pages] Failed to record creation activity/auto-follow.', err)
          }
          return
        }

        if (operation === 'update' && previousDoc && previousDoc.title !== doc.title) {
          try {
            await recordActivity({
              payload: req.payload,
              entityType: 'page',
              entityId: String(doc.id),
              actor: actorId,
              action: 'renamed',
              details: { from: previousDoc.title, to: doc.title },
            })
          } catch (err) {
            console.error('[pages] Failed to record rename activity.', err)
          }
        }
      },
    ],
  },
}

export default Pages
