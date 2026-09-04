'use server'

import { revalidatePath } from 'next/cache'
import type { BasePayload, Where } from 'payload'

import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { bestEffort, guard, raise, type WithFailure } from '@/lib/failures'
import { recordActivity } from '@/lib/activity'
import { listTeams } from '@/lib/broker'
import {
  agentHasAnyGrant,
  can,
  grantRoleFromWorkspaceRole,
  loadAccess,
  refusalMessage,
  weakerGrantRole,
  type Access,
  type GrantRole,
} from '@/lib/permissions'
import type { AgentReach, AgentReachRow, ObjectAccess, ShareObjectType } from './types'

/**
 * The read and write side of per-object access, for the share surfaces on the
 * project and agent detail pages.
 *
 * WHY THESE LIVE UNDER `components/access/` RATHER THAN IN A ROUTE'S
 * `actions.ts`. The same four writes back two different routes — a project's
 * share panel and an agent's — and putting them under either route would make
 * the other one import across a page boundary it has nothing to do with.
 * `'use server'` is a module marker, not a directory rule, so the actions live
 * next to the only components that call them.
 *
 * Every one of these RETURNS its failure (`guard`) rather than throwing: a
 * thrown action error reaches a production browser as `1:E{"digest":...}` with
 * no message at all, and a refused permission change is precisely the case
 * where the sentence is the entire value. See `lib/failures.ts` for the
 * measurement.
 */

const RANK: Record<GrantRole, number> = { viewer: 1, editor: 2, admin: 3 }

async function requireUser() {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You must be logged in.')
  return user
}

/**
 * The refusal sentence for a `share` the caller does not have, or null when
 * they do.
 *
 * Computed and returned rather than thrown, because the panel renders the
 * control DISABLED with this reason attached. A control that is silently
 * absent teaches people the feature does not exist, and then they ask support
 * for something that was in front of them all along.
 */
function shareRefusalFor(access: Access, objectType: ShareObjectType, objectId: string): string | null {
  if (can(access, 'share', objectType, objectId)) return null
  return refusalMessage({
    verb: 'share',
    objectType,
    currentRole: access.grants.get(`${objectType}:${objectId}`) ?? access.role,
  })
}

/**
 * Write the audit row for a grant change.
 *
 * ANCHORED ON THE OBJECT ITSELF, always. A grant on a project lands on that
 * project's timeline, a grant on an agent on that agent's, a grant on a
 * channel on that channel's — `ACTIVITY_ENTITY_TYPES` carries `agent` and
 * `channel` for exactly this. The rejected alternative was filing agent and
 * channel grants against the workspace: it would have put every one of them in
 * one undifferentiated pile, and the question an auditor actually asks is
 * "what happened to THIS agent", which a workspace-anchored row cannot answer
 * without a scan.
 *
 * `objectType`/`objectId` still ride in the payload. The entity type already
 * says both, but a row that repeats them survives being read through a filter
 * that has narrowed on something else.
 *
 * Best-effort by construction: an audit row that fails must not roll back the
 * permission change the person just made and watched succeed.
 */
async function recordGrantAudit(input: {
  payload: BasePayload
  objectType: ShareObjectType
  objectId: string
  actorId: number
  action: 'access_granted' | 'access_role_changed' | 'access_revoked'
  details: Record<string, unknown>
}) {
  const details = { ...input.details, objectType: input.objectType, objectId: input.objectId }
  await bestEffort(
    // `recordActivity` writes the row AND notifies the entity's followers, and
    // the follower half is only usable for a project: `FOLLOWABLE_ENTITY_TYPES`
    // is `task | project | page`, backed by its own narrower Postgres enum, so
    // asking it for an agent's followers is a query the database rejects
    // outright. Nobody can follow an agent or a channel, so there is nobody to
    // notify — the row is written directly rather than through a helper whose
    // second half is guaranteed to fail. Kept as one `bestEffort` either way:
    // an audit row must not roll back the permission change it describes.
    input.objectType === 'project'
      ? recordActivity({
          payload: input.payload,
          entityType: 'project',
          entityId: input.objectId,
          actor: input.actorId,
          action: input.action,
          details,
        })
      : input.payload.create({
          collection: 'activity',
          data: {
            entityType: input.objectType,
            entityId: input.objectId,
            actor: input.actorId,
            action: input.action,
            payload: details,
          },
          overrideAccess: true,
        }),
    'an audit row must never fail the permission change it describes',
    { objectType: input.objectType, objectId: input.objectId },
  )
}

