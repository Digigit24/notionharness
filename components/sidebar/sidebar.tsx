'use client'

import { useEffect, useMemo, useOptimistic, useState, useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FolderKanban,
  History,
  Home,
  Inbox,
  ListTodo,
  LogOut,
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
import { CommandBar } from '@/components/command-bar/command-bar'
import { openCommandBar } from '@/lib/command-bar-bus'
import { NotificationsBell } from '@/components/notifications/notifications-bell'
import { AmbientStatus } from '@/components/shell/ambient-status'
import type { AmbientStatus as AmbientStatusData } from '@/app/(app)/workspace/[workspaceSlug]/actions'
import { ModeSwitcher } from './mode-switcher'
import { useSidebarCollapsed } from '@/lib/keyboard/sidebar-collapse-store'
import { createPage, deletePageForever, restorePage } from '@/app/(app)/actions'
import type { Page, Workspace } from '@/payload-types'
import { WORK_MODE_SUBROUTES, type WorkSubRoute } from '@/lib/entity-links'

/**
 * ROADMAP B-0 (Frame) — the Section level of the three-tier
 * Workspace / Section / Entity navigation model. The full target set
 * per the B-0 design is Home, Inbox, Projects, Tasks, Agents, Ask,
 * Settings; `href` is workspace-relative (empty string = the workspace
 * root, i.e. "Home"). Only sections with a real, already-existing route
 * are listed here:
 *
 *   Home     -> `/workspace/:slug` (the existing WorkspaceHome landing page)
 *   Inbox    -> `/workspace/:slug/inbox` (existing)
 *   Tasks    -> `/workspace/:slug/tasks` (existing)
 *   Projects -> `/workspace/:slug/projects` (ROADMAP B-1 — the list route
 *               this batch added specifically so the new project detail
 *               page isn't reachable only via a task's project picker;
 *               previously NOT LINKED, no route existed).
 *   Agents   -> `/workspace/:slug/agents` (existing)
 *   Ask      -> NOT LINKED. No route exists yet.
 *   Settings -> `/workspace/:slug/settings` (ROADMAP B7.2, Batch B-6
 *               "Finish" — previously NOT LINKED, no route existed).
 *   Audit    -> `/workspace/:slug/audit` (ROADMAP B7.3, same batch — not
 *               part of the original B-0 target set, added because the
 *               workspace-wide audit log needs to be reachable from
 *               somewhere real, not an orphaned route).
 */
const SECTION_LINKS: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: '', label: 'Home', icon: Home },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/tasks', label: 'Tasks', icon: ListTodo },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/audit', label: 'Audit', icon: History },
  { href: '/settings', label: 'Settings', icon: Settings },
]

/** Is `pathname` the active route for a given section `href` (workspace-relative,
 * '' meaning the workspace root/Home)? Home only matches the bare workspace
 * landing page, never a sub-route, so it can't shadow Inbox/Tasks/Agents below it. */
function isSectionActive(pathname: string, workspaceSlug: string, href: string): boolean {
  if (href === '') {
    return new RegExp(`^/workspace/${workspaceSlug}/?$`).test(pathname)
  }
  return pathname.endsWith(href)
}

