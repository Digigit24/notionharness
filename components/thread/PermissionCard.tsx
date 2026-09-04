'use client'

import { useState } from 'react'
import { Check, ShieldAlert, ShieldCheck, ShieldX, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PermissionOption } from '@/lib/run-events'

/**
 * The in-transcript approval control for a `session/request_permission` the
 * agent raised mid-turn.
 *
 * Why this is inline rather than only in the Inbox: the dispatcher's approval
 * plumbing (createPendingApproval → waitForApproval → resolveApproval) was
 * already complete and correct, but nothing ever put the request in front of
 * the person watching the run. With `permissionMode: 'ask'` — the seeded
 * default — the turn simply stalled for five minutes and then reported a
 * timeout, unless the user happened to leave the conversation and find the
 * request in the Inbox. The blocking step belongs where the block is visible.
 *
 * The decision is POSTed by ACP request id (`externalId`), because the
 * `approvals` row is created by the dispatcher after this card has already
 * streamed to the browser — see app/api/approvals/route.ts. Authorization
 * still happens server-side against the row's own `requestedUser`.
 */
export interface PermissionCardProps {
  requestId: string
  title: string
  detail: string
  options: PermissionOption[]
  outcome?: 'selected' | 'cancelled'
  selectedOptionId?: string
  reason?: string
}

function isAllow(option: PermissionOption) {
  return option.kind === 'allow_once' || option.kind === 'allow_always'
}

function labelFor(option: PermissionOption) {
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

export function PermissionCard({
  requestId,
  title,
  detail,
  options,
  outcome,
  selectedOptionId,
  reason,
}: PermissionCardProps) {
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set the instant the server accepts the decision, so the card stops
  // offering buttons without waiting for the settled event to make the round
  // trip back through the stream.
  const [localChoice, setLocalChoice] = useState<string | null>(null)

  const settled = outcome != null || localChoice != null

  async function decide(option: PermissionOption) {
    if (submitting || settled) return
    setSubmitting(option.optionId)
    setError(null)
    try {
      const res = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          externalId: requestId,
          decision: isAllow(option) ? 'approved' : 'denied',
          selectedOptionId: option.optionId,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      setLocalChoice(option.optionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the decision.')
    } finally {
      setSubmitting(null)
    }
  }

  const chosenId = selectedOptionId ?? localChoice
  const chosen = chosenId ? options.find((option) => option.optionId === chosenId) : undefined
  const approved = outcome === 'selected' || (localChoice != null && chosen != null && isAllow(chosen))

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border',
        settled
          ? 'border-black/10 dark:border-white/10'
          : // An open request is the one thing in the transcript that is
            // actually waiting on the reader, so it gets the only accent
            // treatment in the whole thread.
            'border-amber-500/40 bg-amber-500/[0.04]',
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        {settled ? (
          approved ? (
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <ShieldX size={14} className="mt-0.5 shrink-0 text-black/35 dark:text-white/35" />
          )
        ) : (
          <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-black/80 dark:text-white/80">{title}</p>
          {detail && (
            <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-black/50 dark:text-white/50">
              {detail}
            </p>
          )}
        </div>
      </div>

      {settled ? (
        <div className="flex items-center gap-1.5 border-t border-black/10 px-3 py-1.5 text-xs text-black/45 dark:border-white/10 dark:text-white/45">
          {approved ? <Check size={12} /> : <X size={12} />}
          <span>
            {approved
              ? `Allowed${chosen ? ` — ${labelFor(chosen)}` : ''}`
              : reason === 'timeout'
                ? 'No answer in time — denied automatically'
                : `Denied${reason && reason !== 'denied' ? ` — ${reason}` : ''}`}
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-amber-500/20 px-3 py-2">
          {options.length === 0 ? (
            <span className="text-xs text-black/45 dark:text-white/45">
              The agent offered no options to choose from.
            </span>
          ) : (
            options.map((option) => (
              <button
                key={option.optionId}
                type="button"
                onClick={() => void decide(option)}
                disabled={submitting != null}
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-50',
                  isAllow(option)
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'border border-black/15 text-black/60 hover:bg-black/[0.04] dark:border-white/15 dark:text-white/60 dark:hover:bg-white/[0.06]',
                )}
              >
                {submitting === option.optionId ? 'Sending…' : labelFor(option)}
              </button>
            ))
          )}
        </div>
      )}

      {error && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
    </div>
  )
}