function displayName(value: unknown, fallback: string): string {
  if (value && typeof value === 'object') {
    const record = value as { name?: unknown; email?: unknown }
    if (typeof record.name === 'string' && record.name.trim()) return record.name
    if (typeof record.email === 'string' && record.email.trim()) return record.email
  }
  return fallback
}

function relationId(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'number') {
    return (value as { id: number }).id
  }
  return null
}

/**
 * Everything a share panel renders, in one call.
 *
 * Grants, the people who could be added, and whether the person looking may
 * change any of it. One action rather than three, because the panel cannot
 * usefully paint any of them alone and three round trips to fill one card is
 * exactly what D0 forbids.
 */
export async function listObjectAccess(input: {
  workspaceId: number
  objectType: ShareObjectType
  objectId: string
}): Promise<WithFailure<ObjectAccess>> {
  return guard(async () => {
    const user = await requireUser()
    const payload = await getPayloadClient()
    const access = await loadAccess(user.id, input.workspaceId)
    if (!can(access, 'read', input.objectType, input.objectId)) {
      raise('forbidden', refusalMessage({ verb: 'read', objectType: input.objectType, currentRole: access.role }))
    }

    const [grants, members] = await Promise.all([
      payload.find({
        collection: 'access-grants',
        where: {
          and: [
            { workspace: { equals: input.workspaceId } },
            { objectType: { equals: input.objectType } },
            { objectId: { equals: input.objectId } },
          ],
        },
        // depth 1 so a subject's name arrives with the row. The alternative —
        // ids here and a lookup per row — is the N+1 this panel would pay on
        // every open, for a list that is never more than a screenful.
        depth: 1,
        limit: 200,
        overrideAccess: true,
      }),
      payload.find({
        collection: 'workspace-members',
        where: { workspace: { equals: input.workspaceId } },
        depth: 1,
        limit: 500,
        overrideAccess: true,
      }),
    ])

    return {
      objectType: input.objectType,
      objectId: input.objectId,
      grants: grants.docs.map((grant) => {
        const subjectUserId = relationId(grant.subjectUser)
        const subjectAgentId = relationId(grant.subjectAgent)
        const isUser = subjectUserId !== null
        return {
          id: grant.id,
          role: grant.role as GrantRole,
          subjectKind: (isUser ? 'user' : 'agent') as 'user' | 'agent',
          subjectId: (isUser ? subjectUserId : subjectAgentId) ?? 0,
          subjectName: displayName(
            isUser ? grant.subjectUser : grant.subjectAgent,
            isUser ? `User #${subjectUserId}` : `Agent #${subjectAgentId}`,
          ),
          subjectEmail:
            isUser && grant.subjectUser && typeof grant.subjectUser === 'object'
              ? (grant.subjectUser.email ?? null)
              : null,
          grantedByName: grant.grantedBy ? displayName(grant.grantedBy, 'Someone') : null,
          createdAt: grant.createdAt ?? null,
        }
      }),
      candidates: members.docs
        .map((member) => {
          const memberUser = member.user
          if (!memberUser || typeof memberUser === 'number') return null
          return {
            userId: memberUser.id,
            name: memberUser.name || memberUser.email,
            email: memberUser.email,
            workspaceRole: member.role,
            impliedRole: grantRoleFromWorkspaceRole(member.role),
          }
        })
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
      canShare: can(access, 'share', input.objectType, input.objectId),
      shareRefusal: shareRefusalFor(access, input.objectType, input.objectId),
      viewerWorkspaceRole: access.role,
    }
  })
}

/**
 * Give a person or an agent a role on one object.
 *
 * Idempotent by design: a repeated grant for the same subject updates the
 * existing row rather than failing on the unique index. A share dialog that
 * errors because somebody was added twice is telling the user about our
 * schema, not about their intent.
 */
