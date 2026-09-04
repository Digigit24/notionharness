'use client'

import { useEffect } from 'react'

/**
 * R12-P4.6 — "twelve sections is past the point where scanning is
 * reliable", and past the point where losing an edit by clicking the wrong
 * rail item is acceptable either.
 *
 * TWO SEPARATE LEAKS, because leaving the page happens two different ways
 * and the App Router gives you a hook for neither on its own.
 *
 *  1. Closing the tab, refreshing, or navigating to a different origin —
 *     the browser's own `beforeunload` prompt is the only tool for this,
 *     and it is a native confirm the OS renders, not something this app can
 *     style. That is fine; the goal is "do not lose the edit", not "look
 *     good doing it".
 *  2. An in-app navigation — clicking a rail item, pressing back. Next's
 *     App Router has no `router.beforeNavigate` today (unlike React
 *     Router's `<Prompt>`), so the only reliable interception point is a
 *     capture-phase click listener on every same-document anchor. `router.
 *     push()` calls that do not originate from a real `<a>` click (rare in
 *     this codebase's settings screens — everything here is `<Link>`) are
 *     NOT covered, which is a real, stated gap rather than a silent one.
 *
 * `window.confirm` is a blocking native dialog, and normally that is exactly
 * the kind of thing this codebase avoids (see the client-in-Chrome tooling's
 * own rule against triggering one) — but that rule is about an AUTOMATION
 * TOOL getting stuck on a dialog it cannot dismiss. This is the product
 * asking an actual person a yes/no question at the one moment it matters,
 * which is the standard, expected pattern every editor on the web uses for
 * exactly this. The two are not the same thing.
 */
export function useUnsavedChangesGuard(isDirty: boolean, message = 'You have unsaved changes. Leave anyway?'): void {
  useEffect(() => {
    if (!isDirty) return

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Chrome ignores a custom string and shows its own fixed sentence, but
      // `returnValue` still has to be SET (to anything) — that assignment,
      // not its value, is what makes the browser prompt at all.
      event.returnValue = ''
    }

    const onClickCapture = (event: MouseEvent) => {
      // A modified click (open in new tab, etc.) leaves THIS tab exactly as
      // it was, so there is nothing to lose here and nothing to ask about.
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href]')
      if (!anchor) return
      const href = anchor.getAttribute('href')
      // External links, downloads, and same-page hash jumps are not a
      // navigation away from this form — nothing on screen would change.
      if (!href || href.startsWith('#') || anchor.hasAttribute('download') || anchor.target === '_blank') return
      if (anchor.origin !== window.location.origin) return

      if (!window.confirm(message)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    // Capture phase, so this runs before `<Link>`'s own click handler starts
    // the navigation — stopping propagation after the fact would be too late.
    document.addEventListener('click', onClickCapture, true)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onClickCapture, true)
    }
  }, [isDirty, message])
}
