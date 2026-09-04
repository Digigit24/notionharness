import 'server-only'

import { getPayloadClient } from '@/lib/payload'
import { effectiveAgentAccess, grantRoleAllows, type GrantRole } from '@/lib/permissions'
import type { Connection, Connector } from '@/payload-types'

/**
 * What an agent can actually reach, and the three separate reasons it might
 * not.
 *
 * THE UNION, NOT A PRECEDENCE. `collections/Connectors.ts` states the rule and
 * the reason; this is the code it is a rule for. An agent's connectors are the
 * union of the workspace's, its project's and its own — never a
 * "most-specific-level-wins" merge. Tool availability is additive. Applying
 * `runtimeConfig`'s override chain here (it is one file away and looks like
 * the place for defaults) would mean granting one agent-level connector
 * silently DELETED every workspace-level one for that agent, which is the
 * opposite of what a narrower scope should mean and would present as an agent
 * mysteriously losing tools the moment somebody gave it one.
 *
 * THEN TWO FILTERS, AND THEY ARE NOT THE SAME KIND OF THING.
 *
 *   1. The accountable USER must hold a live connection for the toolkit. This
 *      is not a permission check — it is the observation that there is no
 *      credential to act with. A connector nobody has connected is OUT OF
 *      SCOPE, not broken, and the difference matters because one of those
 *      belongs in a transcript as an error and the other does not.
 *
 *   2. `effectiveAgentAccess` must grant `execute` on the object the connector
 *      hangs off. This is the intersection rule from `lib/permissions/model.ts`
 *      and it is the reason the whole permission layer exists: without it,
 *      "give the agent Slack" is a privilege-escalation path where a viewer
 *      triggers a run that posts as an admin.
 *
 * The pure functions come first so both filters can be asserted against
 * fixture rows with no database, which is what `scripts/verify-connector-scope.ts`
 * does.
 */

/** The fields scope resolution reads. A structural type rather than
 * `payload-types`' `Connector` so a fixture in a test can be written by hand
 * without inventing timestamps and relationship depths that no rule consults. */
export interface ScopedConnector {
  id: number
  toolkitSlug: string
  name: string
  scopeType: 'workspace' | 'project' | 'agent'
  /** The project or agent id, as text. Null at workspace scope. */
  scopeId?: string | null
  authConfigId?: string | null
  enabled?: boolean | null
  allowedTools?: unknown
}

/** The fields the connection filter reads. */
export interface ScopedConnection {
  toolkitSlug: string
  status: 'pending' | 'active' | 'failed' | 'revoked'
  composioConnectedAccountId?: string | null
}

export interface ScopeTarget {
  /** The agent the run belongs to, when there is one. */
  agentId?: number | null
  /** The project the run belongs to, when there is one. A run with no project
   * simply does not see project-scoped connectors — it is not an error. */
  projectId?: number | null
}

/**
 * The union step, on its own.
 *
 * A disabled connector is dropped here rather than filtered by the caller,
 * because "enabled" is the admin's own off switch and a row that survived it
 * would then have to be re-checked at every use site.
 */
export function connectorsInScope<T extends ScopedConnector>(rows: readonly T[], target: ScopeTarget): T[] {
  const projectId = target.projectId == null ? null : String(target.projectId)
  const agentId = target.agentId == null ? null : String(target.agentId)

  return rows.filter((row) => {
    if (row.enabled === false) return false
    switch (row.scopeType) {
      case 'workspace':
        return true
      case 'project':
        return projectId !== null && String(row.scopeId ?? '') === projectId
      case 'agent':
        return agentId !== null && String(row.scopeId ?? '') === agentId
      default:
        return false
    }
  })
}

/** A connector plus why it is or is not usable right now. Both cases are
 * returned — a screen has to be able to say "Gmail is available here but you
 * have not connected it", which a list of only the usable ones cannot. */
export interface ResolvedConnector<T extends ScopedConnector = ScopedConnector> {
  connector: T
  /** The accountable user's connection status for this toolkit, or null when
   * they have never started one. */
  connectionStatus: ScopedConnection['status'] | null
  /** True only when there is an active connection AND access allows it. */
  usable: boolean
  /** Why not, for the one screen that has to explain it. Null when usable. */
  reason: 'not_connected' | 'connection_pending' | 'connection_failed' | 'no_access' | null
}

/**
 * The connection filter, on its own.
 *
 * Only `active` counts. A `pending` connection is a person who has opened the
 * consent screen and not come back; treating it as usable would produce a run
 * that fails at the third-party rather than at our own boundary, with the
 * failure narrated by the agent instead of shown as a Connect button.
 */
export function withUserConnections<T extends ScopedConnector>(
  connectors: readonly T[],
  connections: readonly ScopedConnection[],
): ResolvedConnector<T>[] {
  const byToolkit = new Map<string, ScopedConnection>()
  for (const connection of connections) {
    const key = connection.toolkitSlug.toLowerCase()
    const existing = byToolkit.get(key)
    // A person can hold more than one row per toolkit — a failed attempt
    // followed by a good one is the ordinary case — so an active row always
    // wins over whatever was read first. Without this, the row order of a
    // `find()` decides whether somebody's Gmail works.
    if (!existing || (existing.status !== 'active' && connection.status === 'active')) {
      byToolkit.set(key, connection)
    }
  }

  return connectors.map((connector) => {
    const connection = byToolkit.get(connector.toolkitSlug.toLowerCase()) ?? null
    const status = connection?.status ?? null
    return {
      connector,
      connectionStatus: status,
      usable: status === 'active',
      reason:
        status === 'active'
          ? null
          : status === 'pending'
            ? 'connection_pending'
            : status === null
              ? 'not_connected'
              : 'connection_failed',
    }
  })
}

