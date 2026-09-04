import 'server-only'

import { getPayloadClient } from '@/lib/payload'
import { raise } from '@/lib/failures'
import { composioUserId, getConnection } from '@/lib/connectors/composio'
import { auditConnectionConnected } from '@/lib/connectors/audit'
import type { Connection } from '@/payload-types'

/**
 * "Ask Composio what this connection's status really is, and store the answer"
 * — in one place, because three callers need it and they must not be able to
 * reach three different conclusions about the same row.
 *
 * The three are: the callback a third party redirects a browser to
 * (`/api/connectors/callback`), the poll the panel runs while a flow is open
 * (`/api/connectors/status`), and the "check again" action on the Connectors
 * screen. A browser returning from Google and a poll two seconds apart
 * disagreeing is not hypothetical — it is what happens the first time two of
 * these grow their own copy of the status mapping.
 *
 * IT LIVES HERE RATHER THAN IN `actions.ts` for a specific reason: a route
 * handler needs it, and a `'use server'` function taking a `viewerUserId`
 * would be one the browser could choose. Here that argument is always supplied
 * by code that has already resolved the session.
 *
 * NOTHING TRUSTS ITS CALLER FOR THE STATUS. The only input that decides
 * anything is Composio's own answer, and even that is checked against the
 * entity id derived from the row's OWN user before it is believed — a
 * connected account id is an opaque handle, not a secret, and one that comes
 * back attached to a different entity is evidence of a mistake or an attempt,
 * never of a connection.
 *
 * IT IS IDEMPOTENT, because a person will refresh the callback URL. Every
 * write is the same upsert of a freshly-read status, and the audit row is
 * written only on the TRANSITION into `active` — so a poll ticking every few
 * seconds does not fill the one table an incident is read from with "connected
 * Gmail" over and over.
 */

export interface SyncResult {
  id: number
  status: Connection['status']
  statusDetail: string | null
  /** True when this call is what moved the row, so a caller can decide whether
   * to repaint without diffing statuses itself. */
  changed: boolean
}

/**
 * Two ways in, because the two callers genuinely differ.
 *
 * The callback route has already loaded the row (it needs the workspace's slug
 * for its redirect) and has already checked that it belongs to the signed-in
 * person, so it passes the row and does not pay for a second read. A server
 * action has only an id off the wire and must not be trusted with anything
 * more, so it passes the id and the session's user and lets this function do
 * the ownership check. Both paths end in the same body; neither can skip it.
 */
export type SyncConnectionInput = { workspaceId: number } & (
  | { connection: Connection; connectionId?: never; viewerUserId?: never }
  | { connectionId: number; viewerUserId: number; connection?: never }
)

export async function syncConnection(input: SyncConnectionInput): Promise<SyncResult> {
  const payload = await getPayloadClient()

  const row =
    input.connection ??
    ((await payload.findByID({
      collection: 'connections',
      id: input.connectionId,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })) as Connection | null)

  const ownerId = row && (typeof row.user === 'number' ? row.user : row.user.id)
  const owningWorkspace = row && (typeof row.workspace === 'number' ? row.workspace : row.workspace.id)

  // A connection is PERSONAL — that is the whole reason
  // `collections/Connections.ts` keys the row to a user rather than to a
  // workspace. Even an owner may not read or refresh a colleague's, and
  // `not_found` rather than `forbidden` keeps the two cases from being told
  // apart by probing ids.
  if (!row || owningWorkspace !== input.workspaceId) {
    raise('not_found', 'That connection no longer exists.')
  }
  if (input.viewerUserId !== undefined && ownerId !== input.viewerUserId) {
    raise('not_found', 'That connection no longer exists.')
  }
  if (!row.composioConnectedAccountId) {
    raise('invalid_input', 'That authorisation was never started. Press Connect to begin it.')
  }

  const snapshot = await getConnection(input.workspaceId, row.composioConnectedAccountId)

  if (snapshot.composioUserId && ownerId != null && snapshot.composioUserId !== composioUserId(ownerId)) {
    // Not a silent skip: a mismatch means one person's connected account is
    // about to be written onto another's row, and the only safe outcome is to
    // refuse loudly and change nothing.
    raise('forbidden', 'That authorisation belongs to a different account and was not applied.')
  }

  const updated = (await payload.update({
    collection: 'connections',
    id: row.id,
    data: {
      status: snapshot.status,
      statusDetail: snapshot.statusReason,
      lastCheckedAt: new Date().toISOString(),
      // The link is spent once the account is live. Keeping it would leave a
      // Connect button that reopens a completed consent screen, and an
      // authorisation URL that still works afterwards is one somebody can be
      // walked into clicking again.
      ...(snapshot.status === 'active' ? { redirectUrl: null } : {}),
    },
    overrideAccess: true,
  })) as Connection

  const changed = row.status !== updated.status
  if (changed && updated.status === 'active' && ownerId != null) {
    await auditConnectionConnected({
      connectorId: (await connectorIdForToolkit(input.workspaceId, row.toolkitSlug)) ?? row.toolkitSlug,
      toolkitSlug: row.toolkitSlug,
      // The connection's OWNER, not whoever triggered the sync. A poll has no
      // actor, and attributing "connected Gmail" to a background tick would
      // make the row useless to the incident that reads it.
      actorId: ownerId,
      composioConnectedAccountId: row.composioConnectedAccountId,
    })
  }

  return { id: updated.id, status: updated.status, statusDetail: updated.statusDetail ?? null, changed }
}

/**
 * The connector row an audit event should hang off, given only a toolkit.
 *
 * Lowest id rather than newest, so repeated events about one app keep landing
 * on the same entity id — a trail that scatters across ids as rows are added
 * and removed is one that cannot be read as a history.
 *
 * Null when none exists: somebody can finish an authorisation seconds after an
 * admin removed the connector, and the audit row is still worth writing.
 */
export async function connectorIdForToolkit(workspaceId: number, toolkitSlug: string): Promise<number | null> {
  const payload = await getPayloadClient()
  const found = await payload.find({
    collection: 'connectors',
    where: { and: [{ workspace: { equals: workspaceId } }, { toolkitSlug: { equals: toolkitSlug } }] },
    sort: 'id',
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return found.docs[0]?.id ?? null
}

/**
 * Reconcile every one of this person's connections that is still `pending`.
 *
 * One request rather than one per row, because somebody who pressed Connect on
 * three apps in a row has three open flows and should not cost three round
 * trips per tick against a rate limit shared by the whole Composio
 * organisation.
 *
 * FAILURES ARE SWALLOWED PER ROW. One unreachable toolkit must not stop the
 * other two from resolving; the row that failed simply stays pending, which is
 * what it already said.
 */
export async function refreshPendingConnections(input: {
  workspaceId: number
  viewerUserId: number
}): Promise<SyncResult[]> {
  const payload = await getPayloadClient()
  const pending = await payload.find({
    collection: 'connections',
    where: {
      and: [
        { workspace: { equals: input.workspaceId } },
        { user: { equals: input.viewerUserId } },
        { status: { equals: 'pending' } },
      ],
    },
    limit: 25,
    depth: 0,
    overrideAccess: true,
  })

  const results: SyncResult[] = []
  for (const row of pending.docs as Connection[]) {
    try {
      results.push(await syncConnection({ workspaceId: input.workspaceId, connection: row }))
    } catch {
      // Intentional and per-row, for the reason stated above.
    }
  }
  return results
}
