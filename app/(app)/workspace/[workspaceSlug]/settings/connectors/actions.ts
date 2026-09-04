'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { guard, raise, type WithFailure } from '@/lib/failures'
import { requireAccess, loadAccess, can } from '@/lib/permissions'
import { listConnectorsForSurface } from '@/lib/connectors/scope'
import {
  describeKey,
  disconnect as disconnectAtComposio,
  findOrCreateAuthConfig,
  listToolkits,
  listToolkitTools,
  startConnection,
  type KeyPresence,
} from '@/lib/connectors/composio'
import { connectorIdForToolkit, refreshPendingConnections, syncConnection } from '@/lib/connectors/sync'
import {
  auditComposioKeyChanged,
  auditConnectionRevoked,
  auditConnectorAdded,
  auditConnectorRemoved,
  auditConnectorToggled,
} from '@/lib/connectors/audit'
import { logger } from '@/lib/logger'
import type { Connection, Connector, Workspace } from '@/payload-types'

/**
 * Every connector mutation and read, for all three surfaces.
 *
 * ONE ACTIONS FILE FOR THREE SCREENS, deliberately. Settings, the project tab
 * and the agent tab ask the same four questions — what is attached here, have
 * I connected it, may I add one, may I remove one — differing only in the
 * `(scopeType, scopeId)` pair. Three actions files would be three places for
 * the authorisation check to drift, and the check is the whole point.
 *
 * EVERY BODY IS WRAPPED IN `guard`. `lib/failures.ts` measured that a thrown
 * server-action error reaches a production browser as a bare digest with no
 * message; these actions have a lot to say (which key is missing, why a
 * connector is out of scope, what Composio refused) and none of it would
 * arrive if they threw.
 *
 * ADDING OR REMOVING A CONNECTOR AT ANY SCOPE NEEDS WORKSPACE `administer`.
 * Not `write` on the project, and not a project-level grant. This follows
 * `lib/permissions`' own rule — `can()` answers `administer` from the
 * workspace role alone, with the stated reason that letting a project grant
 * confer it would let a project admin spend the workspace's money. A connector
 * is exactly that kind of decision: it reaches outside, it is metered per
 * Composio organisation, and the person attaching Gmail to a project is
 * choosing what every agent on that project may do with somebody else's
 * mailbox.
 *
 * CONNECTING YOUR OWN ACCOUNT NEEDS ONLY MEMBERSHIP. It is a personal act with
 * a personal credential; a member who cannot administer the workspace can still
 * authorise their own Gmail, and gating it behind `administer` would make the
 * connector feature usable by admins only, which is the opposite of the point.
 */

export type ConnectorScopeType = 'workspace' | 'project' | 'agent'

export interface ConnectorRowView {
  id: number
  toolkitSlug: string
  name: string
  scopeType: ConnectorScopeType
  scopeId: string | null
  enabled: boolean
  allowedTools: string[]
  /** The VIEWER's own connection for this toolkit — never the agent's, never
   * another member's. */
  connection: {
    id: number
    status: Connection['status']
    /** Present while a flow is open, so a person who lost the tab can reopen
     * the same authorisation rather than starting a second one. */
    redirectUrl: string | null
    statusDetail: string | null
  } | null
  /** Why this connector cannot be used by an agent acting for the viewer right
   * now, or null when it can. */
  blockedReason: 'not_connected' | 'connection_pending' | 'connection_failed' | 'no_access' | null
}

export interface ConnectorPanelData {
  workspaceId: number
  scopeType: ConnectorScopeType
  scopeId: string | null
  connectors: ConnectorRowView[]
  /** Whether the viewer may add and remove rows here. */
  canAdminister: boolean
  /** Presence and length of the workspace's Composio key. Never the value. */
  key: KeyPresence
}

/** Resolve the workspace and the signed-in person, or refuse with a sentence.
 * Every action below starts here, so "not signed in" and "no such workspace"
 * have one wording each rather than eleven. */