/**
 * The permission filter, on its own.
 *
 * `execute` rather than `read`: reaching a third party is the system ACTING,
 * which is exactly the line `lib/permissions/model.ts` drew when it separated
 * `execute` from `write`. A reviewer who may comment on a project must not be
 * able to make its agents send mail.
 */
export function allowsConnectorUse(role: GrantRole | null): boolean {
  return role !== null && grantRoleAllows(role, 'execute')
}

/**
 * The whole thing, against the database.
 *
 * Two queries and then one permission lookup per distinct scope — not per
 * connector. A workspace has three scopes at most for any one run (its own,
 * one project, one agent), so the count is bounded at three regardless of how
 * many connectors exist, which is the difference between this being usable in
 * a dispatcher hot path and not.
 */
export async function resolveConnectorsForRun(input: {
  workspaceId: number
  agentId: number
  accountableUserId: number
  projectId?: number | null
}): Promise<ResolvedConnector<ScopedConnector>[]> {
  const payload = await getPayloadClient()
  const [connectorRows, connectionRows] = await Promise.all([
    payload.find({
      collection: 'connectors',
      where: { and: [{ workspace: { equals: input.workspaceId } }, { enabled: { equals: true } }] },
      limit: 500,
      depth: 0,
      overrideAccess: true,
    }),
    payload.find({
      collection: 'connections',
      where: { and: [{ workspace: { equals: input.workspaceId } }, { user: { equals: input.accountableUserId } }] },
      limit: 500,
      depth: 0,
      overrideAccess: true,
    }),
  ])

  const inScope = connectorsInScope(connectorRows.docs as ScopedConnector[], {
    agentId: input.agentId,
    projectId: input.projectId,
  })
  const withConnections = withUserConnections(inScope, connectionRows.docs as ScopedConnection[])

  // One lookup per distinct (objectType, objectId) the surviving connectors
  // hang off, memoised, because `effectiveAgentAccess` is two queries and a
  // run with twelve workspace-scoped connectors must not pay for it twelve
  // times.
  const accessCache = new Map<string, GrantRole | null>()
  const roleFor = async (connector: ScopedConnector): Promise<GrantRole | null> => {
    const objectType = connector.scopeType
    const objectId =
      objectType === 'workspace' ? input.workspaceId : objectType === 'agent' ? input.agentId : (connector.scopeId ?? '')
    const cacheKey = `${objectType}:${objectId}`
    if (accessCache.has(cacheKey)) return accessCache.get(cacheKey) ?? null
    const role = await effectiveAgentAccess({
      agentId: input.agentId,
      accountableUserId: input.accountableUserId,
      workspaceId: input.workspaceId,
      objectType,
      objectId,
    })
    accessCache.set(cacheKey, role)
    return role
  }

  const resolved: ResolvedConnector<ScopedConnector>[] = []
  for (const entry of withConnections) {
    const role = await roleFor(entry.connector)
    if (!allowsConnectorUse(role)) {
      // `no_access` outranks a missing connection in the explanation, because
      // telling somebody to connect Gmail when the answer would still be no is
      // sending them on an errand that cannot succeed.
      resolved.push({ ...entry, usable: false, reason: 'no_access' })
      continue
    }
    resolved.push(entry)
  }
  return resolved
}

/**
 * The same union, for a SCREEN rather than for a run.
 *
 * The difference is whose connection is resolved: a person looking at an
 * agent's Connectors tab needs to know whether THEY have connected Gmail, not
 * whether the agent's last accountable user did. "You have not connected
 * Gmail" is a true and actionable sentence; "this agent has not connected
 * Gmail" is neither, since an agent never connects anything.
 */
export async function listConnectorsForSurface(input: {
  workspaceId: number
  viewerUserId: number | null
  scopeType: 'workspace' | 'project' | 'agent'
  scopeId?: number | null
}): Promise<ResolvedConnector<Connector>[]> {
  const payload = await getPayloadClient()
  const [connectorRows, connectionRows] = await Promise.all([
    payload.find({
      collection: 'connectors',
      where: {
        and: [
          { workspace: { equals: input.workspaceId } },
          { scopeType: { equals: input.scopeType } },
          ...(input.scopeType === 'workspace' ? [] : [{ scopeId: { equals: String(input.scopeId ?? '') } }]),
        ],
      },
      sort: 'name',
      limit: 200,
      depth: 0,
      overrideAccess: true,
    }),
    input.viewerUserId == null
      ? Promise.resolve({ docs: [] as Connection[] })
      : payload.find({
          collection: 'connections',
          where: { and: [{ workspace: { equals: input.workspaceId } }, { user: { equals: input.viewerUserId } }] },
          limit: 200,
          depth: 0,
          overrideAccess: true,
        }),
  ])

  // Disabled rows are kept here, unlike in `resolveConnectorsForRun`: an admin
  // looking at this list needs to see the connector they switched off, or the
  // screen appears to have lost it.
  return withUserConnections(connectorRows.docs as Connector[], connectionRows.docs as ScopedConnection[])
}
