import 'server-only'

import { recordActivity } from '@/lib/activity'
import { bestEffort } from '@/lib/failures'
import { getPayloadClient } from '@/lib/payload'
import type { Connector } from '@/payload-types'

/**
 * The four connector events, written into the one activity table.
 *
 * WHY NOT A `connector_events` TABLE. `collections/Activity.ts` exists so that
 * "every entity has a timeline" costs a row rather than a schema change, and
 * the workspace audit view at `/workspace/[slug]/audit` reads exactly that
 * table. A second table would mean that view had to read two sources and
 * interleave them by timestamp to stay honest — and the moment it did not, a
 * connector grant would be the one privileged change in the product that never
 * appeared in the audit log.
 *
 * WHY `entityId` IS ALWAYS THE CONNECTOR'S ID, EVEN FOR THE TWO CONNECTION
 * EVENTS. The question an auditor asks is about the app: "who connected Gmail
 * in this workspace, and when did it stop". A `connections` row id answers
 * nothing on its own — it is per person and per workspace and cannot be looked
 * up from any screen. Keying all four to the connector makes one connector's
 * whole history a single filtered read. The person is already on the row, in
 * `actor`.
 *
 * BEST-EFFORT THROUGHOUT. An audit write must never fail the change it records
 * — a person who successfully connected Gmail being told the operation failed
 * would then try again and end up with two connected accounts. `bestEffort`
 * says that out loud rather than leaving a bare catch that looks like an
 * oversight.
 */

export type ConnectorAuditAction =
  | 'connector_added'
  | 'connector_removed'
  | 'connector_enabled'
  | 'connector_disabled'
  | 'connection_connected'
  | 'connection_revoked'

async function write(input: {
  action: ConnectorAuditAction
  connectorId: number | string
  actorId: number | null
  details: Record<string, unknown>
}): Promise<void> {
  await bestEffort(
    async () => {
      const payload = await getPayloadClient()
      await recordActivity({
        payload,
        entityType: 'connector',
        entityId: String(input.connectorId),
        actor: input.actorId,
        action: input.action,
        details: input.details,
      })
    },
    'an audit row must never fail the connector change it records',
    { action: input.action, connectorId: String(input.connectorId) },
  )
}

/** A workspace admin switched an app on at some scope. `scope` is recorded
 * because the same toolkit at workspace scope and at agent scope are different
 * grants with very different blast radii. */
export function auditConnectorAdded(input: { connector: Connector; actorId: number | null }): Promise<void> {
  return write({
    action: 'connector_added',
    connectorId: input.connector.id,
    actorId: input.actorId,
    details: {
      toolkitSlug: input.connector.toolkitSlug,
      name: input.connector.name,
      scopeType: input.connector.scopeType,
      scopeId: input.connector.scopeId ?? null,
    },
  })
}

/**
 * A connector row was deleted.
 *
 * The toolkit and scope are copied into the activity payload rather than left
 * as a reference, because the row this points at no longer exists — an audit
 * entry that can only say "connector 41 was removed" is an audit entry that
 * has lost the only fact anybody wanted from it.
 */
export function auditConnectorRemoved(input: { connector: Connector; actorId: number | null }): Promise<void> {
  return write({
    action: 'connector_removed',
    connectorId: input.connector.id,
    actorId: input.actorId,
    details: {
      toolkitSlug: input.connector.toolkitSlug,
      name: input.connector.name,
      scopeType: input.connector.scopeType,
      scopeId: input.connector.scopeId ?? null,
    },
  })
}

export function auditConnectorToggled(input: {
  connector: Connector
  actorId: number | null
  enabled: boolean
}): Promise<void> {
  return write({
    action: input.enabled ? 'connector_enabled' : 'connector_disabled',
    connectorId: input.connector.id,
    actorId: input.actorId,
    details: { toolkitSlug: input.connector.toolkitSlug, name: input.connector.name },
  })
}

/**
 * One person's account went live.
 *
 * `connectorId` is nullable at the call site because a connection can be
 * completed from a screen where no single connector row is in view (a toolkit
 * connected at two scopes has two rows, and the callback route knows only the
 * toolkit). The toolkit slug is then the identifier, and it is recorded on
 * every one of these events for exactly that reason.
 */
export function auditConnectionConnected(input: {
  connectorId: number | string
  toolkitSlug: string
  actorId: number | null
  composioConnectedAccountId: string | null
}): Promise<void> {
  return write({
    action: 'connection_connected',
    connectorId: input.connectorId,
    actorId: input.actorId,
    details: {
      toolkitSlug: input.toolkitSlug,
      // The id of the account AT COMPOSIO. Not a credential — it is an opaque
      // handle that is useless without the workspace's API key — and it is the
      // only string that lets an incident correlate our record with theirs.
      composioConnectedAccountId: input.composioConnectedAccountId,
    },
  })
}

