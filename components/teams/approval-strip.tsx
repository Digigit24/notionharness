'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ExternalLink, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChannelApproval } from '@/lib/broker/channels'

/**
 * A blocked agent, shown ON THE CHANNEL.
 *
 * The bug this fixes: an agent woken by a mention would hit a permission
 * request mid-turn and go quiet. The dispatcher posted "waiting for approval"
 * INTO THE THREAD, so on the channel it was a bumped reply count and nothing
 * else — you had to open the thread, or find the request in the Inbox, to
 * learn that anything was waiting on you at all. The block is the one thing in
 * a channel that is waiting on a person; it belongs where the person is.
 *
 * Design notes, each of which is the reason for a line below:
 *
 *  - **Everyone sees it, one person decides.** Hiding the strip from other
 *    members would leave them watching an agent that has apparently stalled.
 *    They see the block and who is holding it; only `requestedUserId` gets
 *    buttons. The server enforces that independently — rendering a button
 *    grants nothing.
 *  - **Decided locally, not re-fetched.** The POST returning 200 IS the
 *    decision; the strip settles on that response and the row disappears when
 *    the next poll stops returning it. No extra round trip (D0).
 *  - **Same endpoint as the transcript card.** `/api/approvals` keyed by ACP
 *    `externalId`, exactly as `components/thread/PermissionCard.tsx` does, so
 *    approving here and approving there are one operation that cannot drift.
 */
function isAllow(option: { kind: string }) {
  return option.kind === 'allow_once' || option.kind === 'allow_always'
}

function labelFor(option: { optionId: string; kind: string; label?: string }) {
  if (option.label) return option.label
  switch (option.kind) {
    case 'allow_once':
      return 'Allow once'
    case 'allow_always':
      return 'Always allow'
    case 'reject_once':
      return 'Deny'
    case 'reject_always':
      return 'Always deny'
    default:
      return option.optionId || 'Choose'
  }
}

/** Allow and deny are what `/api/approvals` accepts regardless, so a request
 * that arrived without options is still answerable. An unanswerable block
 * would be worse than a pair of generic labels. */
const FALLBACK_OPTIONS = [
  { optionId: 'allow', kind: 'allow_once' },
  { optionId: 'reject', kind: 'reject_once' },
]

export function ApprovalStrip({
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
  /** Who has to decide, shown to everyone else instead of dead buttons. */
  holderName: string | null
  workspaceSlug: string
  /** Lets the room drop the row the instant the server accepts, rather than
   * leaving a decided request on screen until the next poll. */
  onSettled: (externalId: string) => void
}) {
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState<'approved' | 'denied' | null>(null)

  async function decide(option: { optionId: string; kind: string; label?: string }) {
    if (submitting || settled) return
    setSubmitting(option.optionId)
    setError(null)
    try {
      const res = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          externalId: approval.externalId,
          decision: isAllow(option) ? 'approved' : 'denied',
          selectedOptionId: option.optionId,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      setSettled(isAllow(option) ? 'approved' : 'denied')
      onSettled(approval.externalId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the decision.')
    } finally {
      setSubmitting(null)
    }
  }

  const options = approval.options.length > 0 ? approval.options : FALLBACK_OPTIONS

  return (
    <div
      className={cn(
        'mt-1 rounded-md border px-2.5 py-1.5 text-xs',
        settled ? 'border-black/10 dark:border-white/10' : 'border-amber-500/45 bg-amber-500/[.07]',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {settled === 'approved' ? (
          <ShieldCheck size={13} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : settled === 'denied' ? (
          <ShieldX size={13} className="shrink-0 text-black/40 dark:text-white/40" />
        ) : (
          <ShieldAlert size={13} className="shrink-0 text-amber-600 dark:text-amber-400" />
        )}
        <span className="font-medium">{slotName ? `${slotName} is blocked` : 'A member is blocked'}</span>
        <span
          className="min-w-0 flex-1 truncate text-black/60 dark:text-white/60"
          title={approval.detail ?? undefined}
        >
          {approval.title}
        </span>

        {settled ? (
          <span className="text-black/50 dark:text-white/50">
            {settled === 'approved' ? 'Approved — carrying on.' : 'Denied.'}
          </span>
        ) : canDecide ? (
          <span className="flex shrink-0 items-center gap-1">
            {options.map((option) => (
              <button
                key={option.optionId}
                type="button"
                disabled={submitting != null}
                onClick={() => decide(option)}
                className={cn(
                  'rounded border px-1.5 py-0.5 disabled:opacity-50',
                  isAllow(option)
                    ? 'border-emerald-600/40 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300'
                    : 'border-black/15 text-black/60 hover:bg-black/[.05] dark:border-white/20 dark:text-white/60 dark:hover:bg-white/[.08]',
                )}
              >
                {submitting === option.optionId ? '…' : labelFor(option)}
              </button>
            ))}
          </span>
        ) : (
          <span className="shrink-0 text-black/50 dark:text-white/50">
            {holderName ? `Waiting on ${holderName}` : 'Waiting on someone else'}
          </span>
        )}

        {approval.sessionId != null && (
          <Link
            href={`/workspace/${workspaceSlug}/work?session=${approval.sessionId}`}
            title="Open the run that is blocked — the tool call, its arguments, and everything before it."
            className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-black/45 hover:bg-black/[.05] hover:text-black/70 dark:text-white/45 dark:hover:bg-white/[.08] dark:hover:text-white/70"
          >
            <ExternalLink size={11} />
            Run
          </Link>
        )}
      </div>

      {approval.detail && !settled && (
        <p className="mt-0.5 truncate text-[11px] text-black/50 dark:text-white/50">{approval.detail}</p>
      )}
      {error && <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
