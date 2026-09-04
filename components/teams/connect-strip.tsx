'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Plug, PlugZap } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChannelApproval } from '@/lib/broker/channels'

/**
 * A run parked on `connect_app`, shown ON THE CHANNEL.
 *
 * Deliberately the same row as `approval-strip.tsx`: same border, same amber
 * treatment, same "X is blocked" opening, same run link, same everything a
 * member scanning the feed uses to tell that something is waiting. The three
 * design notes that file records apply here unchanged and for the same
 * reasons —
 *
 *  - **Everyone sees it, one person acts.** Hiding it would leave the rest of
 *    the room watching an agent that has apparently stalled. Only
 *    `requestedUserId` gets controls; the server enforces that independently,
 *    so rendering a button grants nothing.
 *  - **Settled locally, not re-fetched.** The response IS the decision.
 *  - **Same endpoint as the transcript card**, so acting here and acting there
 *    are one operation that cannot drift.
 *
 * What differs is the one thing that has to: the primary control is a LINK to
 * the authorisation flow rather than a decision. It points at
 * `/api/approvals/connect`, which is the only place the personal auth URL is
 * ever read — this component is rendered to the whole channel, so a URL in its
 * props would be a personal OAuth link handed to everybody in the room.
 */
export function ConnectStrip({
  approval,
  slotName,
  canDecide,
  holderName,
  workspaceSlug,
  onSettled,
}: {
  approval: ChannelApproval
  /** The member that is blocked, when the slot is still on the roster. */
  slotName: string | null
  /** True only for the person the request was raised against. */
  canDecide: boolean
  /** Who has to act, shown to everyone else instead of dead buttons. */
  holderName: string | null
  workspaceSlug: string
  /** Lets the room drop the row the instant the server accepts, rather than
   * leaving a settled request on screen until the next poll. */
  onSettled: (externalId: string) => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState<'connected' | 'skipped' | null>(null)
  const [opened, setOpened] = useState(false)

  async function skip() {
    if (submitting || settled) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ externalId: approval.externalId, decision: 'denied', selectedOptionId: 'skip' }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      setSettled('skipped')
      onSettled(approval.externalId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className={cn(
        'mt-1 rounded-md border px-2.5 py-1.5 text-xs',
        settled ? 'border-black/10 dark:border-white/10' : 'border-amber-500/45 bg-amber-500/[.07]',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {settled === 'connected' ? (
          <PlugZap size={13} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : settled === 'skipped' ? (
          <Plug size={13} className="shrink-0 text-black/40 dark:text-white/40" />
        ) : (
          <Plug size={13} className="shrink-0 text-amber-600 dark:text-amber-400" />
        )}
        <span className="font-medium">{slotName ? `${slotName} needs an app` : 'A member needs an app'}</span>
        <span
          className="min-w-0 flex-1 truncate text-black/60 dark:text-white/60"
          title={approval.detail ?? undefined}
        >
          {approval.title}
        </span>

        {settled ? (
          <span className="text-black/50 dark:text-white/50">
            {settled === 'connected' ? 'Connected — carrying on.' : 'Skipped.'}
          </span>
        ) : canDecide ? (
          <span className="flex shrink-0 items-center gap-1">
            <a
              href={`/api/approvals/connect?request=${encodeURIComponent(approval.externalId)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpened(true)}
              className="inline-flex items-center gap-1 rounded border border-emerald-600/40 px-1.5 py-0.5 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
            >
              <ExternalLink size={11} />
              {opened ? 'Open again' : 'Connect'}
            </a>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void skip()}
              className="rounded border border-black/15 px-1.5 py-0.5 text-black/60 hover:bg-black/[.05] disabled:opacity-50 dark:border-white/20 dark:text-white/60 dark:hover:bg-white/[.08]"
            >
              {submitting ? '…' : 'Skip'}
            </button>
          </span>
        ) : (
          <span className="shrink-0 text-black/50 dark:text-white/50">
            {holderName ? `Waiting on ${holderName}` : 'Waiting on someone else'}
          </span>
        )}

        {approval.sessionId != null && (
          <Link
            href={`/workspace/${workspaceSlug}/work?session=${approval.sessionId}`}
            title="Open the run that is waiting — what it was doing, and everything before it."
            className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-black/45 hover:bg-black/[.05] hover:text-black/70 dark:text-white/45 dark:hover:bg-white/[.08] dark:hover:text-white/70"
          >
            <ExternalLink size={11} />
            Run
          </Link>
        )}
      </div>

      {/* The row disappears by itself when the callback settles the request —
          the channel's own approvals poll stops returning it. This says so, so
          that nobody stands on the channel waiting to be told to press
          something. */}
      {opened && !settled && (
        <p className="mt-0.5 text-[11px] text-black/50 dark:text-white/50">
          Finish signing in — this row clears on its own.
        </p>
      )}
      {error && <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
