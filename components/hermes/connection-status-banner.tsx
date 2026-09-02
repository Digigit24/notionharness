'use client'

import { WifiOff } from 'lucide-react'
import type { RunStreamConnectionStatus } from '@/components/runs/use-run-event-stream'

/**
 * ROADMAP B-6 "Finish" (state-craft sweep) — the plan's "offline/
 * disconnected" standard: "a quiet banner when the event stream ... drops,
 * with automatic reconnect and a manual retry. Never silent." Shared by
 * every `<Thread>` chrome (drawer tab, full page, lane view, the page-
 * docked panel) since they all read `connectionStatus`/`retry` off the same
 * `useThreadData` -> `useRunEventStream` hook — one component change
 * reaches all four. Renders nothing while connected; EventSource already
 * reconnects on its own (per-run "Last-Event-ID" resume), so `retry` exists
 * only for the case where a viewer doesn't want to wait on that backoff.
 */
export function ConnectionStatusBanner({
  status,
  onRetry,
}: {
  status: RunStreamConnectionStatus
  onRetry: () => void
}) {
  if (status === 'connected') return null
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-400">
      <span className="flex items-center gap-1.5">
        <WifiOff size={12} />
        Live updates dropped — reconnecting…
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 font-medium underline-offset-2 hover:underline"
      >
        Retry now
      </button>
    </div>
  )
}
