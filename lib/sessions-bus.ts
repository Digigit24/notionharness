'use client'

import { useEffect, useRef } from 'react'
import type { SessionListItem } from '@/lib/broker'

/**
 * A tiny event bus so the Work page and the sidebar's Sessions section agree
 * instantly, without lifting session state up into a shared store.
 *
 * WHY A BUS AND NOT LIFTED STATE. The sidebar and `WorkView` are siblings
 * under `app/(app)/workspace/[workspaceSlug]/layout.tsx` — the sidebar is
 * server-rendered chrome that wraps `{children}`, and `WorkView` is deep
 * inside those children. Lifting `sessions` state up to the layout would mean
 * a Client Component wrapping the entire app just to hold one page's list,
 * which is the kind of change that touches every route to serve one. A
 * `window` event is the same trade `lib/command-bar-bus.ts` already made for
 * the same shape of problem (two components, no ancestor relationship worth
 * threading props through) — this file mirrors it exactly, widened to carry a
 * typed payload instead of being a bare signal.
 *
 * WHAT "OPTIMISTIC" MEANS HERE. `WorkView` already paints its own mutations
 * (new session, rename, pin, archive, delete, a message landing) into its own
 * `sessions` state before the server confirms — this bus is how the SIDEBAR's
 * copy of the same list gets the same paint on the same frame, instead of
 * waiting for its own next fetch. It is not a sync mechanism for OTHER
 * people's changes to a shared session (sessions are not shared — see
 * `ChatSession.createdBy` and the fact nothing in this app joins two users
 * into one work session) or for a run finishing while the sidebar sits open
 * with nobody driving it — those are covered by the sidebar's own
 * reconciliation poll, deliberately slower, in `sessions-list.tsx`.
 */
const SESSION_BUS_EVENT = 'notionforge:session-event'

export type SessionBusEvent =
  | { type: 'created'; session: SessionListItem }
  | { type: 'patched'; id: number; patch: Partial<SessionListItem> }
  | { type: 'deleted'; id: number }

export function publishSessionEvent(event: SessionBusEvent) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<SessionBusEvent>(SESSION_BUS_EVENT, { detail: event }))
}

/**
 * Subscribes for the lifetime of the calling component.
 *
 * The listener is attached ONCE (empty effect deps, so a rename typed
 * keystroke-by-keystroke in a caller's state does not tear down and
 * re-attach a `window` listener every render) but always calls the LATEST
 * `onEvent` via a ref — without that, a callback closing over component state
 * (as `WorkView`'s does, over `activeSessionId`) would freeze at whatever that
 * state was on first mount.
 */
export function useSessionBusListener(onEvent: (event: SessionBusEvent) => void) {
  const latest = useRef(onEvent)
  latest.current = onEvent
  useEffect(() => {
    const handler = (e: Event) => latest.current((e as CustomEvent<SessionBusEvent>).detail)
    window.addEventListener(SESSION_BUS_EVENT, handler)
    return () => window.removeEventListener(SESSION_BUS_EVENT, handler)
  }, [])
}

/** Applies one bus event to a `SessionListItem[]`, the same reducer both
 * `WorkView` (optional — it already holds richer local state) and the
 * sidebar's list use, so "what a `patched` event does to the array" is
 * answered once. */
export function applySessionEvent(sessions: SessionListItem[], event: SessionBusEvent): SessionListItem[] {
  switch (event.type) {
    case 'created':
      return [event.session, ...sessions.filter((s) => s.id !== event.session.id)]
    case 'patched':
      return sessions.map((s) => (s.id === event.id ? { ...s, ...event.patch } : s))
    case 'deleted':
      return sessions.filter((s) => s.id !== event.id)
    default:
      return sessions
  }
}
