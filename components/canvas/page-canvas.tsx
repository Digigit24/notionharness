'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Lock, LockOpen, Maximize2, Minimize2, MoreHorizontal, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PopoverMenu } from '@/components/ui/popover-menu'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { EmojiPicker } from './emoji-picker'
import { CoverPicker } from './cover-picker'
import { BlockSuiteEditor } from '@/components/editor/BlockSuiteEditor'
import { SuggestionBar } from '@/components/editor/suggestions/suggestion-bar'
import { PageDockedPanel } from '@/components/editor/agent-thread/page-docked-panel'
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
import { RowProperties } from '@/components/database/row-properties'
import type { PageProvenanceMap } from '@/lib/provenance'
import { PageProvenanceStrip, type ProvenanceTimeFilter } from '@/components/canvas/page-provenance-strip'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function PageCanvas({
  workspace,
  page,
  breadcrumbChain,
  provenance,
}: {
  workspace: Workspace
  page: Page
  breadcrumbChain: Page[]
  // ROADMAP B-2 — resolved server-side (`lib/provenance.ts`) once per page
  // load and threaded down to both the "written by" strip and the
  // hover-chip/time-filter machinery inside `BlockSuiteEditor`, so there is
  // exactly one provenance read per page view, not one per feature.
  provenance: PageProvenanceMap
}) {
  const [timeFilter, setTimeFilter] = useState<ProvenanceTimeFilter>('all')
  const staleBeforeMs = timeFilter === 'week' ? Date.now() - WEEK_MS : null
  const router = useRouter()
  const [title, setTitle] = useState(page.title)
  const [rowFields, setRowFields] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    if (!page.linkedSourceType || !page.linkedSourceId || !page.linkedRecordId) return
    const path =
      page.linkedSourceType === 'userDatabase'
        ? `/api/user-databases/${page.linkedSourceId}/rows/${page.linkedRecordId}`
        : `/api/payload-datasource/${page.linkedSourceId}/records/${page.linkedRecordId}`
    fetch(path)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setRowFields(body?.doc?.cells ?? body?.doc?.fields ?? null))
      .catch(() => setRowFields(null))
  }, [page.linkedSourceType, page.linkedSourceId, page.linkedRecordId])

  // Local optimistic state, same reasoning as `title` above: `page` is a
  // server-rendered prop with no reactivity of its own, so without a local
  // copy the *active* tab has to wait on a full `router.refresh()` round-trip
  // just to reflect its own click. `revalidatePath(..., 'layout')` in the
  // server actions remains the correctness fallback for a fresh load / other
  // tabs — this is purely about instant feedback in the tab that clicked.
  const [locked, setLocked] = useState(!!page.isLocked)
  const [fullWidth, setFullWidth] = useState(!!page.isFullWidth)
  const isGradientCover = page.coverImage?.startsWith('gradient:')

  // ROADMAP B-1 (Detail) — page view is a full-bleed document editor, not a
  // tabbed entity like an agent/run/task, so it does NOT adopt
  // <DetailLayout>'s tab system: there's no real second "view" of a page to
  // put in a second tab, and a persistent right rail would eat horizontal
  // space from the writing surface for no benefit. The one piece of
  // <DetailLayout>'s conformance that *does* genuinely fit is the
  // breadcrumb — this used to be a hand-rolled duplicate of exactly what
  // <Breadcrumbs> (components/nav/breadcrumbs.tsx, already used on
  // agents/page.tsx) does; swapped in here instead of maintaining two
  // implementations of the same "workspace / ancestor chain / current page"
  // breadcrumb.
  const breadcrumbSegments = useMemo(
    () => [
      { label: workspace.name, href: `/workspace/${workspace.slug}` },
      ...breadcrumbChain.map((p, idx) => ({
        label: `${p.icon ? `${p.icon} ` : ''}${p.title || 'Untitled'}`,
        href: idx === breadcrumbChain.length - 1 ? undefined : `/workspace/${workspace.slug}/p/${p.id}`,
      })),
    ],
    [workspace.name, workspace.slug, breadcrumbChain],
  )

  return (
    // ROADMAP B-3 "Surface" — the docked agent panel (`PageDockedPanel`) is a
    // sibling of the scrollable content column, not nested inside it: it
    // must stay pinned to the viewport height while the document column
    // scrolls independently, same reason the outer element used to be
    // `overflow-y-auto` by itself before this row wrapper existed.
    <div className="flex h-full flex-1 overflow-hidden">
      <div className="flex h-full flex-1 flex-col overflow-y-auto">
        <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center justify-between gap-2 border-b border-black/5 bg-white/90 px-4 backdrop-blur dark:border-white/10 dark:bg-[#191919]/90">
          <Breadcrumbs segments={breadcrumbSegments} className="min-w-0" />

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

          {rowFields && <RowProperties fields={rowFields} />}

          <PageProvenanceStrip
            provenance={provenance}
            workspaceSlug={workspace.slug}
            timeFilter={timeFilter}
            onTimeFilterChange={setTimeFilter}
          />

          <div className="mt-8">
            <BlockSuiteEditor
              key={page.id}
              pageId={page.id}
              workspaceId={workspace.id}
              workspaceSlug={workspace.slug}
              initialTitle={page.title || 'Untitled'}
              provenance={provenance}
              staleBeforeMs={staleBeforeMs}
              initialDocState={page.docState}
              locked={locked}
            />
          </div>
        </div>

        {/* ROADMAP B3.1 (Batch B-2, suggestions mode) — deliberately outside the
            `max-w-4xl`/`max-w-none` content column above: a floating review bar
            reads better anchored to the viewport than the (possibly narrow)
            prose column. Renders nothing when the page has no pending agent
            suggestions (own internal poll, see suggestion-bar.tsx). */}
        <SuggestionBar pageId={page.id} />
      </div>

      <PageDockedPanel
        pageId={page.id}
        workspaceId={workspace.id}
        pageTitle={page.title || 'Untitled'}
        pageContent={page.plainTextContent ?? null}
      />
    </div>
  )
}
