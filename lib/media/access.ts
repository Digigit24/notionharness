import { getBrokerPool } from '@/lib/broker/db'
import { getPayloadClient } from '@/lib/payload'
import { getChannel, isChannelMember } from '@/app/(app)/workspace/[workspaceSlug]/teams/data'
import type { Media } from '@/payload-types'

/**
 * No `import 'server-only'` here, and that omission is deliberate rather than
 * an oversight — worth stating because every sibling file this one reads
 * from (`lib/permissions`, `lib/invitations`, `lib/connectors/*`) DOES carry
 * it. `lib/permissions`'s `loadAccess`/`can` were the first-choice way to
 * answer the workspace-membership half of this question — reusing the
 * canonical layer rather than re-deriving membership a second way — but
 * `server-only`'s own package.json maps EVERY plain Node/tsx import
 * (its `default` export condition) to a build that unconditionally throws,
 * and only Next's bundler-only `react-server` condition gets the real no-op.
 * Confirmed live: importing `lib/permissions` here made this file impossible
 * to exercise from `scripts/test-media-attachments.ts` — and, while tracking
 * that down, confirmed the SAME crash already breaks this repo's own
 * pre-existing `scripts/verify-invitations.ts` (which imports
 * `lib/invitations.ts`), unrelated to this change and not something this
 * unit's ownership covers fixing.
 *
 * So this queries the `workspace-members` collection directly instead —
 * `collections/access.ts`'s own `myWorkspaceIds` reads the identical table
 * the identical way, and `app/api/teams/[teamId]/events/stream/route.ts`'s
 * `userCanReadChannel` already answers this exact "may this user see this
 * channel's workspace" question without `lib/permissions` either, for what
 * is presumably the same reason. This is the one real design trade-off in
 * this file: less centralised than routing through `lib/permissions`, but
 * genuinely testable outside of Next's bundler, which a live-verified
 * security check needs to be.
 */
async function isWorkspaceMember(userId: number, workspaceId: number): Promise<boolean> {
  const payload = await getPayloadClient()
  const found = await payload.find({
    collection: 'workspace-members',
    where: { and: [{ workspace: { equals: workspaceId } }, { user: { equals: userId } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return found.docs.length > 0
}

/**
 * Who may read a Media doc's bytes or metadata — the ONE piece of this
 * feature that cannot be answered by "is it in my workspace" alone.
 *
 * THE DESIGN QUESTION, worked through rather than assumed (per this unit's
 * own brief). A Media doc's `workspace` field is the right FLOOR: nobody
 * outside the workspace should ever see it — `isWorkspaceMember` above, an
 * `inMyWorkspaces()`-shaped check against the same `workspace-members` table
 * (see that function's own comment for why it queries directly rather than
 * through `lib/permissions`). But it cannot be the whole rule, because a
 * file's real audience is
 * whoever can read the CHANNEL it was attached to, and this app already has a
 * narrower audience than "the whole workspace": a private channel
 * (`teams.is_private`) is invisible to a workspace member who is not one of
 * its `team_members` rows — enforced today by `requireChannel` in
 * `teams/actions.ts` for the MESSAGE. A Media doc is a second copy of that
 * same visibility question, and the two must never be allowed to disagree —
 * a screenshot dropped into a private incident channel that anyone in the
 * workspace could fetch by guessing its id would make the channel's privacy
 * fiction the moment someone attaches a file.
 *
 * So: workspace membership is necessary but not sufficient. Once inside the
 * workspace, a file that rides in at least one PUBLIC channel (or in no
 * channel at all yet — see below) is readable; a file that rides ONLY in
 * private channels needs membership in one of them, checked with the exact
 * same `isChannelMember` test the message itself uses.
 *
 * THE UN-ATTACHED CASE. A freshly uploaded file has not been posted into any
 * message yet — `uploadMediaAction` returns it to the browser before `send()`
 * ever runs, and the composer may hold it for a while (typing, previewing,
 * even abandoning the draft). Nobody else knows the id exists, but "any
 * workspace member could still guess a sequential id and read someone else's
 * unsent draft" is a real, narrow hole — closed by falling back to
 * `uploadedBy` for that one case: only the person who uploaded a file that
 * belongs to no message yet may read it. The moment it is attached to a real
 * message, visibility switches to the message's own channel(s).
 */
export async function canUserReadMedia(
  userId: number,
  media: Pick<Media, 'id' | 'workspace' | 'uploadedBy'>,
): Promise<boolean> {
  const workspaceId = typeof media.workspace === 'object' ? media.workspace.id : media.workspace
  if (workspaceId == null) return false

  if (!(await isWorkspaceMember(userId, workspaceId))) return false

  // A page cover, stored on `pages.coverImage` as `media:<id>` (see
  // `page-canvas.tsx`/`cover-picker.tsx`). Unlike a channel attachment,
  // `collections/Pages.ts` has no extra privacy tier beyond workspace
  // membership (`access.read: inMyWorkspaces()`) — so the workspace-member
  // check just above is already the WHOLE answer here; this only needs to
  // confirm the media is genuinely in use as a cover, not narrow who may see
  // it further. Checked before the channel-attachment path so an uploaded
  // cover is never miscategorised as "unattached, uploader-only" simply
  // because it never rides in a `team_messages` row.
  const payload = await getPayloadClient()
  const asCover = await payload.find({
    collection: 'pages',
    where: { coverImage: { equals: `media:${media.id}` } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  if (asCover.docs.length > 0) return true

  const pool = getBrokerPool()
  const { rows } = await pool.query<{ team_id: string }>(
    `SELECT DISTINCT team_id FROM team_messages WHERE attachments @> $1::jsonb`,
    [JSON.stringify([media.id])],
  )

  if (rows.length === 0) {
    const uploadedById = typeof media.uploadedBy === 'object' ? media.uploadedBy?.id : media.uploadedBy
    return uploadedById === userId
  }

  for (const row of rows) {
    const teamId = Number(row.team_id)
    const channel = await getChannel(teamId)
    // A channel that no longer exists carries no visibility of its own; skip
    // it rather than let a stale reference either grant or deny by accident.
    if (!channel || channel.workspaceId !== workspaceId) continue
    if (!channel.isPrivate) return true
    if (await isChannelMember(teamId, userId)) return true
  }
  return false
}
