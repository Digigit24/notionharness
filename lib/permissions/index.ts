import 'server-only'

import { getPayloadClient } from '@/lib/payload'
import { raise } from '@/lib/failures'
import {
  canDeleteWorkspace,
  effectiveAgentRole,
  grantRoleAllows,
  grantRoleFromWorkspaceRole,
  refusalMessage,
  strongerWorkspaceRole,
  weakerGrantRole,
  workspaceRoleAllows,
  type GrantRole,
  type ObjectType,
  type Verb,
  type WorkspaceRole,
} from './model'

export * from './model'

/**
 * The enforcement side. `model.ts` is the rules; this reads the database.
 *
 * Split so the rules can be tested without a database and so a client
 * component can import a role name without dragging Payload into the browser
 * bundle — `server-only` here makes that a build error rather than a surprise.
 *
 * EVERY READ HERE IS ONE QUERY, and the two that a page needs together are
 * exposed as one call (`loadAccess`). A permission layer that costs a round
 * trip per check is one that gets bypassed "just here, just this once" until it
 * is decorative — the reason the previous ad-hoc checks were cheap is the
 * reason they were everywhere.
 */

export interface Access {
  userId: number
  workspaceId: number
  /** Null when the person is not in this workspace at all. */
  role: WorkspaceRole | null
  /** Per-object grants, keyed `objectType:objectId`. Loaded in one query for
   * the whole workspace: a workspace has tens of these, not thousands, and one
   * query beats a query per object by the margin that matters. */
  grants: Map<string, GrantRole>
}

const key = (objectType: ObjectType, objectId: string | number) => `${objectType}:${objectId}`

/**
 * Everything needed to answer any permission question in this workspace, in two
 * queries.
 *
 * Cache this per request, never across requests: membership is exactly the kind
 * of live state D0 says not to cache.
 */
export async function loadAccess(userId: number, workspaceId: number): Promise<Access> {
  const payload = await getPayloadClient()
  const [members, grants] = await Promise.all([
    payload.find({
      collection: 'workspace-members',
      where: { and: [{ workspace: { equals: workspaceId } }, { user: { equals: userId } }] },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    }),
    payload.find({
      collection: 'access-grants',
      where: { and: [{ workspace: { equals: workspaceId } }, { subjectUser: { equals: userId } }] },
      limit: 500,
      depth: 0,
      overrideAccess: true,
    }),
  ])

  const map = new Map<string, GrantRole>()
  for (const grant of grants.docs) {
    const objectType = grant.objectType as ObjectType
    const existing = map.get(key(objectType, grant.objectId))
    const role = grant.role as GrantRole
    // Two grants for one object should be impossible (there is a unique index),
    // but if one ever exists the stronger wins rather than whichever was read
    // last — a permission that depends on row order is worse than either answer.
    map.set(key(objectType, grant.objectId), existing && GRANT_ORDER[existing] > GRANT_ORDER[role] ? existing : role)
  }

  return {
    userId,
    workspaceId,
    role: (members.docs[0]?.role as WorkspaceRole | undefined) ?? null,
    grants: map,
  }
}

const GRANT_ORDER: Record<GrantRole, number> = { viewer: 1, editor: 2, admin: 3 }

/**
 * May this person do this?
 *
 * Workspace membership is the floor and a grant can only RAISE it. An ACL that
 * can also subtract is one nobody can reason about at three in the morning:
 * "why can the admin not open this" would then have two possible answers in two
 * different tables. Taking access away is `visibility` on the object itself,
 * which is a different feature and is deliberately not this one.
 */
export function can(access: Access, verb: Verb, objectType: ObjectType, objectId?: string | number): boolean {
  if (!access.role) return false
  if (objectType === 'workspace' || objectId === undefined) {
    return workspaceRoleAllows(access.role, verb)
  }
  const fromWorkspace = grantRoleFromWorkspaceRole(access.role)
  const fromGrant = access.grants.get(key(objectType, objectId))
  const effective =
    fromGrant && GRANT_ORDER[fromGrant] > GRANT_ORDER[fromWorkspace] ? fromGrant : fromWorkspace
  // `administer` is never granted per object — it is a workspace-level power
  // (connectors, spend, runtime defaults) and letting a project grant confer it
  // would let a project admin spend the workspace's money.
  if (verb === 'administer') return workspaceRoleAllows(access.role, 'administer')
  return grantRoleAllows(effective, verb)
}