async function context(workspaceSlug: string): Promise<{ workspace: Workspace; userId: number }> {
  const [workspace, user] = await Promise.all([getWorkspaceBySlug(workspaceSlug), getCurrentPayloadUser()])
  if (!user) raise('unauthenticated', 'You are not signed in.')
  if (!workspace) raise('not_found', 'That workspace no longer exists.')
  return { workspace, userId: user.id }
}

/**
 * Everything one Connectors surface renders, in three queries.
 *
 * Called from a server component on each of the three surfaces rather than
 * from the client on mount: the data is known at render time, and fetching it
 * after hydration would put a spinner where D0 says there should be content.
 */
export async function getConnectorPanel(input: {
  workspaceSlug: string
  scopeType: ConnectorScopeType
  scopeId?: number | null
}): Promise<WithFailure<ConnectorPanelData>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    const access = await loadAccess(userId, workspace.id)
    if (!can(access, 'read', 'workspace')) {
      raise('forbidden', 'You do not have access to this workspace.')
    }

    const [resolved, connections, key] = await Promise.all([
      listConnectorsForSurface({
        workspaceId: workspace.id,
        viewerUserId: userId,
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null,
      }),
      listViewerConnections(workspace.id, userId),
      describeKey(workspace.id),
    ])

    return {
      workspaceId: workspace.id,
      scopeType: input.scopeType,
      scopeId: input.scopeId == null ? null : String(input.scopeId),
      canAdminister: can(access, 'administer', 'workspace'),
      key,
      connectors: resolved.map((entry) => {
        const connection = connections.get(entry.connector.toolkitSlug.toLowerCase()) ?? null
        return {
          id: entry.connector.id,
          toolkitSlug: entry.connector.toolkitSlug,
          name: entry.connector.name,
          scopeType: entry.connector.scopeType as ConnectorScopeType,
          scopeId: entry.connector.scopeId ?? null,
          enabled: entry.connector.enabled !== false,
          allowedTools: Array.isArray(entry.connector.allowedTools)
            ? entry.connector.allowedTools.filter((slug): slug is string => typeof slug === 'string')
            : [],
          connection: connection
            ? {
                id: connection.id,
                status: connection.status,
                redirectUrl: connection.redirectUrl ?? null,
                statusDetail: connection.statusDetail ?? null,
              }
            : null,
          blockedReason: entry.reason,
        }
      }),
    }
  })
}

/** The viewer's own connections, keyed by lowercased toolkit. An active row
 * beats a stale one for the same toolkit — a retried flow leaves the failed
 * attempt behind and it is not the answer. */
async function listViewerConnections(workspaceId: number, userId: number): Promise<Map<string, Connection>> {
  const payload = await getPayloadClient()
  const rows = await payload.find({
    collection: 'connections',
    where: { and: [{ workspace: { equals: workspaceId } }, { user: { equals: userId } }] },
    limit: 200,
    depth: 0,
    overrideAccess: true,
  })
  const map = new Map<string, Connection>()
  for (const row of rows.docs as Connection[]) {
    const key = row.toolkitSlug.toLowerCase()
    const existing = map.get(key)
    if (!existing || (existing.status !== 'active' && row.status === 'active')) map.set(key, row)
  }
  return map
}

/* ---------------------------------------------------------------- */
/* The workspace's Composio key                                      */
/* ---------------------------------------------------------------- */

/**
 * Set or replace the key.
 *
 * The value goes in and never comes back: the return type is `KeyPresence`,
 * which carries a source and a length. A "show key" affordance was rejected
 * outright — `collections/Workspaces.ts` marks the field `read: () => false`
 * precisely so that no code path can serialise it to a browser, and an action
 * that returned it would defeat that from inside.
 */
