import { History } from 'lucide-react'
import { formatTimestamp } from '@/lib/relative-time'
import type { ConnectorAuditRow } from '@/lib/connectors/audit'

/**
 * The recent connector trail, on the screen where somebody is already asking
 * "why is this here".
 *
 * A SERVER COMPONENT, deliberately: it holds no state, has no interaction, and
 * making it a client component would cost hydration for a list that never
 * changes after paint.
 *
 * These same rows appear on the workspace Audit page, mixed in with membership
 * changes and everything else. This is not a second audit log — it is the same
 * table, filtered to the verbs this screen is about, so that answering "who
 * turned Gmail on" does not require leaving the page it was turned on from.
 */
export function ConnectorActivity({ rows }: { rows: ConnectorAuditRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-black/45 dark:text-white/45">
        Nothing has been added, removed or connected here yet.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <li key={row.id} className="flex items-start gap-2 text-xs">
          <History size={12} className="mt-0.5 shrink-0 text-black/30 dark:text-white/30" />
          <span className="min-w-0 flex-1">
            <span className="text-black/70 dark:text-white/70">{sentenceFor(row)}</span>{' '}
            <span className="text-black/35 dark:text-white/35">{formatTimestamp(row.createdAt)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * One line per event, written out rather than shown as `action` plus a JSON
 * blob.
 *
 * The verb is a stable machine string (`lib/connectors/audit.ts` keeps it that
 * way on purpose) and this is the only place it is turned into English, so the
 * two cannot drift. An unrecognised verb falls back to the raw string rather
 * than to nothing: a row nobody wrote a sentence for is still evidence.
 */
function sentenceFor(row: ConnectorAuditRow): string {
  const who = row.actorName ?? 'Someone'
  const app = typeof row.details.name === 'string' ? row.details.name : typeof row.details.toolkitSlug === 'string' ? row.details.toolkitSlug : 'an app'
  const scope =
    typeof row.details.scopeType === 'string' && row.details.scopeType !== 'workspace'
      ? ` at ${row.details.scopeType} scope`
      : ''

  switch (row.action) {
    case 'connector_added':
      return `${who} made ${app} available${scope}.`
    case 'connector_removed':
      return `${who} removed ${app}${scope}.`
    case 'connector_enabled':
      return `${who} enabled ${app}.`
    case 'connector_disabled':
      return `${who} disabled ${app}.`
    case 'connection_connected':
      return `${who} connected their own ${app} account.`
    case 'connection_revoked':
      // The distinction matters more than it looks: in one of these two states
      // the third-party token is still live.
      return row.details.revokedAtProvider === false
        ? `${who} disconnected ${app} here, but Composio could not be reached — the grant may still be live.`
        : `${who} disconnected their ${app} account.`
    case 'composio_key_set':
      return `${who} set this workspace’s Composio API key.`
    case 'composio_key_cleared':
      return `${who} removed this workspace’s Composio API key.`
    default:
      return `${who}: ${row.action}`
  }
}