/** The same question, but it refuses with a sentence instead of a boolean. Use
 * this in server actions; `guard()` turns the raise into a `__failure` the
 * browser can read. */
export function requireCan(
  access: Access,
  verb: Verb,
  objectType: ObjectType,
  objectId?: string | number,
): void {
  if (can(access, verb, objectType, objectId)) return
  raise(
    'forbidden',
    refusalMessage({
      verb,
      objectType,
      currentRole: objectId === undefined ? access.role : (access.grants.get(key(objectType, objectId)) ?? access.role),
    }),
  )
}

/** Load and check in one call, for the common case of a server action that
 * needs exactly one permission. */
export async function requireAccess(input: {
  userId: number
  workspaceId: number
  verb: Verb
  objectType: ObjectType
  objectId?: string | number
}): Promise<Access> {
  const access = await loadAccess(input.userId, input.workspaceId)
  requireCan(access, input.verb, input.objectType, input.objectId)
  return access
}

/**
 * What an AGENT may do on behalf of the person accountable for its run.
 *
 * The intersection rule from `model.ts`, with the two lookups it needs. Both
 * sides are required: an agent with no grant of its own gets nothing even when
 * the accountable user is the owner, because an agent's reach has to be given
 * deliberately rather than inherited from whoever happened to press the button.
 *
 * Note the fallback for an agent with NO grants anywhere: it is treated as
 * having `editor` on objects in its own workspace. That is a deliberate
 * migration affordance, not a hole — every agent that exists today predates
 * this table, and defaulting them to nothing would break every running
 * workspace on deploy. `agentHasAnyGrant` is how a caller can tell the two
 * apart, and the UI says which regime an agent is in.
 */
export async function effectiveAgentAccess(input: {
  agentId: number
  accountableUserId: number
  workspaceId: number
  objectType: ObjectType
  objectId: string | number
}): Promise<GrantRole | null> {
  const payload = await getPayloadClient()
  const [agentGrants, userAccess] = await Promise.all([
    payload.find({
      collection: 'access-grants',
      where: { and: [{ workspace: { equals: input.workspaceId } }, { subjectAgent: { equals: input.agentId } }] },
      limit: 500,
      depth: 0,
      overrideAccess: true,
    }),
    loadAccess(input.accountableUserId, input.workspaceId),
  ])

  const userRole = userAccess.role
  if (!userRole) return null
  const userGrant = (() => {
    const fromWorkspace = grantRoleFromWorkspaceRole(userRole)
    const specific = userAccess.grants.get(key(input.objectType, input.objectId))
    return specific && GRANT_ORDER[specific] > GRANT_ORDER[fromWorkspace] ? specific : fromWorkspace
  })()

  const agentSpecific = agentGrants.docs.find(
    (grant) => grant.objectType === input.objectType && String(grant.objectId) === String(input.objectId),
  )
  const agentRole: GrantRole | null = agentSpecific
    ? (agentSpecific.role as GrantRole)
    : agentGrants.docs.length === 0
      ? 'editor'
      : null

  return effectiveAgentRole(agentRole, userGrant)
}

/** True once an agent has been given any grant at all — which is when the
 * migration affordance above stops applying to it. */
export async function agentHasAnyGrant(agentId: number, workspaceId: number): Promise<boolean> {
  const payload = await getPayloadClient()
  const found = await payload.count({
    collection: 'access-grants',
    where: { and: [{ workspace: { equals: workspaceId } }, { subjectAgent: { equals: agentId } }] },
    overrideAccess: true,
  })
  return found.totalDocs > 0
}

export { canDeleteWorkspace, strongerWorkspaceRole, weakerGrantRole }
