'use client'

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

/**
 * Detects the one failure this app produces most often in normal use: a tab
 * left open across a deploy, still running the previous build's client bundle
 * against a server that no longer has it.
 *
 * It shows up two ways, both of which look like unrelated bugs to whoever is
 * sitting in front of it:
 *
 *   - `Failed to find Server Action "40977c84…"` — every Server Action call
 *     fails, so sending a message, stopping a run, and the background poll all
 *     break silently and at once
 *   - `ChunkLoadError: Loading chunk 326 failed` — a lazily-loaded chunk whose
 *     content-hashed filename no longer exists
 *
 * A generic error boundary is the wrong response to both, because the cause is
 * known and the remedy is always the same single action. Observed live: a tab
 * in this state emitted a matched pair of Server Action errors every eight
 * seconds (the run-discovery poll) with nothing on screen to explain it.
 *
 * Deliberately a listener rather than an error boundary: these failures reject
 * promises inside actions and dynamic imports, which never reach a boundary's
 * render path, so a boundary would not see them at all.
 */
const STALE_PATTERNS = [
  /Failed to find Server Action/i,
  /Server Action .* was not found/i,
  /ChunkLoadError/i,
  /Loading chunk .* failed/i,
  /Loading CSS chunk .* failed/i,
]

function looksStale(value: unknown): boolean {
  const text =
    value instanceof Error
      ? `${value.name}: ${value.message}`
      : typeof value === 'string'
        ? value
        : value && typeof value === 'object' && 'message' in value
          ? String((value as { message: unknown }).message)
          : ''
  if (!text) return false
  return STALE_PATTERNS.some((pattern) => pattern.test(text))
}

export function StaleBuildNotice() {
  const [stale, setStale] = useState(false)

  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (looksStale(event.reason)) setStale(true)
    }
    const onError = (event: ErrorEvent) => {
      if (looksStale(event.error) || looksStale(event.message)) setStale(true)
    }
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('error', onError)
    return () => {
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onError)
    }
  }, [])

  if (!stale) return null

  return (
    <div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="flex items-center gap-3 rounded-full border border-amber-500/40 bg-amber-50 px-4 py-2 text-xs text-amber-800 shadow-lg dark:bg-amber-950 dark:text-amber-200">
        <span>This page is running an older version of the app.</span>
        <button
          type="button"
          // A plain `reload()` can be served from the browser's own cache,
          // which is precisely what is stale here — `location.replace` on the
          // current URL forces a fresh document request instead.
          onClick={() => window.location.replace(window.location.href)}
          className="flex shrink-0 items-center gap-1 rounded-full bg-amber-600 px-2.5 py-1 font-medium text-white hover:bg-amber-700"
        >
          <RefreshCw size={11} />
          Reload
        </button>
      </div>
    </div>
  )
}
