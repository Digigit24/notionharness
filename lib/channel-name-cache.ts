'use client'

/**
 * A synchronous, in-memory cache of channel id -> name, so a channel's own
 * loading skeleton can show the REAL name the instant a click fires, instead
 * of a grey bar.
 *
 * WHY THIS EXISTS. Next.js already shows `[teamId]/loading.tsx` immediately
 * on navigation (App Router's built-in behaviour) while the channel page's
 * server component resolves — the "instant transition" already happens. What
 * was missing is that `loading.tsx` has no data of its own: it's a static
 * skeleton, so its breadcrumb rendered as a grey `Skeleton` bar rather than
 * "#general". But the SIDEBAR already has every channel's name in memory —
 * it fetched `SidebarChannels` to draw the channel list you just clicked in.
 * This cache is the bridge: `ChannelList` writes into it as it renders, and
 * the loading skeleton (a client component, via `useParams()`) reads out of
 * it — no new query, no round trip, just handing data one client component
 * already has to another that needs it a moment later.
 *
 * SESSION-LIFETIME, NOT PERSISTED. A hard reload loses it, which is fine: the
 * loading skeleton falls back to its generic bar in that case (see its own
 * code), and the cache is repopulated the next time the sidebar renders the
 * channel list, which is on every page since the sidebar is global chrome.
 */
const cache = new Map<number, string>()

export function registerChannelNames(channels: Array<{ id: number; name: string }>) {
  for (const c of channels) cache.set(c.id, c.name)
}

export function getCachedChannelName(id: number): string | null {
  return cache.get(id) ?? null
}