export async function grantAccess(input: {
  workspaceId: number
  workspaceSlug: string
  objectType: ShareObjectType
  objectId: string
  subjectUserId?: number
  subjectAgentId?: number
  role: GrantRole
}): Promise<WithFailure<{ grantId: number; role: GrantRole }>> {
  return guard(async () => {
    const user = await requireUser()
    const payload = await getPayloadClient()
    const access = await loadAccess(user.id, input.workspaceId)
    const refusal = shareRefusalFor(access, input.objectType, input.objectId)
    if (refusal) raise('forbidden', refusal)

    const hasUser = typeof input.subjectUserId === 'number'
    const hasAgent = typeof input.subjectAgentId === 'number'
    if (hasUser === hasAgent) {
      raise(
        'invalid_input',
        'A grant is for exactly one subject — either a person or an agent, not both and not neither.',
      )
    }

    if (input.objectType === 'agent' && hasAgent) {
      // "Agent A may edit agent B" is not a question this product asks, and
      // allowing it would invite a delegation graph nobody can audit.
      raise('invalid_input', 'An agent cannot be given access to another agent.')
    }

    // Neither id is trusted: both arrive from a URL and a form. The object has
    // to be IN this workspace and the subject has to belong to it, or a share
    // panel becomes a way to write rows naming a stranger against something in
    // somebody else's workspace. Nothing in the schema can enforce this —
    // `access_grants.objectId` is text and polymorphic by design.
    await assertObjectInWorkspace(payload, input.workspaceId, input.objectType, input.objectId)
    await assertSubjectInWorkspace(payload, input.workspaceId, input.subjectUserId, input.subjectAgentId)

    // Typed as `Where` explicitly: the ternary otherwise widens to a union
    // whose two arms each declare the OTHER key as `undefined`, which Payload's
    // index signature rejects.
    const subjectWhere: Where = hasUser
      ? { subjectUser: { equals: input.subjectUserId } }
      : { subjectAgent: { equals: input.subjectAgentId } }
    const existing = await payload.find({
      collection: 'access-grants',
      where: {
        and: [
          { workspace: { equals: input.workspaceId } },
          { objectType: { equals: input.objectType } },
          { objectId: { equals: input.objectId } },
          subjectWhere,
        ],
      },
      depth: 0,
      limit: 1,
      overrideAccess: true,
    })

    const previous = existing.docs[0]
    const saved = previous
      ? await payload.update({
          collection: 'access-grants',
          id: previous.id,
          data: { role: input.role, grantedBy: user.id },
          overrideAccess: true,
        })
      : await payload.create({
          collection: 'access-grants',
          data: {
            workspace: input.workspaceId,
            objectType: input.objectType,
            objectId: input.objectId,
            subjectUser: hasUser ? input.subjectUserId : undefined,
            subjectAgent: hasAgent ? input.subjectAgentId : undefined,
            role: input.role,
            grantedBy: user.id,
          },
          overrideAccess: true,
        })

    await recordGrantAudit({
      payload,
      objectType: input.objectType,
      objectId: input.objectId,
      actorId: user.id,
      action: previous ? 'access_role_changed' : 'access_granted',
      details: {
        subjectKind: hasUser ? 'user' : 'agent',
        subjectId: hasUser ? input.subjectUserId : input.subjectAgentId,
        from: previous ? previous.role : null,
        to: input.role,
      },
    })

    revalidateFor(input.workspaceSlug, input.objectType, input.objectId)
    return { grantId: saved.id, role: input.role }
  })
}

/** Change an existing grant's role. Separate from `grantAccess` so the audit
 * row can say what it changed FROM without the caller having to tell us — a
 * caller-supplied "from" is a claim, and an audit log made of claims is not
 * one. */
export async function updateGrantRole(input: {
  workspaceId: number
  workspaceSlug: string
  grantId: number
  role: GrantRole
}): Promise<WithFailure<{ grantId: number; role: GrantRole }>> {
  return guard(async () => {
    const user = await requireUser()
    const payload = await getPayloadClient()
    const grant = await loadGrantInWorkspace(payload, input.grantId, input.workspaceId)

    const access = await loadAccess(user.id, input.workspaceId)
    const refusal = shareRefusalFor(access, grant.objectType, grant.objectId)
    if (refusal) raise('forbidden', refusal)

    await payload.update({
      collection: 'access-grants',
      id: grant.id,
      data: { role: input.role, grantedBy: user.id },
      overrideAccess: true,
    })

    await recordGrantAudit({
      payload,
      objectType: grant.objectType,
      objectId: grant.objectId,
      actorId: user.id,
      action: 'access_role_changed',
      details: {
        subjectKind: relationId(grant.subjectUser) !== null ? 'user' : 'agent',
        subjectId: relationId(grant.subjectUser) ?? relationId(grant.subjectAgent),
        from: grant.role,
        to: input.role,
      },
    })

    revalidateFor(input.workspaceSlug, grant.objectType, grant.objectId)
    return { grantId: grant.id, role: input.role }
  })
}