export function Sidebar({
  workspace,
  workspaces,
  pages,
  userEmail,
  currentUserId,
  unreadNotificationCount,
  ambientStatus,
}: {
  workspace: Workspace
  workspaces: Workspace[]
  pages: Page[]
  userEmail: string
  currentUserId: number | null
  unreadNotificationCount: number
  ambientStatus: AmbientStatusData
}) {
  const router = useRouter()
  const pathname = usePathname()
  const activePageId = useMemo(() => {
    const match = pathname.match(/\/p\/(\d+)/)
    return match ? Number(match[1]) : undefined
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
  // ROADMAP P6.5 Q3 — remember which Work sub-route the user last visited
  // so the ModeSwitcher's Work pill lands them where they were, not at the
  // inbox default. Null on first paint (SSR + before localStorage sync).
  const [lastWorkSubRoute, setLastWorkSubRoute] = useState<WorkSubRoute | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as {
          expanded?: number[]
          collapsed?: boolean
          lastWorkSubRoute?: string
        }
        if (Array.isArray(parsed.expanded)) setExpandedIds(new Set(parsed.expanded))
        if (typeof parsed.collapsed === 'boolean') setCollapsed(parsed.collapsed)
        if (
          typeof parsed.lastWorkSubRoute === 'string' &&
          (WORK_MODE_SUBROUTES as readonly string[]).includes(parsed.lastWorkSubRoute)
        ) {
          setLastWorkSubRoute(parsed.lastWorkSubRoute as WorkSubRoute)
        }
      }
    } catch {
      // ignore malformed local storage
    }
    setReady(true)
    // `setCollapsed` is a stable useCallback from useSidebarCollapsed(),
    // included here to satisfy exhaustive-deps; it never changes identity
    // so this doesn't change when the effect actually re-runs.
  }, [storageKey, setCollapsed])

  useEffect(() => {
    if (!ready) return
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        expanded: [...expandedIds],
        collapsed,
        lastWorkSubRoute: lastWorkSubRoute ?? undefined,
      }),
    )
  }, [ready, expandedIds, collapsed, lastWorkSubRoute, storageKey])

  // Detect the current Work sub-route from the URL and persist it.
  // Mirrors the ModeSwitcher's own parser so the two stay in sync;
  // keep them structurally separate to avoid a circular import.
  useEffect(() => {
    const sub = matchWorkSubRoute(pathname, workspace.slug)
    if (sub && sub !== lastWorkSubRoute) {
      setLastWorkSubRoute(sub)
    }
  }, [pathname, workspace.slug, lastWorkSubRoute])

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
        <ThemeToggle className="mt-auto" />
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

      {/* ROADMAP P6.5 — three-way Plan/Work/Review mode switcher. Lives on
          its own row under the workspace header because the sidebar is only
          256px wide and WorkspaceSwitcher + notifications + collapse button
          already fill the header row. Mounted in this position so it's the
          second thing the user sees, above the per-mode navigation links. */}
      <div className="px-2 pt-2">
        <ModeSwitcher
          workspaceSlug={workspace.slug}
          lastWorkSubRoute={lastWorkSubRoute}
        />
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

      {/* ROADMAP B-0 (Frame) / B-1 (project detail) — Section-level nav, the
          middle of the three-tier Workspace / Section / Entity navigation
          model. The target section set is Home, Inbox, Projects, Tasks,
          Agents, Ask, Settings; only sections with a real existing route are
          linked here — Ask and Settings have no dedicated page yet (building
          those is other batches' job), so they're omitted rather than
          invented. Entity-level navigation (a specific page/task/agent/run)
          lives in the page tree below and in per-page breadcrumbs, not in
          this list. */}
      {SECTION_LINKS.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={`/workspace/${workspace.slug}${href}`}
          className={cn(
            'mx-2 mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
            isSectionActive(pathname, workspace.slug, href)
              ? 'bg-black/[.06] dark:bg-white/[.08]'
              : 'text-black/60 hover:bg-black/[.06] dark:text-white/60 dark:hover:bg-white/[.08]',
          )}
        >
          <Icon size={14} />
          {label}
        </Link>
      ))}

      <div className="mt-2 flex-1 overflow-y-auto px-2 pb-4">
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
              {trashed.map((p) => (
                <div
                  key={p.id}
                  className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-black/60 dark:text-white/60"
                >
                  <span className="flex-1 truncate">
                    {p.icon ? `${p.icon} ` : ''}
                    {p.title || 'Untitled'}
                  </span>
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
                    title="Delete forever"
                    onClick={() => {
                      if (confirm(`Delete "${p.title || 'Untitled'}" forever? This cannot be undone.`)) {
                        void deletePageForever(p.id, workspace.id, workspace.slug)
                        if (p.id === activePageId) router.push(`/workspace/${workspace.slug}`)
                      }
                    }}
                    className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-red-500 hover:bg-black/10 group-hover:flex dark:hover:bg-white/10"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AmbientStatus workspaceId={workspace.id} workspaceSlug={workspace.slug} initialStatus={ambientStatus} />

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

/**
 * Detect the Work sub-route for the current pathname. Returns `null`
 * for paths that aren't a Work surface (the ModeSwitcher uses the same
 * set of routes to highlight Work as active, so the two stay in sync).
 *
 * Kept structurally separate from `ModeSwitcher.parseLocation` to avoid
 * a circular import — the sidebar lives in this file and the switcher
 * lives in `mode-switcher.tsx`.
 */
function matchWorkSubRoute(pathname: string, workspaceSlug: string): WorkSubRoute | null {
  const root = `/workspace/${workspaceSlug}/`
  if (!pathname.startsWith(root)) return null
  const tail = pathname.slice(root.length).split('?')[0]
  if ((WORK_MODE_SUBROUTES as readonly string[]).includes(tail)) {
    return tail as WorkSubRoute
  }
  return null
}
