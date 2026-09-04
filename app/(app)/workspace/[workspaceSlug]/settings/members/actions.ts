'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { guard, raise, type WithFailure } from '@/lib/failures'
import { requireAccess, type WorkspaceRole } from '@/lib/permissions'
import {
  changeWorkspaceMemberRole,
  createInvitation,
  invitePath,
  listPendingInvitations,
  listWorkspaceMembers,
  removeWorkspaceMember,
  revokeInvitation,
  type InvitableRole,
  type InvitationRow,
  type MemberRow,
} from '@/lib/invitations'

/**
 * People management, as server actions.
 *
 * EVERY ONE OF THESE IS GUARDED TWICE and the second guard is the real one.
 * The screen only renders its controls for an owner or an admin, but a server
 * action is a public endpoint reachable by anybody who can read the page's
 * JavaScript — so `share` is re-checked here on every call. `share` rather than
 * `administer` because the model says `share` is "change who else has access",
 * which is exactly and only what this file does; both resolve to owner/admin
 * today, and if that ever changes this file should follow `share`.
 *
 * They RETURN failures rather than throwing (`lib/failures.ts`): a thrown
 * action error reaches a production browser as an opaque digest with no
 * message, and every sentence below — "this is the last owner", "that person is
 * already in this workspace" — is one the person on the other end needs to
 * read to know what to do next.
 */

export interface MembersScreenData {
  members: MemberRow[]
  invitations: InvitationRow[]
  /** The viewer's own role, so the screen can hide controls it knows will be
   * refused rather than offering buttons that always fail. */
  viewerRole: WorkspaceRole
  viewerId: number
  /** How many owners exist. The screen greys out the last owner's controls
   * with an explanation instead of letting somebody discover the rule by
   * having their click refused. */
  ownerCount: number
}

async function requireSharer(workspaceId: number) {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You must be logged in.')
  const access = await requireAccess({
    userId: user.id,
    workspaceId,
    verb: 'share',
    objectType: 'workspace',
  })
  return { user, access }
}

/** A read for the page, which has already established the viewer can see the
 * workspace. `read` rather than `share`, because a member who cannot change
 * anything should still be able to see who they work with. */
export async function getMembersScreen(workspaceId: number): Promise<WithFailure<MembersScreenData>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')
    const access = await requireAccess({
      userId: user.id,
      workspaceId,
      verb: 'read',
      objectType: 'workspace',
    })
    const [members, invitations] = await Promise.all([
      listWorkspaceMembers(workspaceId),
      // A viewer or a member has no business reading live invite TOKENS — the
      // token is the credential — so the pending list is fetched only for
      // people who could act on it.
      access.role === 'owner' || access.role === 'admin'
        ? listPendingInvitations(workspaceId)
        : Promise.resolve([] as InvitationRow[]),
    ])
    return {
      members,
      invitations,
      viewerRole: access.role as WorkspaceRole,
      viewerId: user.id,
      ownerCount: members.filter((member) => member.role === 'owner').length,
    }
  })
}

export async function inviteMemberAction(input: {
  workspaceId: number
  workspaceSlug: string
  email: string
  role: InvitableRole
  /** Broker `teams.id` when the invite came from a channel roster rather than
   * from the members screen. */
  channelId?: number | null
}): Promise<WithFailure<{ invitation: InvitationRow; path: string }>> {
  return guard(async () => {
    const { user } = await requireSharer(input.workspaceId)
    const payload = await getPayloadClient()
    const invitation = await createInvitation({
      payload,
      workspaceId: input.workspaceId,
      email: input.email,
      role: input.role,
      invitedBy: user.id,
      channelId: input.channelId ?? null,
    })
    revalidatePath(`/workspace/${input.workspaceSlug}/settings/members`)
    // The path, not a URL. There is no APP_URL in this project, so the origin
    // is joined in the browser from `window.location.origin` — which is by
    // definition an origin the recipient can actually reach, unlike a guess
    // made on the server.
    return { invitation, path: invitePath(invitation.token) }
  })
}

export async function revokeInvitationAction(input: {
  workspaceId: number
  workspaceSlug: string
  invitationId: number
}): Promise<WithFailure<{ ok: true }>> {
  return guard(async () => {
    const { user } = await requireSharer(input.workspaceId)
    const payload = await getPayloadClient()
    await revokeInvitation({
      payload,
      workspaceId: input.workspaceId,
      invitationId: input.invitationId,
      actorId: user.id,
    })
    revalidatePath(`/workspace/${input.workspaceSlug}/settings/members`)
    return { ok: true as const }
  })
}

export async function changeMemberRoleAction(input: {
  workspaceId: number
  workspaceSlug: string
  userId: number
  role: WorkspaceRole
}): Promise<WithFailure<{ from: WorkspaceRole; to: WorkspaceRole }>> {
  return guard(async () => {
    const { user, access } = await requireSharer(input.workspaceId)
    // Promoting somebody to `owner` is handing over the one power an admin does
    // not have (delete and transfer the workspace — `canDeleteWorkspace`), so
    // an admin must not be able to mint one.
    if (input.role === 'owner' && access.role !== 'owner') {
      raise('forbidden', 'Only an owner can make somebody else an owner.')
    }
    const payload = await getPayloadClient()
    // The audit row is written inside `changeWorkspaceMemberRole`, not here: an
    // audit that depends on each caller remembering to write it is an audit with
    // holes in it, and this unit already had one — a role change driven from
    // anywhere but this screen left no trace at all.
    const changed = await changeWorkspaceMemberRole({
      payload,
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      actorId: user.id,
    })
    revalidatePath(`/workspace/${input.workspaceSlug}/settings/members`)
    return changed
  })
}

export async function removeMemberAction(input: {
  workspaceId: number
  workspaceSlug: string
  userId: number
}): Promise<WithFailure<{ ok: true }>> {
  return guard(async () => {
    const { user, access } = await requireSharer(input.workspaceId)
    // Removing yourself is "leave the workspace", which is a different feature
    // with a different confirmation and a different landing page. Refusing it
    // here is better than half-implementing it: an admin who removes their own
    // row is immediately locked out of the screen they were standing on.
    if (input.userId === user.id) {
      raise('invalid_input', 'You cannot remove yourself here. Ask another owner or admin to do it.')
    }
    const payload = await getPayloadClient()
    const target = await payload.find({
      collection: 'workspace-members',
      where: {
        and: [{ workspace: { equals: input.workspaceId } }, { user: { equals: input.userId } }],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    const targetRole = target.docs[0]?.role as WorkspaceRole | undefined
    if (targetRole === 'owner' && access.role !== 'owner') {
      raise('forbidden', 'Only an owner can remove another owner.')
    }

    // Audited inside `removeWorkspaceMember`, for the reason above.
    await removeWorkspaceMember({
      payload,
      workspaceId: input.workspaceId,
      userId: input.userId,
      actorId: user.id,
    })
    revalidatePath(`/workspace/${input.workspaceSlug}/settings/members`)
    return { ok: true as const }
  })
}