export async function revokeGrant(input: {
  workspaceId: number
  workspaceSlug: string
  grantId: number
}): Promise<WithFailure<{ grantId: number }>> {
  return guard(async () => {
    const user = await requireUser()
    const payload = await getPayloadClient()
    const grant = await loadGrantInWorkspace(payload, input.grantId, input.workspaceId)

    const access = await loadAccess(user.id, input.workspaceId)
    const refusal = shareRefusalFor(access, grant.objectType, grant.objectId)
    if (refusal) raise('forbidden', refusal)

    await payload.delete({ collection: 'access-grants', id: grant.id, overrideAccess: true })

    await recordGrantAudit({
      payload,
      objectType: grant.objectType,
      objectId: grant.objectId,
      actorId: user.id,
      action: 'access_revoked',
      details: {
        subjectKind: relationId(grant.subjectUser) !== null ? 'user' : 'agent',
        subjectId: relationId(grant.subjectUser) ?? relationId(grant.subjectAgent),
        from: grant.role,
        to: null,
      },
    })

    revalidateFor(input.workspaceSlug, grant.objectType, grant.objectId)
    return { grantId: grant.id }
  })
}

/**
 * What this agent may reach, and what the person looking would actually get
 * out of it.
 *
 * Both halves of the intersection are computed here rather than in the
 * browser, because only the server can see the viewer's own grants — and a
 * permissions screen that guesses at the effective answer is the exact failure
 * this whole unit exists to prevent.
 */
export async function listAgentReach(input: {
  workspaceId: number
  agentId: number
}): Promise<WithFailure<AgentReach>> {
  return guard(async () => {
    const user = await requireUser()
    const payload = await getPayloadClient()
    const access = await loadAccess(user.id, input.workspaceId)
    if (!can(access, 'read', 'agent', input.agentId)) {
      raise('forbidden', refusalMessage({ verb: 'read', objectType: 'agent', currentRole: access.role }))
    }

    const [agent, agentGrants, projects, channels, hasAnyGrant] = await Promise.all([
      payload.findByID({
        collection: 'agents',
        id: input.agentId,
        depth: 0,
        overrideAccess: true,
        disableErrors: true,
      }),
      payload.find({
        collection: 'access-grants',
        where: {
          and: [{ workspace: { equals: input.workspaceId } }, { subjectAgent: { equals: input.agentId } }],
        },
        depth: 0,
        limit: 500,
        overrideAccess: true,
      }),
      payload.find({
        collection: 'projects',
        where: { workspace: { equals: input.workspaceId } },
        sort: 'name',
        depth: 0,
        limit: 200,
        overrideAccess: true,
      }),
      // Channels are broker rows, not a Payload collection — which is exactly
      // why `access_grants.objectId` is text. A broker outage must not take
      // the whole panel down, so the projects half still renders.
      listTeams(input.workspaceId).catch(() => []),
      agentHasAnyGrant(input.agentId, input.workspaceId),
    ])
    if (!agent) raise('not_found', 'That agent no longer exists.')

    const byObject = new Map<string, { id: number; role: GrantRole }>()
    for (const grant of agentGrants.docs) {
      byObject.set(`${grant.objectType}:${grant.objectId}`, { id: grant.id, role: grant.role as GrantRole })
    }

    const buildRow = (
      objectType: AgentReachRow['objectType'],
      objectId: string,
      objectName: string,
    ): AgentReachRow => {
      const grant = byObject.get(`${objectType}:${objectId}`) ?? null
      const workspaceRole = access.role
      const viewerRole = workspaceRole
        ? (() => {
            const fromWorkspace = grantRoleFromWorkspaceRole(workspaceRole)
            const specific = access.grants.get(`${objectType}:${objectId}`)
            return specific && RANK[specific] > RANK[fromWorkspace] ? specific : fromWorkspace
          })()
        : null
      const agentRole = grant?.role ?? null
      return {
        objectType,
        objectId,
        objectName,
        agentRole,
        viewerRole,
        // `effectiveAgentRole`'s own rule, applied to roles already in hand
        // rather than re-queried per object: both sides required, weaker wins.
        // This deliberately does NOT apply the no-grants-anywhere migration
        // affordance — the panel states that in words instead, because showing
        // `editor` in a table implies a grant that does not exist.
        effectiveForViewer: agentRole && viewerRole ? weakerGrantRole(agentRole, viewerRole) : null,
        canShare: can(access, 'share', objectType, objectId),
        shareRefusal: shareRefusalFor(access, objectType, objectId),
        grantId: grant?.id ?? null,
      }
    }

    return {
      agentId: input.agentId,
      agentName: agent.name,
      rows: [
        ...projects.docs.map((project) => buildRow('project', String(project.id), project.name)),
        ...channels.map((channel) => buildRow('channel', String(channel.id), channel.name)),
      ],
      hasAnyGrant,
    }
  })
}

