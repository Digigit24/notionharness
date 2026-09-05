'use client'

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { ToastAction } from '@/components/ui/toast'

/**
 * Detects the one failure this app produces most often in normal use: a tab
 * left open across a deploy or a rebuild-and-restart, still running the
 * previous build's client bundle against a server that no longer has it.
 *
 * It shows up two ways, both of which look like unrelated bugs to whoever is
 * sitting in front of it:
 *
 *   - `Failed to find Server Action "40977c84…"` — every Server Action call
 *     fails, so a cover you just picked paints optimistically and then
 *     reverts when its save is refused, sending a message fails, and the
 *     background polls break silently and all at once
 *   - `ChunkLoadError: Loading chunk 326 failed` — a lazily-loaded chunk
 *     whose content-hashed filename no longer exists
 *
 * `Failed to construct 'HTMLElement': Illegal constructor` USED TO be listed
 * here as a third stale-build signature and is deliberately no longer one —
 * diagnosed live, it turned out to be a genuinely different bug (BlockSuite's
 * custom elements re-registering because `BlockSuiteEditor.tsx` has five
 * separate import sites webpack can split into separate chunks, each with
 * its own copy of the "register once" guard — see that file's own long
 * comment on `ensureBlockSuiteEffects`, which fixes it at the root with a
 * `window`-scoped singleton). Matching it here was actively harmful: it
 * reloaded the tab, which incidentally cleared the corrupted registry and
 * made the symptom go away, while mislabelling the cause as a stale build
 * every time — exactly the kind of thing that would send a future
 * investigation chasing the wrong fix if the underlying bug ever came back
 * for an unrelated reason. `lib/blocksuite-duplicate-registration.ts` now
 * watches for it on its own, separately, and does NOT auto-reload.
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
]

const POLL_MS = 30_000
const INITIAL_CHECK_MS = 5_000
const RELOAD_GUARD_KEY = 'nf:stale-build-reloaded-at'
const RELOAD_GUARD_MS = 90_000

/** Returns the matched text (for the toast's description) when `value` looks
 * like a stale-build failure, `null` otherwise. */
function looksStale(value: unknown): string | null {
  const text =
    value instanceof Error
      ? `${value.name}: ${value.message}`
      : typeof value === 'string'
        ? value
        : value && typeof value === 'object' && 'message' in value
          ? String((value as { message: unknown }).message)
          : ''
  if (!text) return null
  return STALE_PATTERNS.some((pattern) => pattern.test(text)) ? text : null
}

const listeners = new Set<() => void>()
const TOAST_GUARD_KEY = 'nf:stale-build-toast-shown-at'
const TOAST_GUARD_MS = 15_000

/**
 * Immediate, visible feedback the instant a stale-build signature is
 * recognised — separate from whether the auto-reload below actually fires.
 * Without this, the FIRST occurrence reloads the tab almost silently (by
 * design — D0 says fix it, don't make someone read about it first), which
 * from the outside looks identical to nothing having happened; and every
 * occurrence AFTER the reload guard kicks in used to surface only as the
 * bottom-of-screen pill, easy to miss next to a page that is otherwise
 * failing in three different ways at once. A toast — the same surface every
 * other action failure in this app already uses (see page-canvas.tsx's
 * cover/icon updaters) — says what is happening on sight, whether or not the
 * page reloads a moment later on its own.
 *
 * Deliberately rate-limited per tab: the failures this recognises tend to
 * arrive in a burst (a poll retrying every few seconds, several Server
 * Actions in flight at once), and a toast per occurrence would be the exact
 * noise a person already frustrated by a broken tab does not need.
 */
function announce(text: string) {
  try {
    const last = Number(window.sessionStorage.getItem(TOAST_GUARD_KEY) ?? 0)
    if (Date.now() - last < TOAST_GUARD_MS) return
    window.sessionStorage.setItem(TOAST_GUARD_KEY, String(Date.now()))
  } catch {
    // Storage blocked — show it anyway; the worst case is one extra toast.
  }
  toast({
    title: 'This tab is running an older version of the app',
    description: text,
    variant: 'destructive',
    action: (
      <ToastAction altText="Reload" onClick={() => window.location.replace(window.location.href)}>
        Reload
      </ToastAction>
    ),
  })
}

/** For catch blocks that would otherwise swallow the evidence: pass the
 * caught error here and, if it is one of the stale-build signatures, the
 * mounted notice reacts exactly as it would to an unhandled one. Anything
 * else is ignored, so this is safe to call from every catch. */
export function noteStaleBuildError(reason: unknown): void {
  const text = looksStale(reason)
  if (!text) return
  announce(text)
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
      const text = looksStale(event.reason)
      if (text) {
        announce(text)
        trigger()
      }
    }
    const onError = (event: ErrorEvent) => {
      const text = looksStale(event.error) ?? looksStale(event.message)
      if (text) {
        announce(text)
        trigger()
      }
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
