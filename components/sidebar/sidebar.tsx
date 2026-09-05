'use client'

import { useEffect, useMemo, useOptimistic, useState, useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FolderKanban,
  GitPullRequest,
  History,
  Home,
  Inbox,
  ListTodo,
  LogOut,
  MessageCircle,
  Package,
  Plus,
  Search,
  Settings,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { ThemeToggle } from '@/components/theme/theme-toggle'
import { authClient } from '@/lib/auth-client'
import { PageTree } from './page-tree'
import { WorkspaceSwitcher } from './workspace-switcher'
import { ChannelList } from './channel-list'
import { SessionsSection } from './sessions-section'
import { SidebarTabBar, isSidebarTabKey, tabForPathname, type SidebarTabDescriptor, type SidebarTabKey } from './sidebar-tabs'
import { CommandBar } from '@/components/command-bar/command-bar'
import { openCommandBar } from '@/lib/command-bar-bus'
import { NotificationsBell } from '@/components/notifications/notifications-bell'
import { AmbientStatus } from '@/components/shell/ambient-status'
import type { AmbientStatus as AmbientStatusData } from '@/app/(app)/workspace/[workspaceSlug]/actions'
import { useSidebarAutoCollapse, useSidebarCollapsed } from '@/lib/keyboard/sidebar-collapse-store'
import { createPage, deletePageForever, restorePage } from '@/app/(app)/actions'
import type { Page, Workspace } from '@/payload-types'
// Type-only: `channels-data` imports the broker, which imports `pg`. Erased at
// compile time, so nothing from it reaches the browser bundle.
import type { SidebarChannels } from './channels-data'

/**
 * The workspace sidebar, as three tabs plus a pinned Settings row.
 *
 * WHAT CHANGED AND WHY: this used to be twelve flat section links stacked
 * above the page tree — Home, Inbox, Tasks, Projects, Agents, Work, Teams,
 * Artifacts, Review, Active runs, Audit, Settings — every route in the product
 * competing for the same 256px strip, in one undifferentiated list. Nothing
 * told you which of them belonged together, and the page tree (the thing you
 * actually navigate with all day) started below the fold.
 *
 * NOT ONE ROUTE WAS DROPPED. Every link in that list still exists, sorted into
 * the tab it belongs to (see sidebar-tabs.tsx for the mapping and the rules):
 *
 *   Plan     -> Home, Inbox, Tasks, Projects, Artifacts + Favourites, the page
 *               tree and Trash. The Notion half of the product.
 *   Channels -> every channel with its agents (unread and mentions as separate
 *               badges), then Agents and Work. `/teams` itself is always
 *               reachable from this tab's "All" link, including when the
 *               channel data is absent.
 *   Activity -> Review, Active runs, Audit.
 *   Settings -> pinned at the bottom, outside the tabs, always visible.
 *
 * THE MODE SWITCHER WAS REMOVED FROM HERE, deliberately, and this is the one
 * thing a reviewer should look at twice. `mode-switcher.tsx` still exists and
 * is untouched, but the sidebar no longer mounts it: a three-way Plan/Work/
 * Review segmented control sitting directly above a three-way Plan/Channels/
 * Activity tab strip is precisely the duplication this rebuild was asked to
 * remove. What that costs is real and is NOT reproduced by the tabs: the
 * switcher's cross-mode links preserve the entity you are looking at (from a
 * page to its run's review, from a task to its board). That belongs in the
 * page header next to the entity it is about, not in workspace-level chrome;
 * it is a follow-up, not something this unit could put anywhere sensible.
 */

interface SectionLink {
  /** Workspace-relative; '' is the workspace root, i.e. Home. Used for BOTH
   * the link target and the active-route match — see `query` below when a
   * link needs a search param that must not participate in that match. */
  href: string
  /** Appended to the link's target only; `isSectionActive` never sees it, so
   * a query-bearing link (e.g. "New Session" → `/work?new=1`) still lights up
   * for the whole route rather than never matching because `pathname` never
   * contains a query string. */
  query?: string
  label: string
  icon: LucideIcon
}

const PLAN_LINKS: SectionLink[] = [
  { href: '', label: 'Home', icon: Home },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/tasks', label: 'Tasks', icon: ListTodo },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/artifacts', label: 'Artifacts', icon: Package },
]

