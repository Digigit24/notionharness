import 'server-only'

import crypto from 'crypto'
import type { BasePayload } from 'payload'
import { getPayloadClient } from '@/lib/payload'
import { getBrokerPool } from '@/lib/broker/db'
import { raise } from '@/lib/failures'
import { logger } from '@/lib/logger'
import { WORKSPACE_ROLES, type WorkspaceRole } from '@/lib/permissions'
import { slotColourFor } from '@/components/teams/shared'
import type { Invitation } from '@/payload-types'

/**
 * People management: the writes, in one place, because two of them must never
 * happen apart.
 *
 * THE ONE THING THIS MODULE EXISTS TO GUARANTEE. Membership is recorded in TWO
 * places and always has been. `workspace-members` is the truth (it carries the
 * role); `workspaces.members` is the legacy index that Payload's own collection
 * `access` rules still read (`collections/Workspaces.ts`), that
 * `app/(app)/workspace/[workspaceSlug]/layout.tsx` gates the whole shell on,
 * and that a dozen server actions use for their own membership test. Writing
 * one without the other produces the worst possible bug in this unit: a person
 * who has just accepted an invite, has a `workspace-members` row with a role,
 * and gets `notFound()` when they open the workspace. So every add and every
 * remove in this app goes through `addWorkspaceMember`/`removeWorkspaceMember`
 * below, which write both, and nothing else writes either.
 *
 * The rejected alternative was a Payload `afterChange` hook on
 * `workspace-members` that mirrors into the array. It would have been fewer
 * lines and it would have been wrong: hooks do not run for the raw-SQL paths
 * this codebase already uses, they fire after the transaction the caller cares
 * about, and a mirror that fails silently is exactly the failure mode described
 * above. An explicit pair of functions can be read and can be tested.
 *
 * NO EMAIL IS SENT, and that is stated rather than implied. `payload.config.ts`
 * configures no email adapter (Payload logs a warning about it at boot) and
 * `lib/notifications/digest.ts` already documents the same finding: there is no
 * nodemailer/resend/sendgrid client anywhere in this project. So an invitation
 * produces a LINK, the UI says so plainly, and the person who invited somebody
 * is the transport. Pretending otherwise would mean invitees waiting for mail
 * that was never going to arrive.
 */

/** How long a link stays good. Long enough to survive a weekend and a forwarded
 * message, short enough that a link found in an old chat log is dead. */
export const INVITE_TTL_DAYS = 7

/** Roles an invite may carry. `owner` is excluded here for the same reason it
 * is excluded from the collection's own options: ownership is transferred, not
 * invited, and two owners is a state nothing else in the model expects. */
export const INVITABLE_ROLES = WORKSPACE_ROLES.filter((role) => role !== 'owner')
export type InvitableRole = Exclude<WorkspaceRole, 'owner'>

/**
 * The entity type membership audit rows are filed under.
 *
 * Added to `ACTIVITY_ENTITY_TYPES` for this unit. None of the four that were
 * there (`task`, `project`, `page`, `run`) describes "somebody was invited",
 * and filing a membership change under a project would make the audit log lie
 * about what the row is.
 */
const MEMBERSHIP_ENTITY_TYPE = 'workspace'

/** Audit verbs, as constants, so the UI's filter and the writer cannot drift.
 * `activity.action` is free text by design (see `collections/Activity.ts`), so
 * this list is a convention rather than a constraint — which is exactly why it
 * needs to be written down once. */
export const MEMBERSHIP_ACTIONS = {
  inviteSent: 'invite_sent',
  inviteAccepted: 'invite_accepted',
  inviteRevoked: 'invite_revoked',
  roleChanged: 'role_changed',
  memberRemoved: 'member_removed',
} as const

/**
 * Write one membership audit row.
 *
 * Deliberately NOT `lib/activity.ts`'s `recordActivity`: that helper follows
 * every write with a `followers` query filtered on the same `entityType`, and
 * `followers.entity_type` is a separate Postgres enum that has no `workspace`
 * value — the query would fail on the enum cast, and a workspace cannot be
 * followed anyway, so the notification half has nothing to do. Best-effort
 * throughout: an audit row must never be the reason an invite fails to send.
 */
