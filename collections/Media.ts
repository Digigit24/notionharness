import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CollectionConfig } from 'payload'
import { inMyWorkspaces, noOne, signedIn } from './access'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

/** Where Payload actually writes the bytes. Exported so
 * `app/api/media/[id]/file/route.ts` — the ONLY thing that ever reads these
 * files back — resolves the identical path rather than recomputing it a
 * second way that could silently drift from this one. */
export const MEDIA_STATIC_DIR = path.resolve(dirname, '../media-uploads')

/**
 * R14-P0.4 — the real thing, not a flag flip.
 *
 * Verified before writing this: `sharp` is wired into `payload.config.ts`
 * (`buildConfig({ sharp })`) but not one collection in this repo has
 * `upload: true` — attachments in chat did not exist at any layer, not just
 * in the UI. This is that layer.
 *
 * WHAT THIS COLLECTION IS NOT: a general-purpose file manager. It exists to
 * back one thing — a file dropped or pasted into `message-composer.tsx` —
 * and its access model (below) is shaped entirely around that one use.
 *
 * ACCESS, THOUGHT THROUGH RATHER THAN COPIED.
 *
 * `read` here governs Payload's own public REST/GraphQL API and its admin
 * panel ONLY (see `collections/access.ts`'s header comment — every Local API
 * call in this app passes `overrideAccess: true`). That matters more than
 * usual for an upload collection, because unlike every other collection in
 * this repo, a Media doc's BYTES have to be reachable from a plain `<img
 * src>` in the browser, which cannot carry a Payload session — this app's
 * login is Better Auth (`lib/auth.ts`), never Payload's own auth strategy, so
 * `req.user` on a raw browser request to `/api/media/*` is always `null`.
 * `Boolean(user)` — Payload's own default — would 403 every single image an
 * authenticated PERSON of this app tries to view.
 *
 * So the REAL enforcement for serving bytes/metadata lives in
 * `app/api/media/[id]/route.ts` and `.../file/route.ts`, which authenticate
 * via the app's own session (`getCurrentPayloadUser`) and authorize via
 * `lib/media/access.ts`'s `canUserReadMedia` — that is where the interesting
 * decision lives, restated here because it is the point of this comment:
 *
 *     A Media doc attached to a channel message must be readable by anyone
 *     who can read that CHANNEL, not merely anyone in the file's workspace.
 *
 * A flat `inMyWorkspaces()` read rule would leak a private channel's
 * attachments to every other member of the workspace the instant someone
 * drags a screenshot into it — the file would be MORE visible than the
 * message it rides on, which defeats the entire point of a private channel.
 * `canUserReadMedia` re-derives visibility from `team_messages.attachments`
 * (which channel(s) actually reference this id) and applies the exact same
 * public/private test `requireChannel` in `teams/actions.ts` already uses for
 * the message itself, so a file's visibility can never diverge from its
 * message's.
 *
 * `inMyWorkspaces()` below is kept anyway, as the OUTER floor for the surfaces
 * that genuinely do go through Payload's own access (the /admin panel, and
 * any future direct REST caller) — an app admin or a workspace member can at
 * least see the record exists, never anyone outside the workspace. It is
 * deliberately not tightened to "no one" the way `Artifacts` is, because
 * unlike an artifact (always written by the app), a Media doc really is
 * sometimes worth inspecting by hand from the admin panel — a user asking
 * "why does this screenshot look corrupted" is a real support question.
 */
export const Media: CollectionConfig = {
  slug: 'media',
  access: {
    read: inMyWorkspaces(),
    // Any signed-in Payload user is technically enough here — the REAL check
    // (workspace membership, verb `write`) happens in
    // `app/api/media/actions.ts`'s `uploadMediaAction`, which is the only
    // code path in this app that creates a Media doc (`overrideAccess: true`
    // there, same as every other write in this repo). This just stops a
    // stranger from creating rows through the bare REST API.
    create: signedIn,
    update: noOne,
    // Deliberately no delete path yet. An attachment referenced by
    // `team_messages.attachments` that vanished out from under a sent message
    // is a broken conversation, and this collection has no reference-counting
    // to know when the last message pointing at a file is gone. Left as a
    // stated gap rather than a half-built reaper.
    delete: noOne,
  },
  admin: {
    useAsTitle: 'filename',
    defaultColumns: ['filename', 'mimeType', 'filesize', 'workspace', 'createdAt'],
  },
  upload: {
    // Outside `collections/`, at the project root, alongside `public/` but not
    // inside it — files here are served through this app's own authenticated
    // route (`app/api/media/[id]/file/route.ts`), never through Next's static
    // `/public` passthrough, so there is no reason for them to sit where an
    // unauthenticated request could ever reach them directly.
    staticDir: MEDIA_STATIC_DIR,
    // Payload's `UploadConfig` (checked directly — `node_modules/payload/
    // dist/uploads/types.d.ts`) has no per-collection max-filesize option; a
    // size cap is enforced in `uploadMediaAction` instead, BEFORE the file
    // ever reaches this collection's `create` — a generous but real 15 MB
    // limit (D0 forbids an unbounded list; the same instinct applies to a
    // single upload — this is chat, not a file drop for build artifacts),
    // refused there with a clean `invalid_input` sentence.
    mimeTypes: [
      'image/*',
      'application/pdf',
      'text/plain',
      'text/csv',
      'text/markdown',
      'application/json',
      'application/zip',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    // The one variant the composer and the sent-message row actually need: a
    // bounded preview. `sharp` (already passed to `buildConfig` in
    // `payload.config.ts`) does the resize; nothing here adds a new image
    // pipeline.
    imageSizes: [
      {
        name: 'thumbnail',
        width: 480,
        height: 480,
        fit: 'inside',
        withoutEnlargement: true,
      },
    ],
    adminThumbnail: 'thumbnail',
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
        description: 'The tenancy boundary this file was uploaded into. See the collection-level comment for why this is the FLOOR of visibility, not the whole rule.',
      },
    },
    {
      name: 'uploadedBy',
      type: 'relationship',
      relationTo: 'users',
      hasMany: false,
      index: true,
      admin: {
        description: 'Who attached this file. Also who may read a not-yet-sent draft attachment before any message references it — see canUserReadMedia.',
      },
    },
  ],
}

export default Media
