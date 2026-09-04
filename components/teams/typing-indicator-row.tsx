'use client'

import { colourOf, initialsOf, slotById, type TeamSlotView } from './shared'

/**
 * R12-P3.2's sibling to `pending-reply-row.tsx`.
 *
 * The roadmap item is explicit that these two should not "look like two
 * features" — an agent that has been woken already gets a ghost row with an
 * avatar and a coloured left edge; a person typing gets the same shape, cut
 * down to what a typing signal actually carries: nobody's, and never a claim
 * about content, because none exists to show.
 *
 * Deliberately much smaller than `PendingReplyRow` — no stream, no retry
 * state, no "see full run" link — because there is no run underneath this.
 * It is one fact (`slotId`, `at`) with a four-second shelf life, rendered and
 * forgotten; `TypingIndicatorRow` owns none of that expiry logic, the room
 * does (see `team-room.tsx`'s typing state), so this stays a pure view.
 */
export function TypingIndicatorRow({ slotId, slots }: { slotId: number; slots: TeamSlotView[] }) {
  const slot = slotById(slots, slotId)
  const name = slot?.displayName ?? 'Someone'

  return (
    <li className="mt-1 flex items-center gap-2.5 px-2 py-0.5" aria-live="polite">
      <div className="w-7 shrink-0">
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-md text-[11px] font-semibold text-white opacity-70"
          style={{ backgroundColor: colourOf(slot) }}
        >
          {initialsOf(name)}
        </span>
      </div>
      <span className="flex items-center gap-1 text-xs text-black/40 dark:text-white/40">
        <span className="font-medium text-black/55 dark:text-white/55">{name}</span>
        is typing
        <TypingDots />
      </span>
    </li>
  )
}

/** Three dots, staggered. `prefers-reduced-motion` collapses the whole
 * pulse to 0.001ms via the app-wide rule in `globals.css`, at which point
 * this reads as three static dots — still legible as "typing", not broken. */
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-1 rounded-full bg-current animate-pulse motion-reduce:animate-none"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  )
}
