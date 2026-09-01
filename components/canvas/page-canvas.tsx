'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronRight, Lock, LockOpen, Maximize2, Minimize2, MoreHorizontal, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PopoverMenu } from '@/components/ui/popover-menu'
import { EmojiPicker } from './emoji-picker'
import { CoverPicker } from './cover-picker'
import { BlockSuiteEditor } from '@/components/editor/BlockSuiteEditor'
import { ThemeToggle } from '@/components/theme/theme-toggle'
import {
  archivePage,
  renamePage,
  setPageCover,
  setPageIcon,
  toggleFullWidth,
  toggleLocked,
} from '@/app/(app)/actions'
import type { Page, Workspace } from '@/payload-types'
import { TeableProperties } from '@/components/database/teable-properties'

export function PageCanvas({
  workspace,
  page,
  breadcrumbChain,
}: {
  workspace: Workspace
  page: Page
  breadcrumbChain: Page[]
}) {
  const router = useRouter()
  const [title, setTitle] = useState(page.title)
  const [rowFields, setRowFields] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    if (!page.linkedTeableTableId || !page.linkedTeableRecordId) return
    fetch(`/api/teable/tables/${page.linkedTeableTableId}/records/${page.linkedTeableRecordId}`).then((res) => res.ok ? res.json() : null).then((record) => setRowFields(record?.fields || null)).catch(() => setRowFields(null))
  }, [page.linkedTeableRecordId, page.linkedTeableTableId])

  // Local optimistic state, same reasoning as `title` above: `page` is a
  // server-rendered prop with no reactivity of its own, so without a local
  // copy the *active* tab has to wait on a full `router.refresh()` round-trip
  // just to reflect its own click. `revalidatePath(..., 'layout')` in the
  // server actions remains the correctness fallback for a fresh load / other
  // tabs — this is purely about instant feedback in the tab that clicked.
  const [locked, setLocked] = useState(!!page.isLocked)
  const [fullWidth, setFullWidth] = useState(!!page.isFullWidth)
  const isGradientCover = page.coverImage?.startsWith('gradient:')

  return (
    <div className="flex h-full flex-1 flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center justify-between gap-2 border-b border-black/5 bg-white/90 px-4 backdrop-blur dark:border-white/10 dark:bg-[#191919]/90">
        <nav className="flex min-w-0 items-center gap-1 text-sm text-black/50 dark:text-white/50">
          <Link href={`/workspace/${workspace.slug}`} className="shrink-0 truncate hover:text-black/80 dark:hover:text-white/80">
            {workspace.name}
          </Link>
          {breadcrumbChain.map((p) => (
            <span key={p.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight size={13} className="shrink-0" />
              <Link
                href={`/workspace/${workspace.slug}/p/${p.id}`}
                className={cn(
                  'truncate hover:text-black/80 dark:hover:text-white/80',
                  p.id === page.id && 'text-black/80 dark:text-white/80',
                )}
              >
                {p.icon ? `${p.icon} ` : ''}
                {p.title || 'Untitled'}
              </Link>
            </span>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle />

          <PopoverMenu
            align="end"
            trigger={({ toggle }) => (
              <button
                type="button"
                onClick={toggle}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-black/[.06] dark:hover:bg-white/[.08]"
              >
                <MoreHorizontal size={16} />
              </button>
            )}
          >
              {(close) => (
              <div className="flex flex-col text-sm">
                <button
                  type="button"
                  onClick={() => {
                    close()
                    setFullWidth(!fullWidth)
                    void toggleFullWidth(page.id, workspace.slug, !fullWidth)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-black/[.06] dark:hover:bg-white/[.08]"
                >
                  {fullWidth ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  {fullWidth ? 'Small width' : 'Full width'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    close()
                    setLocked(!locked)
                    void toggleLocked(page.id, workspace.slug, !locked)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-black/[.06] dark:hover:bg-white/[.08]"
                >
                  {locked ? <LockOpen size={14} /> : <Lock size={14} />}
                  {locked ? 'Unlock page' : 'Lock page'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    close()
                    void archivePage(page.id, workspace.id, workspace.slug)
                    router.push(`/workspace/${workspace.slug}`)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-red-600 hover:bg-black/[.06] dark:text-red-400 dark:hover:bg-white/[.08]"
                >
                  <Trash2 size={14} />
                  Move to Trash
                </button>
              </div>
            )}
          </PopoverMenu>
        </div>
      </header>

      {page.coverImage && (
        <div
          className={cn('group relative h-40 w-full', isGradientCover && `bg-gradient-to-br ${page.coverImage.replace('gradient:', '')}`)}
          style={!isGradientCover ? { backgroundImage: `url(${page.coverImage})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
        >
          {!locked && (
            <div className="absolute bottom-3 right-3 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
              <CoverPicker trigger="Change cover" onSelect={(v) => void setPageCover(page.id, workspace.slug, v)} />
              <button
                type="button"
                onClick={() => void setPageCover(page.id, workspace.slug, null)}
                className="rounded-md bg-black/40 px-2 py-1 text-xs text-white hover:bg-black/60"
              >
                Remove
              </button>
            </div>
          )}
        </div>
      )}

      <div
        className={cn(
          'mx-auto w-full flex-1 pb-24 pt-8',
          fullWidth ? 'max-w-none px-4 md:px-6' : 'max-w-4xl px-6 md:px-12',
        )}
      >
        <div className="mb-1 flex flex-col gap-2">
          {page.icon &&
            (locked ? (
              <span className="w-fit text-6xl leading-none">{page.icon}</span>
            ) : (
              <EmojiPicker
                value={page.icon}
                onSelect={(emoji) => void setPageIcon(page.id, workspace.slug, emoji)}
                onClear={() => void setPageIcon(page.id, workspace.slug, null)}
              />
            ))}

          {!locked && (!page.icon || !page.coverImage) && (
            <div className="flex gap-2">
              {!page.icon && (
                <EmojiPicker
                  value={null}
                  onSelect={(emoji) => void setPageIcon(page.id, workspace.slug, emoji)}
                  onClear={() => void setPageIcon(page.id, workspace.slug, null)}
                />
              )}
              {!page.coverImage && (
                <CoverPicker trigger="Add cover" onSelect={(v) => void setPageCover(page.id, workspace.slug, v)} />
              )}
            </div>
          )}
        </div>

        <input
          value={title}
          disabled={locked}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title !== page.title) void renamePage(page.id, workspace.slug, title)
          }}
          placeholder="Untitled"
          className="page-canvas-title w-full bg-transparent text-5xl font-bold leading-tight outline-none placeholder:text-black/20 disabled:cursor-not-allowed dark:placeholder:text-white/20"
        />

        {rowFields && <TeableProperties fields={rowFields} />}

        <div className="mt-8">
          <BlockSuiteEditor
            key={page.id}
            pageId={page.id}
            workspaceId={workspace.id}
            workspaceSlug={workspace.slug}
            initialTitle={page.title || 'Untitled'}
            initialDocState={page.docState}
            locked={locked}
          />
        </div>
      </div>
    </div>
  )
}