export async function setComposioKey(input: {
  workspaceSlug: string
  apiKey: string
}): Promise<WithFailure<KeyPresence>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    await requireAccess({ userId, workspaceId: workspace.id, verb: 'administer', objectType: 'workspace' })

    const value = input.apiKey.trim()
    if (!value) raise('invalid_input', 'Paste a Composio API key, or use Remove to clear the one already set.')
    // A pasted key that arrived truncated is the single most common way this
    // goes wrong, and it fails later as an opaque 401 from Composio. A length
    // floor catches the obvious case without pretending to validate a format
    // Composio has never published.
    if (value.length < 16) {
      raise('invalid_input', 'That does not look like a complete Composio API key — it is only ' + value.length + ' characters.')
    }

    const payload = await getPayloadClient()
    await payload.update({
      collection: 'workspaces',
      id: workspace.id,
      data: { composioApiKey: value },
      overrideAccess: true,
    })
    // Filed against the WORKSPACE, not against a connector: changing the key
    // changes what every connector in the workspace can do at once. The value
    // is never recorded; its length is, because that is what distinguishes a
    // truncated paste from a good key at 14:02 when everything started failing.
    await auditComposioKeyChanged({ workspaceId: workspace.id, actorId: userId, keyLength: value.length })

    revalidatePath(`/workspace/${input.workspaceSlug}/settings/connectors`)
    return describeKey(workspace.id)
  })
}

/**
 * Clear the workspace's key.
 *
 * `connections` rows are left exactly as they are. `docs/HANDOFF-ENTERPRISE.md`
 * is explicit that deleting them loses the record of who had connected what,
 * which is precisely what an incident needs — and the grants themselves still
 * exist at Composio, so deleting our side would make them invisible rather
 * than revoked.
 */
export async function clearComposioKey(input: { workspaceSlug: string }): Promise<WithFailure<KeyPresence>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    await requireAccess({ userId, workspaceId: workspace.id, verb: 'administer', objectType: 'workspace' })

    const payload = await getPayloadClient()
    await payload.update({
      collection: 'workspaces',
      id: workspace.id,
      data: { composioApiKey: null },
      overrideAccess: true,
    })
    await auditComposioKeyChanged({ workspaceId: workspace.id, actorId: userId, keyLength: 0 })

    revalidatePath(`/workspace/${input.workspaceSlug}/settings/connectors`)
    // Reports the ENVIRONMENT key if there is one, which is the honest answer:
    // clearing a workspace key does not necessarily leave the workspace
    // without one, and a screen that said "not set" would be wrong.
    return describeKey(workspace.id)
  })
}

/* ---------------------------------------------------------------- */
/* Toolkits                                                          */
/* ---------------------------------------------------------------- */

export interface ToolkitOption {
  slug: string
  name: string
  logo: string | null
  description: string | null
  noAuth: boolean
  /** True when this workspace already has a connector row for it at the scope
   * being browsed. The picker greys these rather than hiding them, so a person
   * searching for Gmail is told it is already here instead of being told
   * nothing. */
  alreadyAdded: boolean
}

export async function browseToolkits(input: {
  workspaceSlug: string
  scopeType: ConnectorScopeType
  scopeId?: number | null
  search?: string
}): Promise<WithFailure<ToolkitOption[]>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    await requireAccess({ userId, workspaceId: workspace.id, verb: 'administer', objectType: 'workspace' })

    const payload = await getPayloadClient()
    const [{ toolkits }, existing] = await Promise.all([
      listToolkits(workspace.id, { search: input.search, limit: 40 }),
      payload.find({
        collection: 'connectors',
        where: {
          and: [
            { workspace: { equals: workspace.id } },
            { scopeType: { equals: input.scopeType } },
            ...(input.scopeType === 'workspace' ? [] : [{ scopeId: { equals: String(input.scopeId ?? '') } }]),
          ],
        },
        limit: 200,
        depth: 0,
        overrideAccess: true,
      }),
    ])
    const taken = new Set(existing.docs.map((row) => String(row.toolkitSlug).toLowerCase()))

    return toolkits.map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.name,
      logo: toolkit.logo,
      description: toolkit.description,
      noAuth: toolkit.noAuth,
      alreadyAdded: taken.has(toolkit.slug.toLowerCase()),
    }))
  })
}