export async function recordMembershipActivity(input: {
  payload: BasePayload
  workspaceId: number
  actorId: number | null
  action: (typeof MEMBERSHIP_ACTIONS)[keyof typeof MEMBERSHIP_ACTIONS]
  details?: Record<string, unknown>
}): Promise<void> {
  try {
    await input.payload.create({
      collection: 'activity',
      data: {
        entityType: MEMBERSHIP_ENTITY_TYPE,
        entityId: String(input.workspaceId),
        actor: input.actorId ?? undefined,
        action: input.action,
        payload: input.details ?? {},
      },
      overrideAccess: true,
    })
  } catch (err) {
    logger.warn('membership activity row was not written', {
      workspaceId: input.workspaceId,
      action: input.action,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

// --- The legacy index -------------------------------------------------------

/**
 * `invitations.channel_id` is a `bigint`, and node-postgres hands bigints back
 * as STRINGS — so Payload returns `"97"` where `payload-types.ts` promises
 * `number | null`. Confirmed live: a strict `invitation.channelId === teamId`
 * comparison was false for a channel that had in fact been joined, because one
 * side was a string. The column is a bigint on purpose (broker `teams.id` is
 * one), so the fix is to coerce at every read boundary rather than to narrow
 * the column and lose ids above 2^31.
 */
function asChannelId(value: unknown): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** `workspaces.members` comes back populated or as bare ids depending on the
 * read's `depth`; every membership test in this codebase repeats this ternary,
 * and this unit needs it in four places. */
function memberIdsOf(members: unknown): number[] {
  if (!Array.isArray(members)) return []
  return members
    .map((entry) => (typeof entry === 'number' ? entry : (entry as { id?: number } | null)?.id))
    .filter((id): id is number => typeof id === 'number')
}

/**
 * Rewrite `workspaces.members` to exactly the given set.
 *
 * Read-modify-write on an array column, so two administrators adding two
 * different people in the same second can lose one of the two writes. Accepted
 * knowingly: the truth is `workspace-members`, whose unique index makes IT
 * correct under the same race, and `reconcileLegacyMembers` below can rebuild
 * the array from that truth. The alternative — a Postgres array append in raw
 * SQL against a table Payload owns — would put two writers with two different
 * notions of the column's shape on the same column.
 */
async function writeLegacyMembers(payload: BasePayload, workspaceId: number, ids: number[]): Promise<void> {
  await payload.update({
    collection: 'workspaces',
    id: workspaceId,
    data: { members: [...new Set(ids)] },
    depth: 0,
    overrideAccess: true,
  })
}

/**
 * Put `workspaces.members` back in agreement with `workspace-members`.
 *
 * The repair path, not the write path. Exposed because the pair of writes below
 * can be interrupted between them (a crash, a lost connection) and when that
 * happens the symptom — a member who cannot open the workspace — is one nobody
 * would guess the cause of. Returns what it changed so a caller can say so.
 */
export async function reconcileLegacyMembers(
  payload: BasePayload,
  workspaceId: number,
): Promise<{ added: number[]; removed: number[] }> {
  const [workspace, rows] = await Promise.all([
    payload.findByID({ collection: 'workspaces', id: workspaceId, depth: 0, overrideAccess: true }),
    payload.find({
      collection: 'workspace-members',
      where: { workspace: { equals: workspaceId } },
      limit: 1000,
      depth: 0,
      overrideAccess: true,
    }),
  ])
  const truth = new Set(rows.docs.map((row) => (typeof row.user === 'number' ? row.user : row.user.id)))
  const legacy = new Set(memberIdsOf(workspace.members))
  const added = [...truth].filter((id) => !legacy.has(id))
  const removed = [...legacy].filter((id) => !truth.has(id))
  if (added.length || removed.length) await writeLegacyMembers(payload, workspaceId, [...truth])
  return { added, removed }
}

// --- Membership -------------------------------------------------------------

export interface MemberRow {
  memberId: number
  userId: number
  name: string
  email: string
  role: WorkspaceRole
  joinedAt: string
  invitedByName: string | null
}

/**
 * Add somebody to a workspace, in both places.
 *
 * Idempotent on purpose: accepting an invite twice (a double-clicked link, a
 * retried request) must produce one member and no error. When a row already
 * exists the role is left alone rather than overwritten — an invite that
 * arrives after somebody has already been promoted must not quietly demote
 * them back to `member`.
 *
 * The legacy array is written SECOND. If the process dies between the two, the
 * person has a role row but cannot open the workspace, which
 * `reconcileLegacyMembers` fixes; the reverse order would give them access with
 * no role, which the permission layer would read as `null` and refuse anyway —
 * the same outcome with an extra way to be wrong.
 */
export async function addWorkspaceMember(input: {
  payload: BasePayload
  workspaceId: number
  userId: number
  role: WorkspaceRole
  invitedBy?: number | null
}): Promise<{ created: boolean; role: WorkspaceRole }> {
  const { payload, workspaceId, userId } = input
  const existing = await payload.find({
    collection: 'workspace-members',
    where: { and: [{ workspace: { equals: workspaceId } }, { user: { equals: userId } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })

  const role = (existing.docs[0]?.role as WorkspaceRole | undefined) ?? input.role
  if (!existing.docs[0]) {
    await payload.create({
      collection: 'workspace-members',
      data: {
        workspace: workspaceId,
        user: userId,
        role: input.role,
        invitedBy: input.invitedBy ?? undefined,
      },
      overrideAccess: true,
    })
  }

  const workspace = await payload.findByID({
    collection: 'workspaces',
    id: workspaceId,
    depth: 0,
    overrideAccess: true,
  })
  const ids = memberIdsOf(workspace.members)
  if (!ids.includes(userId)) await writeLegacyMembers(payload, workspaceId, [...ids, userId])

  return { created: !existing.docs[0], role }
}

/**
 * Remove somebody from a workspace, from both places.
 *
 * Refuses to remove the last owner. A workspace with no owner cannot be deleted
 * or transferred by anybody (`canDeleteWorkspace` is `role === 'owner'` and
 * nothing else grants it), so this is not a policy preference — it is the one
 * removal that cannot be undone from inside the product.
 */
export async function removeWorkspaceMember(input: {
  payload: BasePayload
  workspaceId: number
  userId: number
  /** Who did it. Null only for a system removal; the audit row is written HERE
   * rather than by the caller because an audit that depends on every caller
   * remembering to write it is an audit with holes in it — proved by the first
   * version of this module, where a removal driven from anywhere but the
   * members screen left no trace at all. */
  actorId?: number | null
}): Promise<void> {
  const { payload, workspaceId, userId } = input
  const rows = await payload.find({
    collection: 'workspace-members',
    where: { workspace: { equals: workspaceId } },
    limit: 1000,
    depth: 0,
    overrideAccess: true,
  })
  const mine = rows.docs.find((row) => (typeof row.user === 'number' ? row.user : row.user.id) === userId)
  if (!mine) raise('not_found', 'That person is not in this workspace.')
  if (mine.role === 'owner' && rows.docs.filter((row) => row.role === 'owner').length <= 1) {
    raise(
      'conflict',
      'This is the last owner of the workspace. Make somebody else an owner first, then remove this one.',
    )
  }

  await payload.delete({ collection: 'workspace-members', id: mine.id, overrideAccess: true })

  const workspace = await payload.findByID({
    collection: 'workspaces',
    id: workspaceId,
    depth: 0,
    overrideAccess: true,
  })
  const ids = memberIdsOf(workspace.members)
  if (ids.includes(userId)) {
    await writeLegacyMembers(
      payload,
      workspaceId,
      ids.filter((id) => id !== userId),
    )
  }

  await recordMembershipActivity({
    payload,
    workspaceId,
    actorId: input.actorId ?? null,
    action: MEMBERSHIP_ACTIONS.memberRemoved,
    details: { userId, role: mine.role },
  })
}

/**
 * Change somebody's role.
 *
 * The last owner cannot be demoted, for the reason above. Nothing here touches
 * the legacy array: it records WHO is in the workspace and carries no role, so
 * a role change is not a membership change and rewriting it would be a write
 * that can only introduce drift.
 */
export async function changeWorkspaceMemberRole(input: {
  payload: BasePayload
  workspaceId: number
  userId: number
  role: WorkspaceRole
  /** Who did it. See `removeWorkspaceMember` for why the audit row is written
   * here and not at the call site. */
  actorId?: number | null
}): Promise<{ from: WorkspaceRole; to: WorkspaceRole }> {
  const { payload, workspaceId, userId } = input
  const rows = await payload.find({
    collection: 'workspace-members',
    where: { workspace: { equals: workspaceId } },
    limit: 1000,
    depth: 0,
    overrideAccess: true,
  })
  const mine = rows.docs.find((row) => (typeof row.user === 'number' ? row.user : row.user.id) === userId)
  if (!mine) raise('not_found', 'That person is not in this workspace.')
  const from = mine.role as WorkspaceRole
  if (from === input.role) return { from, to: from }
  if (from === 'owner' && rows.docs.filter((row) => row.role === 'owner').length <= 1) {
    raise(
      'conflict',
      'This is the last owner of the workspace. Make somebody else an owner first, then change this role.',
    )
  }

  await payload.update({
    collection: 'workspace-members',
    id: mine.id,
    data: { role: input.role },
    overrideAccess: true,
  })
  await recordMembershipActivity({
    payload,
    workspaceId,
    actorId: input.actorId ?? null,
    action: MEMBERSHIP_ACTIONS.roleChanged,
    details: { userId, from, to: input.role },
  })
  return { from, to: input.role }
}

/**
 * The member list, resolved to names in one query rather than one per row.
 *
 * `depth: 1` populates `user` and `invitedBy` in the same read Payload was
 * going to do anyway. The obvious alternative — `depth: 0` plus a `users` find
 * over the collected ids — is one extra round trip for a list that is tens of
 * rows long, and D0 says the round trip is the thing that costs.
 */
export async function listWorkspaceMembers(workspaceId: number): Promise<MemberRow[]> {
  const payload = await getPayloadClient()
  const rows = await payload.find({
    collection: 'workspace-members',
    where: { workspace: { equals: workspaceId } },
    limit: 1000,
    depth: 1,
    sort: 'createdAt',
    overrideAccess: true,
  })
  return rows.docs.flatMap((row) => {
    if (typeof row.user === 'number') return []
    const invitedBy = typeof row.invitedBy === 'object' && row.invitedBy ? row.invitedBy : null
    return [
      {
        memberId: row.id,
        userId: row.user.id,
        name: row.user.name || row.user.email,
        email: row.user.email,
        role: row.role as WorkspaceRole,
        joinedAt: row.createdAt,
        invitedByName: invitedBy ? invitedBy.name || invitedBy.email : null,
      },
    ]
  })
}

// --- Invitations ------------------------------------------------------------

export interface InvitationRow {
  id: number
  email: string
  role: InvitableRole
  token: string
  status: Invitation['status']
  expiresAt: string
  createdAt: string
  invitedByName: string | null
  channelId: number | null
  /** Computed against `now`, not stored: `status` stays `pending` past the
   * expiry by design (see `collections/Invitations.ts` — nothing sweeps this
   * table), so "expired" is a question asked at read time. */
  expired: boolean
}

/** 32 bytes from the CSPRNG, base64url so it survives being a path segment
 * unescaped. `Math.random` would be a token an attacker can predict from two
 * observed invites; this is the one place in this unit where the choice of
 * generator is the whole security property. */
function newToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** The path an invite link points at. Relative, deliberately: there is no
 * APP_URL in this project (`lib/auth.ts` falls back to localhost), so the
 * origin is joined in the browser from `window.location.origin`, which is by
 * definition the one the recipient will actually be able to reach. */
export function invitePath(token: string): string {
  return `/invite/${token}`
}

/** Ordinary email normalisation, applied on BOTH sides of the accept check so
 * a link addressed to `Ada@Example.com` is accepted by an account that signed
 * up as `ada@example.com`. Comparing raw would refuse the right person. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function listPendingInvitations(workspaceId: number): Promise<InvitationRow[]> {
  const payload = await getPayloadClient()
  const rows = await payload.find({
    collection: 'invitations',
    where: { and: [{ workspace: { equals: workspaceId } }, { status: { equals: 'pending' } }] },
    limit: 500,
    depth: 1,
    sort: '-createdAt',
    overrideAccess: true,
  })
  const now = Date.now()
  return rows.docs.map((row) => {
    const invitedBy = typeof row.invitedBy === 'object' && row.invitedBy ? row.invitedBy : null
    return {
      id: row.id,
      email: row.email,
      role: row.role as InvitableRole,
      token: row.token,
      status: row.status,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      invitedByName: invitedBy ? invitedBy.name || invitedBy.email : null,
      channelId: asChannelId(row.channelId),
      expired: new Date(row.expiresAt).getTime() < now,
    }
  })
}

/**
 * Create an invitation, or refresh the one that already exists.
 *
 * Re-inviting the same address does NOT stack rows. A second pending invite for
 * one email means two live tokens for one seat, and the audit question "who let
 * this person in" then has two answers; instead the existing row gets a new
 * token and a new expiry, which is also what somebody clicking "invite" a
 * second time actually wants — the first link having been lost is the usual
 * reason they clicked it.
 *
 * Refuses an address that is already a member. That is not an invite, and
 * sending one would produce a link that lands on "you are already in this
 * workspace" — a dead end handed out as an action.
 */
export async function createInvitation(input: {
  payload: BasePayload
  workspaceId: number
  email: string
  role: InvitableRole
  invitedBy: number
  channelId?: number | null
}): Promise<InvitationRow> {
  const { payload, workspaceId } = input
  const email = normaliseEmail(input.email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    raise('invalid_input', `"${input.email.trim()}" is not an email address.`)
  }

  const existingUser = await payload.find({
    collection: 'users',
    where: { email: { equals: email } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  if (existingUser.docs[0]) {
    const already = await payload.count({
      collection: 'workspace-members',
      where: {
        and: [{ workspace: { equals: workspaceId } }, { user: { equals: existingUser.docs[0].id } }],
      },
      overrideAccess: true,
    })
    if (already.totalDocs > 0) raise('conflict', `${email} is already in this workspace.`)
  }

  const token = newToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const pending = await payload.find({
    collection: 'invitations',
    where: {
      and: [
        { workspace: { equals: workspaceId } },
        { email: { equals: email } },
        { status: { equals: 'pending' } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })

  const saved = pending.docs[0]
    ? await payload.update({
        collection: 'invitations',
        id: pending.docs[0].id,
        data: {
          token,
          expiresAt,
          role: input.role,
          invitedBy: input.invitedBy,
          // A channel invite that is re-sent without a channel must not silently
          // drop the channel it was for; an explicit new channel replaces it.
          channelId: input.channelId ?? pending.docs[0].channelId ?? null,
        },
        depth: 0,
        overrideAccess: true,
      })
    : await payload.create({
        collection: 'invitations',
        data: {
          workspace: workspaceId,
          email,
          role: input.role,
          token,
          status: 'pending',
          invitedBy: input.invitedBy,
          expiresAt,
          channelId: input.channelId ?? null,
        },
        depth: 0,
        overrideAccess: true,
      })

  await recordMembershipActivity({
    payload,
    workspaceId,
    actorId: input.invitedBy,
    action: MEMBERSHIP_ACTIONS.inviteSent,
    details: { email, role: input.role, channelId: asChannelId(saved.channelId), resent: Boolean(pending.docs[0]) },
  })

  return {
    id: saved.id,
    email: saved.email,
    role: saved.role as InvitableRole,
    token: saved.token,
    status: saved.status,
    expiresAt: saved.expiresAt,
    createdAt: saved.createdAt,
    invitedByName: null,
    channelId: asChannelId(saved.channelId),
    expired: false,
  }
}

export async function revokeInvitation(input: {
  payload: BasePayload
  workspaceId: number
  invitationId: number
  actorId: number
}): Promise<void> {
  const { payload } = input
  const invite = await payload.findByID({
    collection: 'invitations',
    id: input.invitationId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })
  if (!invite) raise('not_found', 'That invitation no longer exists.')
  const owner = typeof invite.workspace === 'number' ? invite.workspace : invite.workspace?.id
  // Same sentence as a missing row: an id from another workspace must not be
  // distinguishable from one that was never there.
  if (owner !== input.workspaceId) raise('not_found', 'That invitation no longer exists.')
  if (invite.status === 'accepted') {
    raise('conflict', `${invite.email} has already accepted this invitation. Remove them from the member list instead.`)
  }
  if (invite.status === 'revoked') return

  await payload.update({
    collection: 'invitations',
    id: invite.id,
    data: { status: 'revoked' },
    overrideAccess: true,
  })
  await recordMembershipActivity({
    payload,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: MEMBERSHIP_ACTIONS.inviteRevoked,
    details: { email: invite.email, role: invite.role },
  })
}

// --- Accept -----------------------------------------------------------------

/** Everything the accept screen needs to render, whether or not accepting is
 * possible. `reason` is null exactly when the invite can be accepted by this
 * person right now. */
export interface InvitationPreview {
  token: string
  email: string
  role: InvitableRole
  workspaceName: string
  workspaceSlug: string
  invitedByName: string | null
  channelName: string | null
  expiresAt: string
  /** Machine-readable refusal, so the screen can choose its own words and its
   * own next action per case rather than printing one sentence for five very
   * different situations. */
  reason: 'expired' | 'revoked' | 'accepted' | 'wrong_email' | 'already_member' | null
}

/**
 * Read an invite by token and say, honestly, what is wrong with it.
 *
 * FIVE DISTINCT REFUSALS, not one. "This invitation is not valid" is the
 * sentence that generates a support ticket every time: the person cannot tell
 * whether to ask for a new link (expired), stop asking (revoked), sign in as
 * somebody else (wrong email), or simply open the workspace (already a member).
 * Each of those has a different next action, so each gets its own answer.
 *
 * `viewerEmail` null means nobody is signed in — which is not a refusal, it is
 * the normal first state of an invite link, and the screen asks them to sign in
 * rather than telling them the invite is bad.
 */
export async function previewInvitation(
  token: string,
  viewer: { id: number; email: string } | null,
): Promise<InvitationPreview | null> {
  const payload = await getPayloadClient()
  const found = await payload.find({
    collection: 'invitations',
    where: { token: { equals: token } },
    limit: 1,
    depth: 1,
    overrideAccess: true,
  })
  const invite = found.docs[0]
  if (!invite) return null
  const workspace = typeof invite.workspace === 'object' ? invite.workspace : null
  if (!workspace) return null

  const invitedBy = typeof invite.invitedBy === 'object' && invite.invitedBy ? invite.invitedBy : null
  const base = {
    token,
    email: invite.email,
    role: invite.role as InvitableRole,
    workspaceName: workspace.name,
    workspaceSlug: workspace.slug,
    invitedByName: invitedBy ? invitedBy.name || invitedBy.email : null,
    channelName: asChannelId(invite.channelId) != null ? await channelNameOf(asChannelId(invite.channelId)!) : null,
    expiresAt: invite.expiresAt,
  }

  if (invite.status === 'revoked') return { ...base, reason: 'revoked' }
  if (invite.status === 'accepted') return { ...base, reason: 'accepted' }
  if (new Date(invite.expiresAt).getTime() < Date.now()) return { ...base, reason: 'expired' }
  if (!viewer) return { ...base, reason: null }
  if (normaliseEmail(viewer.email) !== normaliseEmail(invite.email)) return { ...base, reason: 'wrong_email' }

  const already = await payload.count({
    collection: 'workspace-members',
    where: { and: [{ workspace: { equals: workspace.id } }, { user: { equals: viewer.id } }] },
    overrideAccess: true,
  })
  return { ...base, reason: already.totalDocs > 0 ? 'already_member' : null }
}

/** The channel's name, for the "you were invited to #general" line. A missing
 * channel is not an error here — it was deleted between the invite and the
 * accept, and the workspace membership is still worth granting. */
async function channelNameOf(channelId: number): Promise<string | null> {
  try {
    const { rows } = await getBrokerPool().query<{ name: string }>(
      `SELECT name FROM teams WHERE id = $1`,
      [channelId],
    )
    return rows[0]?.name ?? null
  } catch (err) {
    logger.warn('could not read the invited channel name', {
      channelId,
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export interface AcceptedInvitation {
  workspaceSlug: string
  workspaceName: string
  role: WorkspaceRole
  /** The channel they landed in, when the invite carried one and it still
   * exists. Drives where the screen sends them next. */
  channelId: number | null
}

/**
 * Accept an invitation, as the signed-in person.
 *
 * Re-validates everything `previewInvitation` checked. The preview is what the
 * screen renders; this is what actually decides, and a server action is a
 * public endpoint reachable without ever rendering that screen — so a check
 * that lives only in the preview is a decoration.
 *
 * ORDER MATTERS. Membership is written first and the invite is marked accepted
 * second: a crash between them leaves a live token and a member, which the next
 * click resolves harmlessly (`addWorkspaceMember` is idempotent), whereas the
 * reverse leaves a consumed token and no membership, which nobody can recover
 * from without an administrator.
 */
export async function acceptInvitation(input: {
  token: string
  user: { id: number; email: string; name?: string | null }
}): Promise<AcceptedInvitation> {
  const payload = await getPayloadClient()
  const found = await payload.find({
    collection: 'invitations',
    where: { token: { equals: input.token } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const invite = found.docs[0]
  if (!invite) raise('not_found', 'This invitation link is not one we recognise. Ask for a new one.')

  if (invite.status === 'revoked') {
    raise('forbidden', 'This invitation was revoked by the person who sent it. Ask them to invite you again.')
  }
  if (invite.status === 'accepted') {
    raise('conflict', 'This invitation has already been used. If it was you, the workspace is already in your sidebar.')
  }
  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    raise('forbidden', `This invitation expired on ${new Date(invite.expiresAt).toLocaleDateString()}. Ask for a new link.`)
  }
  if (normaliseEmail(input.user.email) !== normaliseEmail(invite.email)) {
    raise(
      'forbidden',
      `This invitation was sent to ${invite.email}, and you are signed in as ${input.user.email}. Sign in with the invited address, or ask for an invitation to this one.`,
    )
  }

  const workspaceId = typeof invite.workspace === 'number' ? invite.workspace : invite.workspace.id
  const workspace = await payload.findByID({
    collection: 'workspaces',
    id: workspaceId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })
  if (!workspace) raise('not_found', 'The workspace this invitation was for no longer exists.')

  const role = invite.role as WorkspaceRole
  const invitedBy = typeof invite.invitedBy === 'number' ? invite.invitedBy : invite.invitedBy?.id
  await addWorkspaceMember({ payload, workspaceId, userId: input.user.id, role, invitedBy })

  let channelId: number | null = null
  const invitedChannelId = asChannelId(invite.channelId)
  if (invitedChannelId != null) {
    channelId = await joinChannelOnAccept({
      channelId: invitedChannelId,
      workspaceId,
      userId: input.user.id,
      displayName: input.user.name || input.user.email,
    })
  }

  await payload.update({
    collection: 'invitations',
    id: invite.id,
    data: { status: 'accepted', acceptedBy: input.user.id },
    overrideAccess: true,
  })

  await recordMembershipActivity({
    payload,
    workspaceId,
    actorId: input.user.id,
    action: MEMBERSHIP_ACTIONS.inviteAccepted,
    details: { email: invite.email, role, channelId },
  })

  return { workspaceSlug: workspace.slug, workspaceName: workspace.name, role, channelId }
}

/**
 * Give the new member the channel slot their invite was for.
 *
 * Direct SQL rather than `lib/broker/teams.ts`'s `addTeamMember`, which has no
 * `user_id` parameter and would violate migration 0013's `agent_id XOR user_id`
 * CHECK for a person — the same reason the channel route's own `insertSlot`
 * does it this way. No `chat_sessions` row is created: a session belongs to an
 * agent slot, and a person speaks as themselves.
 *
 * Returns null rather than throwing when the channel is gone or belongs to a
 * different workspace. The workspace membership has already been granted at
 * this point and is the part that matters; failing the whole accept because a
 * channel was deleted last week would strand somebody outside a workspace they
 * were legitimately invited to.
 */
async function joinChannelOnAccept(input: {
  channelId: number
  workspaceId: number
  userId: number
  displayName: string
}): Promise<number | null> {
  try {
    const pool = getBrokerPool()
    const { rows: teams } = await pool.query<{ id: number; workspace_id: number }>(
      `SELECT id, workspace_id FROM teams WHERE id = $1`,
      [input.channelId],
    )
    const team = teams[0]
    if (!team || Number(team.workspace_id) !== input.workspaceId) return null

    // A person holds at most one slot per channel (`resolveMySlot` picks the
    // lowest id, so a second slot could never be spoken from), and an invite
    // link is clickable twice.
    const { rows: existing } = await pool.query<{ id: number }>(
      `SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`,
      [input.channelId, input.userId],
    )
    if (existing[0]) return input.channelId

    const { rows: counted } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM team_members WHERE team_id = $1`,
      [input.channelId],
    )
    await pool.query(
      `INSERT INTO team_members (team_id, agent_id, user_id, role, display_name, colour)
       VALUES ($1, NULL, $2, 'member', $3, $4)`,
      [input.channelId, input.userId, input.displayName, slotColourFor(Number(counted[0]?.count ?? 0))],
    )
    return input.channelId
  } catch (err) {
    logger.warn('invited member joined the workspace but not the channel', {
      channelId: input.channelId,
      userId: input.userId,
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