export function auditConnectionRevoked(input: {
  connectorId: number | string
  toolkitSlug: string
  actorId: number | null
  /** Whether the credential was actually revoked at Composio, or only marked
   * here. They come apart when Composio is unreachable, and an audit row that
   * cannot tell them apart is worse than none: one of the two states means the
   * token still works. */
  revokedAtProvider: boolean
}): Promise<void> {
  return write({
    action: 'connection_revoked',
    connectorId: input.connectorId,
    actorId: input.actorId,
    details: { toolkitSlug: input.toolkitSlug, revokedAtProvider: input.revokedAtProvider },
  })
}

/**
 * The workspace's Composio key was replaced or cleared.
 *
 * THE ONE EVENT HERE THAT IS NOT ABOUT A CONNECTOR, and it is filed under the
 * `workspace` entity type for that reason rather than being wedged onto an
 * arbitrary connector id. Changing the key changes what EVERY connector in the
 * workspace can do — clearing it takes every one of them out of scope at once
 * — so a reader looking at one connector's history would be misled by finding
 * it there, and a reader looking at the workspace's history would be misled by
 * not finding it at all. `workspace` was added to `ACTIVITY_ENTITY_TYPES` by
 * the people-management unit for exactly this class of configuration change.
 *
 * THE VALUE IS NEVER RECORDED. Its LENGTH is, because that is the one fact
 * that distinguishes a truncated paste from a good key when somebody is
 * working out why every connector started failing at 14:02, and it is useless
 * to anybody who reads the log.
 */
export function auditComposioKeyChanged(input: {
  workspaceId: number
  actorId: number | null
  /** Zero when the key was cleared. */
  keyLength: number
}): Promise<void> {
  return bestEffort(
    async () => {
      const payload = await getPayloadClient()
      await recordActivity({
        payload,
        entityType: 'workspace',
        entityId: String(input.workspaceId),
        actor: input.actorId,
        action: input.keyLength > 0 ? 'composio_key_set' : 'composio_key_cleared',
        details: { keyLength: input.keyLength || undefined },
      })
    },
    'an audit row must never fail the key change it records',
    { workspaceId: input.workspaceId },
  ).then(() => undefined)
}

/** Every verb this module writes, so a reader can filter for them in one
 * clause rather than listing them again at each call site. */
export const CONNECTOR_AUDIT_ACTIONS = [
  'connector_added',
  'connector_removed',
  'connector_enabled',
  'connector_disabled',
  'connection_connected',
  'connection_revoked',
  'composio_key_set',
  'composio_key_cleared',
] as const

export interface ConnectorAuditRow {
  id: number
  action: string
  actorName: string | null
  details: Record<string, unknown>
  createdAt: string
}

/**
 * The recent trail for one workspace, for the Connectors screen.
 *
 * The workspace Audit page shows these mixed in with membership changes and
 * everything else; this is the narrow view, on the screen where somebody is
 * already asking "why is this connector here".
 *
 * SCOPED THROUGH THE OWNING ROWS, NOT THROUGH THE JSON PAYLOAD. `activity` has
 * no workspace column, so the only indexed columns available are `entity_type`
 * and `entity_id` — the same constraint the workspace Audit page works around
 * the same way. Filtering on a `payload.workspaceId` path instead would be an
 * unindexed scan of every activity row in the database, and would silently
 * return nothing at all if Payload's JSON path querying does not translate the
 * way one hopes on this adapter.
 *
 * The empty-list guard is not defensive habit: `entityId: { in: [] }` is
 * treated as NO CONSTRAINT rather than as an empty set, which is precisely how
 * one workspace's rows leaked into another's on the audit page.
 */
export async function listConnectorAudit(workspaceId: number, limit = 20): Promise<ConnectorAuditRow[]> {
  const payload = await getPayloadClient()
  const connectors = await payload.find({
    collection: 'connectors',
    where: { workspace: { equals: workspaceId } },
    limit: 500,
    depth: 0,
    overrideAccess: true,
  })
  const connectorIds = connectors.docs.map((doc) => String(doc.id))

  const result = await payload.find({
    collection: 'activity',
    where: {
      and: [
        { action: { in: [...CONNECTOR_AUDIT_ACTIONS] } },
        {
          or: [
            ...(connectorIds.length > 0
              ? [{ and: [{ entityType: { equals: 'connector' } }, { entityId: { in: connectorIds } }] }]
              : []),
            { and: [{ entityType: { equals: 'workspace' } }, { entityId: { equals: String(workspaceId) } }] },
          ],
        },
      ],
    },
    sort: '-createdAt',
    limit,
    depth: 1,
    overrideAccess: true,
  })

  return result.docs.map((doc) => ({
    id: doc.id,
    action: doc.action,
    actorName: doc.actor && typeof doc.actor !== 'number' ? (doc.actor.name ?? doc.actor.email ?? null) : null,
    details: (doc.payload as Record<string, unknown> | null) ?? {},
    createdAt: doc.createdAt,
  }))
}