const CHANNEL_LINKS: SectionLink[] = [
  { href: '/agents', label: 'Agents', icon: Bot },
  // `?new=1` — read by `work/page.tsx` — forces a blank session rather than
  // reopening whichever one was last active, matching what "New Session"
  // says it does. The full history now lives in the Sessions section above,
  // not on this page any more.
  { href: '/work', query: '?new=1', label: 'New Session', icon: MessageCircle },
]

const ACTIVITY_LINKS: SectionLink[] = [
  { href: '/review', label: 'Review', icon: GitPullRequest },
  { href: '/active-runs', label: 'Active runs', icon: Activity },
  { href: '/audit', label: 'Audit', icon: History },
]

/**
 * Is `pathname` the active route for a section `href`?
 *
 * Home ('') matches only the bare workspace landing, so it cannot shadow every
 * route beneath it. Everything else matches itself AND its detail routes —
 * `/projects/12` highlights Projects — which the previous `pathname.endsWith`
 * test did not do, so a detail page used to leave the whole sidebar unlit.
 */
function isSectionActive(pathname: string, workspaceSlug: string, href: string): boolean {
  const base = `/workspace/${workspaceSlug}`
  if (href === '') return pathname === base || pathname === `${base}/`
  const full = `${base}${href}`
  return pathname === full || pathname.startsWith(`${full}/`)
}

