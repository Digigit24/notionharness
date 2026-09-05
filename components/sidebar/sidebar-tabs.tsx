'use client'

/**
 * The sidebar's two tabs, and the one function that decides which of them a
 * URL belongs to.
 *
 * WHY TABS AT ALL: the sidebar used to be twelve flat section links stacked
 * above the page tree — every route in the product competing for the same
 * strip of 256px, with no grouping to say which of them belong together. The
 * two tabs (labelled "Home" and "Work" — the KEYS below stay `plan`/
 * `channels`, only the sidebar's own display labels changed, so this file's
 * routing table did not need a rename to match) are the product's two real
 * modes of attention:
 *
 *   Home (key: plan)     — the Notion half, PLUS what the machines did.
 *                          Home, Inbox, Tasks, Projects, Artifacts, Review,
 *                          Active runs, Audit, the page tree, Favourites.
 *   Work (key: channels) — the rooms and the conversations. Every channel
 *                          with its agents, Agents, New Session, and the
 *                          Sessions history.
 *
 * ACTIVITY USED TO BE A THIRD TAB. Folded into Home: a handful of links did
 * not carry its own mode of attention the way planning and working do, and a
 * third tab for it cost a permanent slot in a three-way strip for something
 * reached far less often than either of the other two.
 *
 * Settings is deliberately NOT a tab: it is pinned at the bottom of the
 * sidebar, outside the tab strip, so it is reachable from both without a
 * detour. That is why `tabForPathname` returns `null` for it rather than
 * forcing one of the two — see the "neutral route" note below.
 *
 * NOTHING HERE NAVIGATES. Switching a tab is `useState` in the sidebar, not
 * `router.push`. That exact mistake was fixed in components/layout/
 * detail-layout.tsx this week: pushing a route to move a highlight makes the
 * server component re-run and the control lag behind the click. A tab strip
 * must feel like a button (D0: no round trip on a UI action).
 */

import { cn } from '@/lib/cn'

export type SidebarTabKey = 'plan' | 'channels'

export const SIDEBAR_TAB_KEYS: readonly SidebarTabKey[] = ['plan', 'channels']

export function isSidebarTabKey(value: unknown): value is SidebarTabKey {
  return typeof value === 'string' && (SIDEBAR_TAB_KEYS as readonly string[]).includes(value)
}

/**
 * First path segment under `/workspace/:slug` -> owning tab.
 *
 * Keyed on the FIRST SEGMENT rather than the full path so a detail route goes
 * to the same tab as its list: `/teams/12` is Channels because `/teams` is,
 * `/runs/<uuid>/review` is Activity because `/runs` is. A per-route table
 * would have to be extended every time someone adds a detail page, and the
 * failure mode of forgetting is the one thing this must never do — show a
 * section the user is not in.
 */
const TAB_BY_SEGMENT: Record<string, SidebarTabKey> = {
  // Home (label) / plan (key) — the Notion half, plus what the machines did.
  '': 'plan', // the bare workspace root, i.e. Home
  inbox: 'plan',
  tasks: 'plan',
  projects: 'plan',
  artifacts: 'plan',
  p: 'plan', // a page: /workspace/:slug/p/:id
  review: 'plan',
  'active-runs': 'plan',
  audit: 'plan',
  runs: 'plan', // /runs/:runId/review
  // Work (label) / channels (key) — the rooms and who is in them.
  teams: 'channels',
  agents: 'channels',
  work: 'channels',
  ask: 'channels', // legacy alias that redirects to /work; mapped so the one
  // render before the redirect lands is not on the wrong tab.
}

/**
 * Which tab owns `pathname`, or `null` when no tab does.
 *
 * `null` is a real answer, not a failure: Settings lives outside the tabs, and
 * a route nobody has claimed yet should leave the user's last chosen tab alone
 * rather than yank them to Plan. The caller treats null as "keep what you had".
 */
export function tabForPathname(pathname: string, workspaceSlug: string): SidebarTabKey | null {
  const base = `/workspace/${workspaceSlug}`
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null
  const tail = pathname.slice(base.length).replace(/^\/+/, '').replace(/\/+$/, '')
  const segment = tail.split('/')[0] ?? ''
  return TAB_BY_SEGMENT[segment] ?? null
}

export interface SidebarTabDescriptor {
  key: SidebarTabKey
  label: string
  /** Rendered as a dot on the tab. Used for channel unread, which is the only
   * thing that happens in a tab you are not looking at. */
  dot?: 'none' | 'unread' | 'mention'
}

export function SidebarTabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: SidebarTabDescriptor[]
  active: SidebarTabKey
  onSelect: (key: SidebarTabKey) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Sidebar section"
      // Sized to however many tabs are actually passed in, rather than a
      // hardcoded column count — Activity folding into Home dropped this from
      // three tabs to two, and a fixed `grid-cols-3` would have left a bare
      // third slot rather than two evenly-split buttons.
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      className="mx-2 mt-2 grid gap-0.5 rounded-lg bg-black/[.05] p-0.5 dark:bg-white/[.06]"
    >
      {tabs.map((tab) => {
        const isActive = tab.key === active
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`sidebar-tab-${tab.key}`}
            aria-controls={`sidebar-panel-${tab.key}`}
            aria-selected={isActive}
            // Keyboard: the strip is three buttons in DOM order, so Tab already
            // walks them. A roving-tabindex listbox would be more "correct" ARIA
            // but strictly worse here — it makes the two unselected tabs
            // unreachable by Tab, on a control people reach for constantly.
            onClick={() => onSelect(tab.key)}
            className={cn(
              'relative flex items-center justify-center rounded-[7px] px-1 py-1.5 text-[11px] font-medium transition-colors',
              isActive
                ? 'bg-white text-black shadow-sm dark:bg-white/[.14] dark:text-white'
                : 'text-black/50 hover:bg-black/[.04] hover:text-black/80 dark:text-white/50 dark:hover:bg-white/[.05] dark:hover:text-white/80',
            )}
          >
            <span className="truncate">{tab.label}</span>
            {tab.dot && tab.dot !== 'none' && (
              <span
                aria-hidden
                className={cn(
                  'absolute top-1 right-1 h-1.5 w-1.5 rounded-full',
                  // A mention is a different urgency from "something was said",
                  // so it is a different colour rather than a bigger number.
                  tab.dot === 'mention' ? 'bg-amber-500' : 'bg-sky-500',
                )}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
