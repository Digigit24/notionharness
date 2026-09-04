'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { cn } from '@/lib/utils'

/**
 * MessageScroller component
 *
 * The one scroller shared by every Thread chrome (drawer/full-page/lane/
 * docked-panel, per D13's "one Thread, N chromes") — a change here reaches
 * all four.
 *
 * Phase C, C3 — this session's own audit of the roadmap doc's thread-scroll
 * checklist found the hand-rolled version genuinely missing what the doc
 * called out: restore-on-mount (this codebase's own prior version only
 * auto-scrolled on new content, never positioned itself on first mount) and
 * jump-to-message (no way back to the bottom once you'd scrolled up while
 * a run was still streaming). Replaced with `use-stick-to-bottom` — the
 * same library assistant-ui itself uses for this exact problem, per the
 * roadmap doc's own citation — rather than hand-rolling a second, subtly
 * different scroll-anchoring implementation.
 *
 * History-prepend (the doc's third checklist item) is deliberately NOT
 * attempted here: `use-thread-data.ts`'s `loader` returns every event for
 * every run of a task in one shot — there is no paginated/offset-based
 * message loading anywhere in this data layer to prepend *from*. Building
 * prepend-on-scroll-up UI against a data source that can't actually supply
 * older pages would be exactly the fabricated-affordance pattern this
 * codebase's own discipline argues against; real history-prepend needs
 * pagination built into the loader first, which is separate, larger work.
 */
export interface MessageScrollerProps {
  children?: ReactNode
  className?: string
  autoScroll?: boolean
  /** Number of messages currently rendered. Used only to count how many
   * arrived while the reader was scrolled away. */
  itemCount?: number
}

export function MessageScroller({ children, className, autoScroll = true, itemCount = 0 }: MessageScrollerProps) {
  const prefersReducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // `initial` governs the very first scroll (restore-on-mount): 'instant'
  // rather than the library's default spring animation, matching this
  // app's existing reduced-motion posture (app/globals.css's global
  // `prefers-reduced-motion` rule already suppresses CSS transitions/
  // animations, but this library's scroll motion is JS-driven rAF, not
  // CSS, so it needs the same intent applied explicitly here).
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    initial: autoScroll ? 'instant' : false,
    resize: prefersReducedMotion ? 'instant' : undefined,
  })

  // Baseline resets every time the reader returns to the bottom, so the
  // count always means "arrived since you looked away" rather than a
  // running total.
  const seenCountRef = useRef(itemCount)
  const [unreadCount, setUnreadCount] = useState(0)
  useEffect(() => {
    if (isAtBottom) {
      seenCountRef.current = itemCount
      setUnreadCount(0)
    } else {
      setUnreadCount(Math.max(0, itemCount - seenCountRef.current))
    }
  }, [itemCount, isAtBottom])

  return (
    <div
      ref={scrollRef}
      // Same live-region treatment the prior hand-rolled version had:
      // `role="log"` is the standard ARIA role for an appending
      // transcript, `polite` avoids interrupting whatever the user is
      // doing mid-stream.
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      className={cn('relative flex flex-col overflow-y-auto', 'bg-white dark:bg-gray-900', className)}
    >
      <div ref={contentRef} className="flex flex-col gap-4 p-4">
        {children}
      </div>

      {autoScroll && !isAtBottom && (
        <button
          type="button"
          onClick={() => void scrollToBottom()}
          aria-label={unreadCount > 0 ? `Jump to ${unreadCount} new messages` : 'Jump to latest message'}
          title={unreadCount > 0 ? `${unreadCount} new below` : 'Jump to latest message'}
          // `self-center` + `w-fit` are load-bearing: this is a sticky child
          // of a `flex flex-col` container, whose default `align-items:
          // stretch` blew the pill out to the container's full width — it
          // rendered as a ~650px blank bar clipped at the bottom edge,
          // covering the last line of the transcript. The `left-1/2 +
          // -translate-x-1/2` centring trick does not apply to a flex child
          // and was fighting it besides.
          className="sticky bottom-3 z-10 flex w-fit shrink-0 items-center gap-1.5 self-center rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-black/60 shadow-md hover:text-black dark:border-white/10 dark:bg-gray-800 dark:text-white/60 dark:hover:text-white"
        >
          <ArrowDown size={13} />
          {/* Only counts what arrived while scrolled away, so reading back
              through history doesn't feel like fighting the autoscroll —
              you can see whether anything is actually waiting below. Always
              renders a label: an icon-only capsule read as an empty bar. */}
          <span className="tabular-nums">{unreadCount > 0 ? `${unreadCount} new` : 'Latest'}</span>
        </button>
      )}
    </div>
  )
}