/** The tool slugs a connector's allow-list can be built from. Loaded on demand
 * rather than with the panel: a workspace with ten connectors would otherwise
 * make ten Composio calls to render a list nobody has opened. */
export async function getToolkitTools(input: {
  workspaceSlug: string
  toolkitSlug: string
}): Promise<WithFailure<Array<{ slug: string; name: string; description: string | null }>>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    await requireAccess({ userId, workspaceId: workspace.id, verb: 'administer', objectType: 'workspace' })
    return listToolkitTools(workspace.id, input.toolkitSlug)
  })
}

/* ---------------------------------------------------------------- */
/* Connector rows                                                    */
/* ---------------------------------------------------------------- */

/**
 * Attach a toolkit at a scope.
 *
 * The auth config is created (or found) at the same moment rather than lazily
 * on first connect, for one reason: it is the step that proves the workspace's
 * key actually works. Deferring it would let an admin add six connectors with
 * a bad key and discover it only when a member tried to connect, which puts
 * the error in front of the person who cannot fix it.
 */
export async function addConnector(input: {
  workspaceSlug: string
  scopeType: ConnectorScopeType
  scopeId?: number | null
  toolkitSlug: string
  name?: string
}): Promise<WithFailure<ConnectorRowView>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    await requireAccess({ userId, workspaceId: workspace.id, verb: 'administer', objectType: 'workspace' })

    const slug = input.toolkitSlug.trim().toLowerCase()
    if (!slug) raise('invalid_input', 'Choose an app to add.')
    if (input.scopeType !== 'workspace' && input.scopeId == null) {
      raise('invalid_input', `A ${input.scopeType}-scoped connector needs a ${input.scopeType} to attach to.`)
    }

    const payload = await getPayloadClient()
    const duplicate = await payload.find({
      collection: 'connectors',
      where: {
        and: [
          { workspace: { equals: workspace.id } },
          { toolkitSlug: { equals: slug } },
          { scopeType: { equals: input.scopeType } },
          ...(input.scopeType === 'workspace' ? [] : [{ scopeId: { equals: String(input.scopeId) } }]),
        ],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    if (duplicate.docs[0]) {
      raise('conflict', `${duplicate.docs[0].name} is already attached here.`)
    }

    const authConfigId = await findOrCreateAuthConfig(workspace.id, slug)

    const created = (await payload.create({
      collection: 'connectors',
      data: {
        workspace: workspace.id,
        provider: 'composio',
        toolkitSlug: slug,
        name: input.name?.trim() || slug,
        scopeType: input.scopeType,
        scopeId: input.scopeType === 'workspace' ? null : String(input.scopeId),
        authConfigId,
        allowedTools: [],
        enabled: true,
        createdBy: userId,
      },
      overrideAccess: true,
    })) as Connector

    await auditConnectorAdded({ connector: created, actorId: userId })
    revalidateScope(input.workspaceSlug, input.scopeType, input.scopeId == null ? null : String(input.scopeId))

    const connections = await listViewerConnections(workspace.id, userId)
    return toRowView(created, connections.get(slug) ?? null)
  })
}

export async function removeConnector(input: {
  workspaceSlug: string
  connectorId: number
}): Promise<WithFailure<{ removed: number }>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    await requireAccess({ userId, workspaceId: workspace.id, verb: 'administer', objectType: 'workspace' })

    const payload = await getPayloadClient()
    const connector = (await payload.findByID({
      collection: 'connectors',
      id: input.connectorId,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })) as Connector | null
    // The workspace check is not redundant with the id: without it, a
    // connector id from another workspace would be deleted by anybody who
    // administers any workspace at all.
    const owning = connector && (typeof connector.workspace === 'number' ? connector.workspace : connector.workspace.id)
    if (!connector || owning !== workspace.id) raise('not_found', 'That connector no longer exists.')

    await payload.delete({ collection: 'connectors', id: connector.id, overrideAccess: true })
    await auditConnectorRemoved({ connector, actorId: userId })
    // Connections are deliberately untouched. Removing Gmail from one project
    // must not revoke a person's Gmail, which they may also be using through a
    // workspace-scoped row two lines above it in the same list.
    revalidateScope(input.workspaceSlug, connector.scopeType as ConnectorScopeType, connector.scopeId ?? null)
    return { removed: connector.id }
  })
}