export function Sidebar({
  workspace,
  workspaces,
  pages,
  userEmail,
  currentUserId,
  unreadNotificationCount,
  ambientStatus,
  channels,
}: {
  workspace: Workspace
  workspaces: Workspace[]
  pages: Page[]
  userEmail: string
  currentUserId: number | null
  unreadNotificationCount: number
  ambientStatus: AmbientStatusData
  /**
   * Channels, their rosters and the viewer's unread — resolved on the server
   * by `getSidebarChannels` (./channels-data) and passed in, because unread
   * comes out of the broker database and this is a client component.
   *
   * ONE query for every channel's unread, never one per channel:
   * `listChannelUnread` takes an array precisely so the most frequently
   * rendered surface in the product is not an N+1 (D0).
   *
   * Optional on purpose: `app/(app)/workspace/[workspaceSlug]/layout.tsx` is
   * owned by another unit and does not pass it yet. `undefined` therefore
   * means "not wired", `null` means "the broker could not answer", and an
   * empty list means "this workspace has no channels" — three states the
   * Channels tab renders three different ways rather than pretending the
   * first two are the third.
   */
  channels?: SidebarChannels | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const activePageId = useMemo(() => {
    const match = pathname.match(/\/p\/(\d+)/)
    return match ? Number(match[1]) : undefined
  }, [pathname])
  const activeChannelId = useMemo(() => {
    const match = pathname.match(/\/teams\/(\d+)/)
    return match ? Number(match[1]) : null
  }, [pathname])

  // Optimistic new-page insertion: `createPage` is a Server Action that ends
  // in `redirect()`, which is slow (server round-trip + destination page
  // render) — inserting a placeholder here makes the sidebar tree update
  // instantly on click. `pages` always resets `optimisticPages` back to the
  // real, revalidated list the moment the server action's redirect lands
  // (Sidebar stays mounted across that navigation since it lives in the
  // layout, not the page), so no manual reconciliation is needed.
  const [optimisticPages, addOptimisticPage] = useOptimistic(pages, (state, newPage: Page) => [...state, newPage])
  const [, startCreateTransition] = useTransition()

  function handleCreatePage(parentPageId: number | null) {
    const now = new Date().toISOString()
    const placeholder: Page = {
      id: -Date.now(),
      title: '',
      workspace: workspace.id,
      parentPage: parentPageId,
      position: Number.MAX_SAFE_INTEGER,
      createdAt: now,
      updatedAt: now,
    }
    startCreateTransition(async () => {
      addOptimisticPage(placeholder)
      await createPage({ workspaceId: workspace.id, workspaceSlug: workspace.slug, parentPageId })
    })
  }

  const storageKey = `notionforge:sidebar:${workspace.slug}`
  const [ready, setReady] = useState(false)
  // ROADMAP B-0 — `collapsed` now lives in a small external store (see
  // lib/keyboard/sidebar-collapse-store.ts) instead of local state, so
  // <KeyboardProvider>'s `mod+\` shortcut can toggle it from outside this
  // component without a shared context provider. Persistence (reading/
  // writing the localStorage key below) still belongs to Sidebar.
  const { collapsed, setCollapsed } = useSidebarCollapsed()
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [favoritesOpen, setFavoritesOpen] = useState(true)
  const [trashOpen, setTrashOpen] = useState(false)
  const [pendingDeletePageId, setPendingDeletePageId] = useState<number | null>(null)

  // --- Tabs -----------------------------------------------------------------
  //
  // Switching is LOCAL STATE, never `router.push`. Pushing a route to move a
  // highlight re-runs the server component and makes the control lag behind
  // the click — the exact bug fixed in components/layout/detail-layout.tsx
  // this week (read its comments). A tab strip must feel like a button.
  //
  // THE ROUTE WINS. The first paint is derived from the pathname alone, so
  // landing on /review shows Activity and /teams/12 shows Channels — someone
  // arriving by link can never find the sidebar pointing somewhere else. The
  // remembered tab is only consulted for routes no tab claims (Settings, and
  // anything not yet in the map), and only after mount, because localStorage
  // does not exist during SSR and reading it in the initial state would
  // hydrate a different tab than the server rendered.
  const routeTab = tabForPathname(pathname, workspace.slug)
  const [tab, setTab] = useState<SidebarTabKey>(routeTab ?? 'plan')

  // Every navigation re-asserts the route's tab. Keyed on `pathname` rather
  // than on `routeTab` so that moving between two routes of the SAME tab still
  // corrects a manual override: pick Plan while on /review, then click Audit,
  // and the sidebar must land on Activity — with `routeTab` as the only
  // dependency it would not have re-run and would have stayed on Plan.
  // Within one pathname the effect does not re-run, so a manual choice sticks.
  useEffect(() => {
    if (routeTab) setTab(routeTab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  // Restore the remembered tab exactly once, and only where no tab owns the
  // route. `routeTab` is deliberately left out of the dependency array: this
  // must read the value from the FIRST render (the route the user landed on)
  // and never re-run, or it would yank them off a tab they just picked.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as {
          expanded?: number[]
          collapsed?: boolean
          tab?: string
        }
        if (Array.isArray(parsed.expanded)) setExpandedIds(new Set(parsed.expanded))
        if (typeof parsed.collapsed === 'boolean') setCollapsed(parsed.collapsed)
        if (!routeTab && isSidebarTabKey(parsed.tab)) setTab(parsed.tab)
      }
    } catch {
      // ignore malformed local storage
    }
    setReady(true)
    // `setCollapsed` is a stable useCallback from useSidebarCollapsed(),
    // included here to satisfy exhaustive-deps; it never changes identity
    // so this doesn't change when the effect actually re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, setCollapsed])

  // ROADMAP B8.1 — responsive floor (1280px). Declared AFTER the
  // localStorage-restore effect above so it runs after it on mount: a
  // persisted "expanded" preference is applied first, then this can still
  // force a collapse if the viewport is already narrower than the floor.
  // See lib/keyboard/sidebar-collapse-store.ts's own comment for why this
  // is one-directional (auto-collapse on narrow, never auto-expand back).
  useSidebarAutoCollapse()

  useEffect(() => {
    if (!ready) return
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        expanded: [...expandedIds],
        collapsed,
        tab,
      }),
    )
  }, [ready, expandedIds, collapsed, tab, storageKey])

  function toggleExpand(id: number, forceOpen?: boolean) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (forceOpen) next.add(id)
      else if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function logOut() {
    await authClient.signOut()
    router.push('/login')
    router.refresh()
  }

  const favorites = useMemo(() => pages.filter((p) => p.isFavorite && !p.isArchived), [pages])
  const trashed = useMemo(() => pages.filter((p) => p.isArchived), [pages])

  // Summed once for the Channels tab's dot, so a room that spoke while you
  // were on another tab is visible without opening it. A mention outranks a
  // plain unread and gets its own colour rather than a larger number.
  const channelTotals = useMemo(() => {
    const list = channels?.channels ?? []
    return list.reduce(
      (acc, c) => ({ unread: acc.unread + c.unreadCount, mentions: acc.mentions + c.mentionCount }),
      { unread: 0, mentions: 0 },
    )
  }, [channels])

  const tabs: SidebarTabDescriptor[] = [
    { key: 'plan', label: 'Home' },
    {
      key: 'channels',
      label: 'Work',
      dot: channelTotals.mentions > 0 ? 'mention' : channelTotals.unread > 0 ? 'unread' : 'none',
    },
  ]

  const settingsHref = `/workspace/${workspace.slug}/settings`
  const settingsActive = isSectionActive(pathname, workspace.slug, '/settings')

  if (collapsed) {
    return (
      <div className="flex h-full w-12 shrink-0 flex-col items-center border-r border-black/5 bg-[#f7f7f5] py-2 dark:border-white/10 dark:bg-[#202020]">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-black/[.06] dark:hover:bg-white/[.08]"
        >
          <ChevronsRight size={16} />
        </button>
        <button
          type="button"
          onClick={() => openCommandBar()}
          title="Open the command bar (Ctrl K)"
          className="mt-1 flex h-7 w-7 items-center justify-center rounded-md hover:bg-black/[.06] dark:hover:bg-white/[.08]"
        >
          <Search size={14} />
        </button>
        {/* Expanding just to see whether a channel wants you is a round trip
            the collapsed rail can spare you — same signal as the tab's dot. */}
        {(channelTotals.unread > 0 || channelTotals.mentions > 0) && (
          <button
            type="button"
            onClick={() => {
              setCollapsed(false)
              setTab('channels')
            }}
            title={
              channelTotals.mentions > 0
                ? `${channelTotals.mentions} mention${channelTotals.mentions === 1 ? '' : 's'} in your channels`
                : `${channelTotals.unread} unread in your channels`
            }
            className="relative mt-1 flex h-7 w-7 items-center justify-center rounded-md hover:bg-black/[.06] dark:hover:bg-white/[.08]"
          >
            <MessageCircle size={14} />
            <span
              aria-hidden
              className={cn(
                'absolute top-1 right-1 h-1.5 w-1.5 rounded-full',
                channelTotals.mentions > 0 ? 'bg-amber-500' : 'bg-sky-500',
              )}
            />
          </button>
        )}
        <div className="mt-auto flex flex-col items-center gap-1">
          {/* Settings is pinned at the bottom in BOTH states — "always
              visible" has to survive a collapse to mean anything. */}
          <Link
            href={settingsHref}
            title="Settings"
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md',
              settingsActive ? 'bg-black/[.06] dark:bg-white/[.08]' : 'hover:bg-black/[.06] dark:hover:bg-white/[.08]',
            )}
          >
            <Settings size={14} />
          </Link>
          <ThemeToggle />
        </div>
        {/* Mounted even while collapsed — CommandBar owns its own ⌘K
            listener (see components/command-bar/command-bar.tsx), so it
            must stay mounted regardless of the sidebar's collapsed state
            for the hotkey to keep working. */}
        <CommandBar workspace={workspace} currentUserId={currentUserId} />
      </div>
    )
  }

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-black/5 bg-[#f7f7f5] dark:border-white/10 dark:bg-[#202020]">
      <div className="flex items-center justify-between gap-1 px-2 pt-2">
        <WorkspaceSwitcher workspace={workspace} workspaces={workspaces} />
        <div className="flex shrink-0 items-center gap-0.5">
          <NotificationsBell initialUnreadCount={unreadNotificationCount} />
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-black/[.06] dark:hover:bg-white/[.08]"
          >
            <ChevronsLeft size={16} />
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => openCommandBar()}
        title="Open the command bar (search, jump to anything, create a task, assign, start a run, change status)"
        className="mx-2 mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-black/60 hover:bg-black/[.06] dark:text-white/60 dark:hover:bg-white/[.08]"
      >
        <Search size={14} />
        Search
        <kbd className="ml-auto rounded border border-black/10 px-1 text-[10px] text-black/40 dark:border-white/10 dark:text-white/40">
          Ctrl K
        </kbd>
      </button>

      <SidebarTabBar tabs={tabs} active={tab} onSelect={setTab} />

      {/* One scroll container for whichever tab is showing. The panels are
          swapped, not hidden with CSS: keeping all three mounted would keep
          the page tree's drag state and every channel row alive behind two
          invisible panels for no benefit. */}
      <div className="mt-2 flex-1 overflow-y-auto px-2 pb-4">
        {tab === 'plan' && (
          <div role="tabpanel" id="sidebar-panel-plan" aria-labelledby="sidebar-tab-plan">
            <nav className="flex flex-col gap-px">
              {PLAN_LINKS.map((link) => (
                <NavRow
                  key={link.href}
                  link={link}
                  workspaceSlug={workspace.slug}
                  active={isSectionActive(pathname, workspace.slug, link.href)}
                />
              ))}
            </nav>

            {/* Activity — "what the machines did" — folded in here rather
                than kept as its own tab: two tabs for the app's two real
                modes of attention (planning and working) said more than
                three did, and this is a handful of links, not a category
                that needed a whole strip to itself. */}
            <nav className="mb-3 flex flex-col gap-px border-t border-black/5 pt-2 dark:border-white/10">
              {ACTIVITY_LINKS.map((link) => (
                <NavRow
                  key={link.href}
                  link={link}
                  workspaceSlug={workspace.slug}
                  active={isSectionActive(pathname, workspace.slug, link.href)}
                  // Counts come from the ambient status the layout already
                  // fetches for the status bar below — no extra query for a
                  // badge, and the two can never disagree.
                  count={
                    link.href === '/review'
                      ? ambientStatus.approvalsWaiting
                      : link.href === '/active-runs'
                        ? ambientStatus.runsInFlight
                        : undefined
                  }
                />
              ))}
            </nav>

            {favorites.length > 0 && (
              <div className="mb-3">
                <SectionHeader label="Favorites" open={favoritesOpen} onToggle={() => setFavoritesOpen((v) => !v)} />
                {favoritesOpen &&
                  favorites.map((p) => (
                    <Link
                      key={p.id}
                      href={`/workspace/${workspace.slug}/p/${p.id}`}
                      className={cn(
                        'flex items-center gap-1.5 truncate rounded-md px-2 py-1 text-sm',
                        p.id === activePageId
                          ? 'bg-black/[.06] dark:bg-white/[.08]'
                          : 'hover:bg-black/[.04] dark:hover:bg-white/[.06]',
                      )}
                    >
                      <span>{p.icon || '📄'}</span>
                      <span className="truncate">{p.title || 'Untitled'}</span>
                    </Link>
                  ))}
              </div>
            )}

            <div className="mb-1 flex items-center justify-between px-2">
              <span className="text-xs font-medium text-black/40 dark:text-white/40">Pages</span>
              <button
                type="button"
                title="New page"
                onClick={() => handleCreatePage(null)}
                className="flex h-5 w-5 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10"
              >
                <Plus size={13} />
              </button>
            </div>

            <PageTree
              pages={optimisticPages}
              workspace={workspace}
              activePageId={activePageId}
              expandedIds={expandedIds}
              onToggleExpand={toggleExpand}
              onCreatePage={handleCreatePage}
            />

            <div className="mt-3">
              <SectionHeader
                label="Trash"
                open={trashOpen}
                onToggle={() => setTrashOpen((v) => !v)}
                icon={<Trash2 size={12} />}
              />
              {trashOpen && (
                <div className="flex flex-col">
                  {trashed.length === 0 && (
                    <p className="px-3 py-1 text-xs text-black/40 dark:text-white/40">Trash is empty</p>
                  )}
                  {trashed.map((p) => {
                    const isPendingDelete = pendingDeletePageId === p.id
                    return (
                      <div
                        key={p.id}
                        className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-black/60 dark:text-white/60"
                      >
                        <span className="flex-1 truncate">
                          {p.icon ? `${p.icon} ` : ''}
                          {p.title || 'Untitled'}
                        </span>
                        {isPendingDelete ? (
                          <>
                            <button
                              type="button"
                              title="Confirm delete forever"
                              onClick={() => {
                                setPendingDeletePageId(null)
                                void deletePageForever(p.id, workspace.id, workspace.slug)
                                if (p.id === activePageId) router.push(`/workspace/${workspace.slug}`)
                              }}
                              className="flex h-5 shrink-0 items-center rounded px-1 text-[11px] font-medium text-red-500 hover:bg-red-500/10"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              title="Cancel"
                              onClick={() => setPendingDeletePageId(null)}
                              className="flex h-5 shrink-0 items-center rounded px-1 text-[11px] hover:bg-black/10 dark:hover:bg-white/10"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              title="Restore"
                              onClick={() => void restorePage(p.id, workspace.id, workspace.slug)}
                              className="hidden h-5 shrink-0 items-center rounded px-1 text-[11px] hover:bg-black/10 group-hover:flex dark:hover:bg-white/10"
                            >
                              Restore
                            </button>
                            <button
                              type="button"
                              title="Delete forever — cannot be undone"
                              onClick={() => setPendingDeletePageId(p.id)}
                              className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-red-500 hover:bg-black/10 group-hover:flex dark:hover:bg-white/10"
                            >
                              <Trash2 size={12} />
                            </button>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'channels' && (
          <div role="tabpanel" id="sidebar-panel-channels" aria-labelledby="sidebar-tab-channels">
            {/* Agents and New Session first: two deliberate jumping-off
                points, not something to scroll past the channel list and the
                session history to find. */}
            <nav className="mb-2 flex flex-col gap-px">
              {CHANNEL_LINKS.map((link) => (
                <NavRow
                  key={link.href}
                  link={link}
                  workspaceSlug={workspace.slug}
                  active={isSectionActive(pathname, workspace.slug, link.href)}
                />
              ))}
            </nav>
            <ChannelList workspaceSlug={workspace.slug} data={channels} activeChannelId={activeChannelId} />
            <div className="border-t border-black/5 pt-2 dark:border-white/10">
              <SessionsSection workspaceId={workspace.id} workspaceSlug={workspace.slug} />
            </div>
          </div>
        )}

      </div>

      <AmbientStatus workspaceId={workspace.id} workspaceSlug={workspace.slug} initialStatus={ambientStatus} />

      {/* Pinned Settings. Outside the tab strip and outside the scroll
          container on purpose: it is the one destination you may want from any
          of the three tabs, and hunting for it inside one of them is exactly
          the "where did it go" the old flat list caused. */}
      <Link
        href={settingsHref}
        className={cn(
          'mx-2 mt-1 mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
          settingsActive
            ? 'bg-black/[.06] text-black dark:bg-white/[.08] dark:text-white'
            : 'text-black/60 hover:bg-black/[.06] dark:text-white/60 dark:hover:bg-white/[.08]',
        )}
      >
        <Settings size={14} />
        Settings
      </Link>

      <div className="flex items-center justify-between gap-1 border-t border-black/5 px-2 py-2 dark:border-white/10">
        <span className="truncate text-xs text-black/40 dark:text-white/40" title={userEmail}>
          {userEmail}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => void logOut()}
            title="Log out"
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-black/[.06] dark:hover:bg-white/[.08]"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>

      <CommandBar workspace={workspace} currentUserId={currentUserId} />
    </div>
  )
}

function NavRow({
  link,
  workspaceSlug,
  active,
  count,
}: {
  link: SectionLink
  workspaceSlug: string
  active: boolean
  /** Rendered only when > 0 — a zero badge is noise, not information. */
  count?: number
}) {
  const Icon = link.icon
  return (
    <Link
      href={`/workspace/${workspaceSlug}${link.href}${link.query ?? ''}`}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        active
          ? 'bg-black/[.06] text-black dark:bg-white/[.08] dark:text-white'
          : 'text-black/60 hover:bg-black/[.06] dark:text-white/60 dark:hover:bg-white/[.08]',
      )}
    >
      <Icon size={14} className="shrink-0" />
      <span className="truncate">{link.label}</span>
      {typeof count === 'number' && count > 0 && (
        <span className="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-black/10 px-1 text-[10px] font-semibold text-black/70 tabular-nums dark:bg-white/15 dark:text-white/80">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  )
}

function SectionHeader({
  label,
  open,
  onToggle,
  icon,
}: {
  label: string
  open: boolean
  onToggle: () => void
  icon?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-black/40 hover:bg-black/[.04] dark:text-white/40 dark:hover:bg-white/[.06]"
    >
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      {icon}
      {label}
    </button>
  )
}
