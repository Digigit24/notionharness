'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquare } from 'lucide-react'
import type { SessionListItem } from '@/lib/broker'
import { formatRelativeTime } from '@/lib/relative-time'
import { unwrap } from '@/lib/failures'
import { BAND_ORDER, bandFor } from '@/components/work/session-rail'
import { listChannelHistorySessionsAction } from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'

/**
 * R14-P0.3 — History as a tab, not a route.
 *
 * Deliberately NOT `SessionRail`: that component is a 256px sidebar built to
 * sit beside a conversation, with rename/pin/archive/delete controls that
 * belong to Work's own session management, not to a read-only view of what a
 * channel's roster has been doing. This tab occupies the SAME full-width main
 * pane Messages does, so it needs full-width rows, not a narrow rail — but it
 * reuses the rail's exact recency grouping (`bandFor`/`BAND_ORDER`) rather
 * than inventing a second scheme for the same judgment.
 *
 * Opening a row goes to the run-detail sheet (P0.5), never to `/work` — this
 * tab's whole point is that history stays inside the channel.
 */
export function ChannelHistoryTab({
  workspaceId,
  teamId,
  onOpenRun,
}: {
  workspaceId: number
  teamId: number
  onOpenRun: (runId: number) => void
}) {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fetched on mount rather than carried down from the room's own initial
  // props: History is the one tab nobody opens on a typical visit, so paying
  // for this query on every channel load (D0) would tax the common case for
  // the sake of the rare one. Loading once when the tab is first shown is the
  // same trade the canvas pane already makes for its own document fetch.
  useEffect(() => {
    let cancelled = false
    setError(null)
    listChannelHistorySessionsAction({ workspaceId, teamId })
      .then((result) => {
        if (!cancelled) setSessions(unwrap(result))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load history.')
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, teamId])

  const grouped = useMemo(() => {
    if (!sessions) return []
    const now = Date.now()
    const map = new Map<string, SessionListItem[]>()
    for (const session of sessions) {
      const band = bandFor(session, now)
      const list = map.get(band)
      if (list) list.push(session)
      else map.set(band, [session])
    }
    return BAND_ORDER.filter((band) => map.has(band)).map((band) => ({ band, items: map.get(band)! }))
  }, [sessions])

  if (error) {
    return <p className="px-4 py-6 text-xs text-red-600 dark:text-red-400">{error}</p>
  }

  if (sessions == null) {
    return (
      <p className="flex items-center justify-center gap-2 py-10 text-xs text-black/40 dark:text-white/40">
        <Loader2 size={13} className="animate-spin" />
        Loading history…
      </p>
    )
  }

  if (sessions.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-xs text-black/40 dark:text-white/40">
        No conversations yet. History fills in once a member of this channel&apos;s roster talks to their agent.
      </p>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {grouped.map(({ band, items }) => (
        <section key={band} className="mb-3">
          <h3 className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wide text-black/35 dark:text-white/35">
            {band}
          </h3>
          <ul className="space-y-0.5">
            {items.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  disabled={session.latestRunId == null}
                  onClick={() => {
                    if (session.latestRunId != null) onOpenRun(session.latestRunId)
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-black/[.03] disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/[.05]"
                >
                  {session.isRunning ? (
                    <span
                      aria-label="Answering"
                      className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
                    />
                  ) : (
                    <MessageSquare size={12} className="shrink-0 text-black/30 dark:text-white/30" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{session.title || 'Untitled chat'}</span>
                      <span className="shrink-0 text-[11px] text-black/40 dark:text-white/40">
                        {session.agentName ?? 'Unknown agent'}
                      </span>
                    </span>
                    {session.preview && (
                      <span className="mt-0.5 block truncate text-xs text-black/50 dark:text-white/50">
                        {session.preview}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11px] text-black/40 dark:text-white/40">
                    {formatRelativeTime(session.lastActivityAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