export async function setConnectorEnabled(input: {
  workspaceSlug: string
  connectorId: number
  enabled: boolean
}): Promise<WithFailure<{ id: number; enabled: boolean }>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    await requireAccess({ userId, workspaceId: workspace.id, verb: 'administer', objectType: 'workspace' })

    const payload = await getPayloadClient()
    const connector = (await payload.findByID({
      collection: 'connectors',
      id: input.connectorId,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })) as Connector | null
    const owning = connector && (typeof connector.workspace === 'number' ? connector.workspace : connector.workspace.id)
    if (!connector || owning !== workspace.id) raise('not_found', 'That connector no longer exists.')

    const updated = (await payload.update({
      collection: 'connectors',
      id: connector.id,
      data: { enabled: input.enabled },
      overrideAccess: true,
    })) as Connector
    await auditConnectorToggled({ connector: updated, actorId: userId, enabled: input.enabled })
    revalidateScope(input.workspaceSlug, connector.scopeType as ConnectorScopeType, connector.scopeId ?? null)
    return { id: updated.id, enabled: updated.enabled !== false }
  })
}
/* ---------------------------------------------------------------- */
/* The viewer's own connection                                       */
/* ---------------------------------------------------------------- */

export interface StartedConnectionView {
  connectionId: number
  redirectUrl: string
  status: Connection['status']
}

/**
 * Begin authorising the signed-in person's own account.
 *
 * THE ROW IS CREATED BEFORE COMPOSIO IS CALLED, and that order is the design.
 * The callback Composio redirects to carries our own `connections` row id and
 * nothing else — no toolkit, no status, no workspace — so that route has
 * exactly one thing to look up and can then verify everything else against
 * Composio and the session. Minting the link first and creating the row after
 * would leave nothing to put in the callback URL, which is how a callback ends
 * up trusting a querystring.
 *
 * A row that never completes is left `pending`, not cleaned up. It is the
 * record that this person started a flow, it is what the poll route watches,
 * and it is what lets a person who lost the tab reopen the same authorisation
 * instead of starting a second one at Composio.
 */
