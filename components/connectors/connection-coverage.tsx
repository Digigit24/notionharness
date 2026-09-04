import { Badge } from '@/components/ui/badge'
import type { ConnectionCoverageRow } from '@/app/(app)/workspace/[workspaceSlug]/settings/connectors/actions'

/**
 * Who in this workspace has authorised which app.
 *
 * EXISTENCE AND STATUS, NOTHING ELSE — the bound `docs/HANDOFF-ENTERPRISE.md`
 * puts on this screen, and the reason the action behind it returns a name and
 * one of three states rather than a connection row. There is no email of the
 * Google account here, no Slack workspace, no connected-account id: an admin
 * needs to know whether the connector they switched on is usable by anybody,
 * not whose mailbox it reaches.
 *
 * THE THREE COLUMNS ARE THREE DIFFERENT ACTIONS. "Nobody has connected this"
 * means the connector is decorative and somebody should be asked to authorise
 * it. "Two people are part-way through" means wait. "Four members have not"
 * means it works for some runs and not others, which is the state that produces
 * a confusing bug report six weeks later. A single "3/7" figure would collapse
 * all three into a number nobody can act on.
 *
 * A server component: no state, no interaction, and it must not cost hydration.
 */
export function ConnectionCoverage({ rows }: { rows: ConnectionCoverageRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-black/45 dark:text-white/45">
        No apps are switched on yet, so there is nothing for anyone to connect.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.toolkitSlug} className="flex items-start gap-3 text-xs">
          <span className="w-28 shrink-0 truncate font-medium">{row.name}</span>
          <span className="min-w-0 flex-1">
            {row.connected.length === 0 && row.pending.length === 0 ? (
              // Said as a sentence rather than as an empty cell: a blank space
              // reads as "loading" or "not applicable", and this is neither.
              <span className="text-amber-700 dark:text-amber-400">
                Nobody has connected this yet, so no agent can use it.
              </span>
            ) : (
              <>
                {row.connected.length > 0 && (
                  <span className="text-black/70 dark:text-white/70">{row.connected.join(', ')}</span>
                )}
                {row.pending.length > 0 && (
                  <span className="text-black/45 dark:text-white/45">
                    {row.connected.length > 0 ? ' · ' : ''}
                    {row.pending.join(', ')} still authorising
                  </span>
                )}
              </>
            )}
          </span>
          <span className="shrink-0">
            {row.missing > 0 ? (
              <Badge variant="outline">{row.missing} not connected</Badge>
            ) : (
              <Badge variant="secondary">everyone</Badge>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