/**
 * The object a grant names must live in the workspace the grant is written
 * against. `not_found` for the wrong workspace rather than `forbidden`, so the
 * two are indistinguishable and an id cannot be probed.
 */
async function assertObjectInWorkspace(
  payload: BasePayload,
  workspaceId: number,
  objectType: ShareObjectType,
  objectId: string,
): Promise<void> {
  if (objectType === 'channel') {
    const channels = await listTeams(workspaceId, { includeArchived: true })
    if (!channels.some((channel) => String(channel.id) === objectId)) {
      raise('not_found', 'That channel no longer exists in this workspace.')
    }
    return
  }
  const numericId = Number(objectId)
  if (!Number.isFinite(numericId)) raise('invalid_input', 'That is not a valid id.')
  const doc = await payload.findByID({
    collection: objectType === 'project' ? 'projects' : 'agents',
    id: numericId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })
  if (!doc || relationId(doc.workspace) !== workspaceId) {
    raise('not_found', `That ${objectType} no longer exists in this workspace.`)
  }
}

/** And so must the subject. A grant does not confer membership, but it does
 * put a name on other people's screens — an outsider's should never get there. */
async function assertSubjectInWorkspace(
  payload: BasePayload,
  workspaceId: number,
  subjectUserId: number | undefined,
  subjectAgentId: number | undefined,
): Promise<void> {
  if (typeof subjectUserId === 'number') {
    const membership = await payload.count({
      collection: 'workspace-members',
      where: { and: [{ workspace: { equals: workspaceId } }, { user: { equals: subjectUserId } }] },
      overrideAccess: true,
    })
    if (membership.totalDocs === 0) raise('not_found', 'That person is not a member of this workspace.')
    return
  }
  const agent = await payload.findByID({
    collection: 'agents',
    id: subjectAgentId as number,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })
  if (!agent || relationId(agent.workspace) !== workspaceId) {
    raise('not_found', 'That agent is not in this workspace.')
  }
}

async function loadGrantInWorkspace(payload: BasePayload, grantId: number, workspaceId: number) {
  const grant = await payload.findByID({
    collection: 'access-grants',
    id: grantId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })
  // `not_found` rather than `forbidden` for a grant in somebody else's
  // workspace, deliberately: the two must be indistinguishable or probing ids
  // becomes a way to enumerate another workspace's rows.
  if (!grant || relationId(grant.workspace) !== workspaceId) {
    raise('not_found', 'That access grant no longer exists.')
  }
  return {
    id: grant.id,
    objectType: grant.objectType as ShareObjectType,
    objectId: grant.objectId,
    role: grant.role as GrantRole,
    subjectUser: grant.subjectUser,
    subjectAgent: grant.subjectAgent,
  }
}

function revalidateFor(workspaceSlug: string, objectType: ShareObjectType, objectId: string) {
  if (objectType === 'project') revalidatePath(`/workspace/${workspaceSlug}/projects/${objectId}`)
  else if (objectType === 'agent') revalidatePath(`/workspace/${workspaceSlug}/agents/${objectId}`)
}
