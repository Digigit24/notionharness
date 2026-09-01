'use client'

import { useEffect, useMemo, useOptimistic, useState, useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, LogOut, Plus, Search, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ThemeToggle } from '@/components/theme/theme-toggle'
import { authClient } from '@/lib/auth-client'
import { PageTree } from './page-tree'
import { WorkspaceSwitcher } from './workspace-switcher'
import { SearchModal } from './search-modal'
import { createPage, deletePageForever, restorePage } from '@/app/(app)/actions'
import type { Page, Workspace } from '@/payload-types'

export function Sidebar({
  workspace,
  workspaces,
  pages,
  userEmail,
}: {
  workspace: Workspace
  workspaces: Workspace[]
  pages: Page[]
  userEmail: string
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
  const [collapsed, setCollapsed] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [favoritesOpen, setFavoritesOpen] = useState(true)
  const [trashOpen, setTrashOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as { expanded?: number[]; collapsed?: boolean }
        if (Array.isArray(parsed.expanded)) setExpandedIds(new Set(parsed.expanded))
        if (typeof parsed.collapsed === 'boolean') setCollapsed(parsed.collapsed)
      }
    } catch {
      // ignore malformed local storage
    }
    setReady(true)
  }, [storageKey])

  useEffect(() => {
    if (!ready) return
    localStorage.setItem(storageKey, JSON.stringify({ expanded: [...expandedIds], collapsed }))
  }, [ready, expandedIds, collapsed, storageKey])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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
        <ThemeToggle className="mt-auto" />
      </div>
    )
  }

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-black/5 bg-[#f7f7f5] dark:border-white/10 dark:bg-[#202020]">
      <div className="flex items-center justify-between gap-1 px-2 pt-2">
        <WorkspaceSwitcher workspace={workspace} workspaces={workspaces} />
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-black/[.06] dark:hover:bg-white/[.08]"
        >
          <ChevronsLeft size={16} />
        </button>
      </div>

      <button
        type="button"
        onClick={() => setSearchOpen(true)}
        className="mx-2 mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-black/60 hover:bg-black/[.06] dark:text-white/60 dark:hover:bg-white/[.08]"
      >
        <Search size={14} />
        Search
        <kbd className="ml-auto rounded border border-black/10 px-1 text-[10px] text-black/40 dark:border-white/10 dark:text-white/40">
          Ctrl K
        </kbd>
      </button>

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

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} workspace={workspace} />
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