export async function connectToolkit(input: {
  workspaceSlug: string
  toolkitSlug: string
}): Promise<WithFailure<StartedConnectionView>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    const access = await loadAccess(userId, workspace.id)
    // Membership, not `administer`. Authorising your own Gmail is a personal
    // act; requiring workspace administration to do it would mean only admins
    // could ever use a connector an admin attached.
    if (!can(access, 'read', 'workspace')) raise('forbidden', 'You are not a member of this workspace.')

    const slug = input.toolkitSlug.trim().toLowerCase()
    const payload = await getPayloadClient()

    const connector = await payload.find({
      collection: 'connectors',
      where: { and: [{ workspace: { equals: workspace.id } }, { toolkitSlug: { equals: slug } }] },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    if (!connector.docs[0]) {
      raise('not_found', 'That app is not switched on in this workspace. An admin has to add it first.')
    }
    const authConfigId = connector.docs[0].authConfigId || (await findOrCreateAuthConfig(workspace.id, slug))

    // Upsert rather than create: `collections/Connections.ts` is one row per
    // (user, workspace, toolkit), and a person who abandoned a flow and came
    // back must reuse that row rather than accumulate one per attempt.
    const existing = await payload.find({
      collection: 'connections',
      where: {
        and: [
          { workspace: { equals: workspace.id } },
          { user: { equals: userId } },
          { toolkitSlug: { equals: slug } },
        ],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    const pendingRow = existing.docs[0]
      ? ((await payload.update({
          collection: 'connections',
          id: existing.docs[0].id,
          data: { status: 'pending', statusDetail: null, lastCheckedAt: new Date().toISOString() },
          overrideAccess: true,
        })) as Connection)
      : ((await payload.create({
          collection: 'connections',
          data: {
            workspace: workspace.id,
            user: userId,
            toolkitSlug: slug,
            status: 'pending',
            lastCheckedAt: new Date().toISOString(),
          },
          overrideAccess: true,
        })) as Connection)

    const started = await startConnection({
      workspaceId: workspace.id,
      userId,
      authConfigId,
      callbackUrl: callbackUrlFor(pendingRow.id),
    })

    const saved = (await payload.update({
      collection: 'connections',
      id: pendingRow.id,
      data: {
        composioConnectedAccountId: started.connectedAccountId,
        redirectUrl: started.redirectUrl,
      },
      overrideAccess: true,
    })) as Connection

    return { connectionId: saved.id, redirectUrl: started.redirectUrl, status: saved.status }
  })
}

/**
 * Re-read one connection's status from Composio and store what it says.
 *
 * A thin wrapper over `lib/connectors/sync.ts`, which is where the logic lives
 * so the callback ROUTE can use it without it also becoming a server action
 * whose `viewerUserId` argument the browser could choose. Here the id comes
 * from the session and nowhere else.
 */
export async function refreshConnection(input: {
  workspaceSlug: string
  connectionId: number
}): Promise<WithFailure<{ id: number; status: Connection['status']; statusDetail: string | null }>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    // The viewer id comes from the session and is passed down, never accepted
    // as an argument of this action: `syncConnection` refuses a row that is not
    // that person's, and a connection is personal even from a workspace owner.
    const synced = await syncConnection({
      connectionId: input.connectionId,
      viewerUserId: userId,
      workspaceId: workspace.id,
    })
    return { id: synced.id, status: synced.status, statusDetail: synced.statusDetail }
  })
}

/**
 * Re-check every one of the viewer's connections that is still `pending`.
 *
 * What the panel calls on an interval WHILE something is pending, and never
 * otherwise — see `refreshPendingConnections`'s own comment for why that bound
 * is what makes polling defensible here when D0 rejects it in general.
 */
export async function pollPendingConnections(input: {
  workspaceSlug: string
}): Promise<WithFailure<Array<{ id: number; status: Connection['status']; statusDetail: string | null }>>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    const rows = await refreshPendingConnections({ workspaceId: workspace.id, viewerUserId: userId })
    return rows.map((row) => ({ id: row.id, status: row.status, statusDetail: row.statusDetail }))
  })
}

/**
 * Hand the credential back.
 *
 * Composio is told first. If that fails the local row is still marked, and the
 * audit row records `revokedAtProvider: false` — because the two states differ
 * in the only way that matters (in one of them the token still works) and a
 * screen that showed "disconnected" for both would be lying in the dangerous
 * direction.
 */
