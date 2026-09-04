'use client'

import { useState } from 'react'
import { Check, ExternalLink, Plug, PlugZap, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PermissionOption } from '@/lib/run-events'

/**
 * The in-transcript control for a run parked on `connect_app`.
 *
 * WHY IT IS A SEPARATE COMPONENT FROM `PermissionCard` AND NOT A THIRD LOOK.
 * The two are the same block in the transcript — same border, same amber
 * "this is waiting on you" treatment, same settled footer, same endpoint —
 * because they are the same fact: this run has stopped and needs you. What
 * differs is the ACTION, and it differs enough that one component could not
 * honestly serve both. A permission is answered by pressing a button here; a
 * connection is answered by leaving for a third party, signing in, and coming
 * back. That means a primary control that opens a new tab, a state for "you
 * have gone off to do it", and buttons whose labels are not Allow and Deny.
 * Sharing the styling and splitting the behaviour keeps it one feature with
 * two shapes rather than two features that look alike.
 *
 * IT RESOLVES ITSELF. Nobody has to come back and press anything: the callback
 * at `/api/connectors/callback` settles the same approval the run is waiting
 * on, the tool then writes the settled `permission` event, and it arrives on
 * the transcript's own SSE stream. The buttons below are the fallback for when
 * that does not happen — a blocked popup, a redirect a browser ate — not the
 * intended path.
 *
 * THE AUTHORISATION URL IS NOT IN THIS COMPONENT. It never reaches the browser
 * as data; the button is a link to `/api/approvals/connect`, which checks who
 * is asking and then redirects. See that route for why.
 */
export interface ConnectCardProps {
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

export function ConnectCard({ requestId, title, detail, outcome, options, reason }: ConnectCardProps) {
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set the instant the server accepts, so the card stops offering buttons
  // without waiting for the settled event to make the round trip back.
  const [localChoice, setLocalChoice] = useState<'connected' | 'skipped' | null>(null)
  // Purely local: "you have opened the consent screen". It is not a decision
  // and is not sent anywhere — it exists so the card stops looking like it is
  // waiting for a click it has already had.
  const [opened, setOpened] = useState(false)

  const settled = outcome != null || localChoice != null
  const connected = outcome === 'selected' || localChoice === 'connected'

  const skipOption = options.find((option) => !isAllow(option))

  async function decide(decision: 'approved' | 'denied', optionId: string) {
    if (submitting || settled) return
    setSubmitting(optionId)
    setError(null)
    try {
      const res = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ externalId: requestId, decision, selectedOptionId: optionId }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      setLocalChoice(decision === 'approved' ? 'connected' : 'skipped')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that.')
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border',
        settled
          ? 'border-black/10 dark:border-white/10'
          : // Same accent as an open permission request, deliberately: an open
            // block is an open block, and a second colour for the second kind
            // would read as a second severity.
            'border-amber-500/40 bg-amber-500/[0.04]',
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        {settled ? (
          connected ? (
            <PlugZap size={14} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <Plug size={14} className="mt-0.5 shrink-0 text-black/35 dark:text-white/35" />
          )
        ) : (
          <Plug size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
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
          {connected ? <Check size={12} /> : <X size={12} />}
          <span>
            {connected
              ? 'Connected — carrying on.'
              : reason === 'timeout'
                ? 'Nobody finished in time — the agent carried on without it'
                : 'Not connected — the agent carried on without it'}
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-amber-500/20 px-3 py-2">
          <a
            href={`/api/approvals/connect?request=${encodeURIComponent(requestId)}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpened(true)}
            className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-emerald-700"
          >
            <ExternalLink size={12} />
            {opened ? 'Open it again' : 'Connect'}
          </a>
          {opened && (
            <span className="text-xs text-black/45 dark:text-white/45">
              Finish signing in — this updates on its own.
            </span>
          )}
          <span className="flex-1" />
          {/* Only offered once the consent screen has been opened. Before that
              it is an invitation to lie about work not yet started, and its
              only effect would be to make the agent report "still not
              connected" a moment later. */}
          {opened && (
            <button
              type="button"
              onClick={() => void decide('approved', 'connected')}
              disabled={submitting != null}
              className="rounded-full border border-black/15 px-2.5 py-1 text-xs font-medium text-black/60 transition hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/15 dark:text-white/60 dark:hover:bg-white/[0.06]"
            >
              {submitting === 'connected' ? 'Checking…' : 'I have connected it'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void decide('denied', skipOption?.optionId ?? 'skip')}
            disabled={submitting != null}
            className="rounded-full border border-black/15 px-2.5 py-1 text-xs font-medium text-black/60 transition hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/15 dark:text-white/60 dark:hover:bg-white/[0.06]"
          >
            {submitting != null && submitting !== 'connected' ? 'Sending…' : 'Skip'}
          </button>
        </div>
      )}

      {error && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
    </div>
  )
}
