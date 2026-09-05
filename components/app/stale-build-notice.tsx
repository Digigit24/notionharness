'use client'

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

/**
 * Detects the one failure this app produces most often in normal use: a tab
 * left open across a deploy or a rebuild-and-restart, still running the
 * previous build's client bundle against a server that no longer has it.
 *
 * It shows up three ways, all of which look like unrelated bugs to whoever
 * is sitting in front of it:
 *
 *   - `Failed to find Server Action "40977c84…"` — every Server Action call
 *     fails, so a cover you just picked paints optimistically and then
 *     reverts when its save is refused, sending a message fails, and the
 *     background polls break silently and all at once
 *   - `ChunkLoadError: Loading chunk 326 failed` — a lazily-loaded chunk
 *     whose content-hashed filename no longer exists
 *   - `Failed to construct 'HTMLElement': Illegal constructor` — the subtle
 *     one: a client-side navigation pulled a NEW build's BlockSuite chunk
 *     into a document that already registered the OLD build's custom
 *     elements. A custom-element registry cannot be redefined, so every
 *     editor mount throws from then until the document is reloaded
 *
 * WHY THIS IS NOW PROACTIVE, NOT JUST A BANNER. The listener-only version
 * had two blind spots, both hit for real: (1) it only saw UNHANDLED
 * rejections, and the code paths that matter most — the cover/icon
 * updaters, the suggestion poll — catch their errors to show a toast or
 * stay quiet, so the one signal that would have explained everything never
 * reached it; (2) a small pill at the bottom of a page that is otherwise
 * misbehaving in three different ways is easy to miss. Now the page carries
 * the build id it was served with, `/api/build-id` reports the build the
 * server is actually running, and a mismatch — polled, and re-checked the
 * moment the tab becomes visible again — reloads the document once on its
 * own. Catch sites report through `noteStaleBuildError` so a swallowed
 * stale-action error still counts as evidence.
 *
 * `sessionStorage` (per tab) guards the auto-reload: if this tab already
 * reloaded itself within the last `RELOAD_GUARD_MS` and is STILL stale —
 * the window between `next build` finishing and the server restarting, when
 * disk and process disagree — it falls back to the banner rather than
 * thrashing, and tries again on the next poll.
 *
 * Deliberately still a listener rather than an error boundary: these
 * failures reject promises inside actions and dynamic imports, which never
 * reach a boundary's render path, so a boundary would not see them at all.
 */
const STALE_PATTERNS = [
  /Failed to find Server Action/i,
  /Server Action .* was not found/i,
  /ChunkLoadError/i,
  /Loading chunk .* failed/i,
  /Loading CSS chunk .* failed/i,
  /Illegal constructor/i,
]

const POLL_MS = 30_000
const INITIAL_CHECK_MS = 5_000
const RELOAD_GUARD_KEY = 'nf:stale-build-reloaded-at'
const RELOAD_GUARD_MS = 90_000

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

const listeners = new Set<() => void>()

/** For catch blocks that would otherwise swallow the evidence: pass the
 * caught error here and, if it is one of the stale-build signatures, the
 * mounted notice reacts exactly as it would to an unhandled one. Anything
 * else is ignored, so this is safe to call from every catch. */
export function noteStaleBuildError(reason: unknown): void {
  if (!looksStale(reason)) return
  for (const listener of listeners) listener()
}

function recover(showBanner: () => void) {
  let lastReloadAt = 0
  try {
    lastReloadAt = Number(window.sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0)
  } catch {
    // Storage blocked (private mode, policy) — no guard possible, so do not
    // auto-reload at all; the banner is the safe fallback.
    showBanner()
    return
  }
  if (Date.now() - lastReloadAt < RELOAD_GUARD_MS) {
    showBanner()
    return
  }
  try {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()))
  } catch {
    showBanner()
    return
  }
  // `location.replace`, not `reload()`: a plain reload can be served from
  // the browser's own cache, which is precisely what is stale here.
  window.location.replace(window.location.href)
}

export function StaleBuildNotice({ buildId }: { buildId: string }) {
  const [stale, setStale] = useState(false)

  useEffect(() => {
    let disposed = false
    const trigger = () => {
      if (!disposed) recover(() => setStale(true))
    }

    listeners.add(trigger)
    const onRejection = (event: PromiseRejectionEvent) => {
      if (looksStale(event.reason)) trigger()
    }
    const onError = (event: ErrorEvent) => {
      if (looksStale(event.error) || looksStale(event.message)) trigger()
    }
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('error', onError)

    const check = async () => {
      if (buildId === 'development') return
      try {
        const res = await fetch('/api/build-id', { cache: 'no-store' })
        if (!res.ok) return
        const body = (await res.json()) as { buildId?: string }
        if (body.buildId && body.buildId !== buildId) trigger()
      } catch {
        // Offline or the server is mid-restart — the next poll asks again.
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    const initial = window.setTimeout(() => void check(), INITIAL_CHECK_MS)
    const interval = window.setInterval(() => void check(), POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)

    return () => {
      disposed = true
      listeners.delete(trigger)
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onError)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onVisible)
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [buildId])

  if (!stale) return null

  return (
    <div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="flex items-center gap-3 rounded-full border border-amber-500/40 bg-amber-50 px-4 py-2 text-xs text-amber-800 shadow-lg dark:bg-amber-950 dark:text-amber-200">
        <span>This page is running an older version of the app.</span>
        <button
          type="button"
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
