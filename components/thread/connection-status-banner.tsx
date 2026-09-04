'use client'

import { Loader2, WifiOff } from 'lucide-react'
import type { RunStreamConnectionStatus } from '@/components/runs/use-run-event-stream'

/**
 * ROADMAP B-6 "Finish" (state-craft sweep) — the plan's "offline/
 * disconnected" standard: "a quiet banner when the event stream ... drops,
 * with automatic reconnect and a manual retry. Never silent." Shared by
 * every `<Thread>` chrome (drawer tab, full page, lane view, the page-
 * docked panel) since they all read `connectionStatus`/`retry` off the same
 * `useThreadData` -> `useRunEventStream` hook — one component change
 * reaches all four.
 *
 * Three visible states rather than one. The earlier version rendered the
 * same amber "reconnecting" line for any non-open condition, which meant a
 * normal sub-second reconnect flashed a scary banner, and a genuinely dead
 * stream looked exactly like a healthy one mid-blink. Now: `connecting` is
 * silent (the hook holds it for a 2s grace period, which most reconnects
 * finish inside), `reconnecting` is amber and counts attempts so the loop
 * reads as progress, and `offline` is red and terminal — the hook has
 * stopped retrying, so Retry is the only way forward and the button says so.
 */
export function ConnectionStatusBanner({
  status,
  attempt,
  maxAttempts,
  onRetry,
}: {
  status: RunStreamConnectionStatus
  attempt?: number
  maxAttempts?: number
  onRetry: () => void
}) {
  // `connecting` renders nothing on purpose — see the hook's grace period.
  if (status === 'connected' || status === 'connecting') return null

  const offline = status === 'offline'

  return (
    <div
      className={
        offline
          ? 'flex shrink-0 items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400'
          : 'flex shrink-0 items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-400'
      }
    >
      <span className="flex items-center gap-1.5">
        {offline ? <WifiOff size={12} /> : <Loader2 size={12} className="animate-spin" />}
        {offline ? (
          'Live updates stopped — the connection could not be re-established.'
        ) : (
          <>
            Reconnecting…
            {attempt != null && attempt > 0 && maxAttempts != null && (
              <span className="tabular-nums opacity-70">
                ({attempt}/{maxAttempts})
              </span>
            )}
          </>
        )}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 font-medium underline-offset-2 hover:underline"
      >
        {offline ? 'Reconnect' : 'Retry now'}
      </button>
    </div>
  )
}