export async function revokeConnection(input: {
  workspaceSlug: string
  connectionId: number
}): Promise<WithFailure<{ id: number; status: Connection['status']; revokedAtProvider: boolean }>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    const payload = await getPayloadClient()
    const row = (await payload.findByID({
      collection: 'connections',
      id: input.connectionId,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })) as Connection | null
    const owner = row && (typeof row.user === 'number' ? row.user : row.user.id)
    const owning = row && (typeof row.workspace === 'number' ? row.workspace : row.workspace.id)
    // A connection is PERSONAL. Even a workspace owner may not revoke somebody
    // else's, which is the whole reason `collections/Connections.ts` keys the
    // row to a user; the refusal is `not_found` so probing ids cannot tell a
    // connection that is not yours from one that does not exist.
    if (!row || owner !== userId || owning !== workspace.id) {
      raise('not_found', 'That connection no longer exists.')
    }

    let revokedAtProvider = false
    if (row.composioConnectedAccountId) {
      try {
        await disconnectAtComposio(workspace.id, row.composioConnectedAccountId)
        revokedAtProvider = true
      } catch (err) {
        logger.warn('composio disconnect failed; marking locally only', {
          connectionId: row.id,
          reason: err instanceof Error ? err.message : 'unknown',
        })
      }
    }

    const updated = (await payload.update({
      collection: 'connections',
      id: row.id,
      data: {
        status: 'revoked',
        statusDetail: revokedAtProvider
          ? null
          : 'Marked revoked here, but Composio could not be reached — the third-party grant may still be live.',
        redirectUrl: null,
        lastCheckedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })) as Connection

    const connectorId = await connectorIdForToolkit(workspace.id, row.toolkitSlug)
    await auditConnectionRevoked({
      connectorId: connectorId ?? row.toolkitSlug,
      toolkitSlug: row.toolkitSlug,
      actorId: userId,
      revokedAtProvider,
    })
    return { id: updated.id, status: updated.status, revokedAtProvider }
  })
}

/* ---------------------------------------------------------------- */
/* Shared helpers                                                    */
/* ---------------------------------------------------------------- */

function toRowView(connector: Connector, connection: Connection | null): ConnectorRowView {
  return {
    id: connector.id,
    toolkitSlug: connector.toolkitSlug,
    name: connector.name,
    scopeType: connector.scopeType as ConnectorScopeType,
    scopeId: connector.scopeId ?? null,
    enabled: connector.enabled !== false,
    allowedTools: Array.isArray(connector.allowedTools)
      ? connector.allowedTools.filter((slug): slug is string => typeof slug === 'string')
      : [],
    connection: connection
      ? {
          id: connection.id,
          status: connection.status,
          redirectUrl: connection.redirectUrl ?? null,
          statusDetail: connection.statusDetail ?? null,
        }
      : null,
    blockedReason:
      connection?.status === 'active'
        ? null
        : connection?.status === 'pending'
          ? 'connection_pending'
          : connection
            ? 'connection_failed'
            : 'not_connected',
  }
}

/**
 * Where Composio sends the browser back to.
 *
 * Built from `NOTIONFORGE_URL` rather than from the incoming request, because a
 * connection can be started by a run executing on a machine that is not the one
 * rendering the browser — the same reasoning the plugins settings page already
 * applies to the MCP URL it shows.
 *
 * IT CARRIES ONE PARAMETER: our own connection id. Not a toolkit, not a return
 * path, not a status. Anything else in this URL is a value a third party's
 * redirect hands us, and the callback route would then have to decide whether
 * to believe it — the redirect destination is derived from the row instead, so
 * there is no open redirect to get wrong.
 */
function callbackUrlFor(connectionId: number): string {
  const base = (process.env.NOTIONFORGE_URL || 'http://localhost:3000').replace(/\/$/, '')
  const url = new URL(`${base}/api/connectors/callback`)
  url.searchParams.set('connection', String(connectionId))
  return url.toString()
}

/** Repaint whichever surface this scope is shown on. The workspace scope shows
 * on all three, so it revalidates the settings page and lets the detail pages
 * pick it up on their next render rather than guessing project and agent ids
 * that are not in hand. */
function revalidateScope(workspaceSlug: string, scopeType: ConnectorScopeType, scopeId: string | null): void {
  revalidatePath(`/workspace/${workspaceSlug}/settings/connectors`)
  if (scopeType === 'project' && scopeId) revalidatePath(`/workspace/${workspaceSlug}/projects/${scopeId}`)
  if (scopeType === 'agent' && scopeId) revalidatePath(`/workspace/${workspaceSlug}/agents/${scopeId}`)
}

/* ---------------------------------------------------------------- */
/* Coverage: who in this workspace has connected what                */
/* ---------------------------------------------------------------- */

export interface ConnectionCoverageRow {
  toolkitSlug: string
  name: string
  /** People with a live connection, by display name. */
  connected: string[]
  /** People part-way through an authorisation. Separated from `connected`
   * because "nobody has finished" and "nobody has started" call for different
   * nudges. */
  pending: string[]
  /** Members of the workspace with no usable connection to this app at all. */
  missing: number
}

/**
 * Who has authorised which app — EXISTENCE AND STATUS ONLY.
 *
 * `docs/HANDOFF-ENTERPRISE.md` asks Settings → Connectors for exactly this and
 * bounds it in the same breath: "existence and status, never a token, and never
 * the third-party account's own details." So this returns a name and one of
 * three states, and nothing else. Not the email of the Google account, not the
 * Slack workspace, not the connected-account id — none of which an admin needs
 * and all of which would turn a settings screen into a directory of people's
 * personal accounts.
 *
 * WHY IT EXISTS AT ALL, given a connection is personal and `refreshConnection`
 * refuses to let anybody read somebody else's. Because "can this team actually
 * use the Gmail connector I just added, or is it switched on for nobody" is a
 * real administrative question with no other answer, and an admin who cannot
 * ask it will instead ask each person individually — which discloses strictly
 * more. The line drawn is between the FACT of a grant, which the workspace has
 * a legitimate interest in, and anything ABOUT the grant, which it does not.
 *
 * ADMIN ONLY, and `administer` rather than `read`: this is the verb
 * `lib/permissions` reserves for configuration that reaches outside and costs
 * money, which is precisely what a connector is.
 */
export async function getConnectionCoverage(input: {
  workspaceSlug: string
}): Promise<WithFailure<ConnectionCoverageRow[]>> {
  return guard(async () => {
    const { workspace, userId } = await context(input.workspaceSlug)
    await requireAccess({ userId, workspaceId: workspace.id, verb: 'administer', objectType: 'workspace' })

    const payload = await getPayloadClient()
    const [connectors, connections, members] = await Promise.all([
      payload.find({
        collection: 'connectors',
        where: { workspace: { equals: workspace.id } },
        sort: 'name',
        limit: 200,
        depth: 0,
        overrideAccess: true,
      }),
      // `depth: 1` so each row arrives with its user's name. The alternative —
      // collecting ids and issuing a second query — is one more round trip for
      // a list that is bounded by (members × connectors) and small.
      payload.find({
        collection: 'connections',
        where: { workspace: { equals: workspace.id } },
        limit: 1000,
        depth: 1,
        overrideAccess: true,
      }),
      payload.count({
        collection: 'workspace-members',
        where: { workspace: { equals: workspace.id } },
        overrideAccess: true,
      }),
    ])

    // One row per TOOLKIT, not per connector: the same app attached at the
    // workspace and at a project is one authorisation per person, and showing
    // it twice would suggest otherwise.
    const byToolkit = new Map<string, ConnectionCoverageRow>()
    for (const connector of connectors.docs as Connector[]) {
      const slug = connector.toolkitSlug.toLowerCase()
      if (!byToolkit.has(slug)) {
        byToolkit.set(slug, { toolkitSlug: connector.toolkitSlug, name: connector.name, connected: [], pending: [], missing: 0 })
      }
    }

    for (const row of connections.docs as Connection[]) {
      const entry = byToolkit.get(row.toolkitSlug.toLowerCase())
      if (!entry) continue
      const who =
        row.user && typeof row.user !== 'number' ? (row.user.name || row.user.email || 'Someone') : 'Someone'
      if (row.status === 'active') entry.connected.push(who)
      else if (row.status === 'pending') entry.pending.push(who)
    }

    for (const entry of byToolkit.values()) {
      entry.connected = [...new Set(entry.connected)].sort()
      entry.pending = [...new Set(entry.pending)].sort()
      entry.missing = Math.max(0, members.totalDocs - entry.connected.length)
    }

    return [...byToolkit.values()]
  })
}
