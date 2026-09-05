'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Lock, LockOpen, Maximize2, Minimize2, MoreHorizontal, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/hooks/use-toast'
import { PopoverMenu } from '@/components/ui/popover-menu'
import { PaneBoundary } from '@/components/ui/pane-boundary'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { PageOriginHeader } from '@/components/canvas/page-origin-header'
import type { PageOrigin } from '@/lib/page-origin'
import { EmojiPicker } from './emoji-picker'
import { CoverPicker } from './cover-picker'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'
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

/**
 * R12-P2.4 / R13-P3.3 - the editor arrives after the page shell, not with it.
 *
 * Measured: this route is 564 kB first load, the heaviest in the app, and the
 * editor is nearly all of it. Splitting it means the title, the breadcrumb, the
 * origin header and the row properties paint immediately and the canvas
 * hydrates behind them - which is the whole difference between "the page is
 * loading" and "the app is stuck".
 *
 * `ssr: false` because BlockSuite is a browser editor with no useful server
 * render, and the placeholder is shaped like a document rather than being a
 * spinner.
 */
const BlockSuiteEditor = dynamic(
  () => import('@/components/editor/BlockSuiteEditor').then((m) => m.BlockSuiteEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-col gap-3 py-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    ),
  },
)


const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function PageCanvas({
  workspace,
  page,
  breadcrumbChain,
  origin,
  provenance,
}: {
  workspace: Workspace
  page: Page
  breadcrumbChain: Page[]
  /** R7.4 — what this page was created FOR (a table row, a task), when it was
   * created for something. Null for an ordinary page, which needs no strip. */
  origin?: PageOrigin
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
  // Same reasoning, for the icon and cover: both used to call their server
  // action directly off `page.icon`/`page.coverImage` with no local mirror,
  // so the emoji/cover you just picked did not actually appear until
  // `revalidatePath` (previously ALSO missing its `'layout'` argument, so it
  // invalidated only the workspace index, never this open page — see that
  // action's own comment) round-tripped and a fresh render landed. Painted
  // here immediately instead; reverted if the server call fails.
  const [icon, setIcon] = useState(page.icon ?? null)
  const [coverImage, setCoverImage] = useState(page.coverImage ?? null)
  const isGradientCover = coverImage?.startsWith('gradient:')
  // `media:<id>` — an uploaded cover, resolved to this app's own byte-serving
  // route (never Payload's own `/api/media/file/<name>`, which is gated on
  // `req.user` and always null for a Better-Auth-only browser session — see
  // `collections/Media.ts`'s header comment). A gradient or a pasted external
  // URL pass through unchanged.
  const coverImageUrl = coverImage?.startsWith('media:') ? `/api/media/${coverImage.slice('media:'.length)}/file` : coverImage

  async function updateIcon(next: string | null) {
    const previous = icon
    setIcon(next)
    try {
      await setPageIcon(page.id, workspace.slug, next)
    } catch (err) {
      setIcon(previous)
      // A silent revert here is indistinguishable from "nothing happened" —
      // the exact failure a person watching their own icon flash and vanish
      // needs to see, not swallow. A thrown Next.js server-action error has
      // no readable `.message` in production (only a `digest`), so the
      // fallback line names the one cause that produces exactly that: this
      // page was open in a tab from before the last deploy/restart.
      toast({
        title: "Couldn't update the icon",
        description:
          err instanceof Error && err.message ? err.message : 'Try reloading the page — it may be running an older version of the app.',
        variant: 'destructive',
      })
    }
  }

  async function updateCover(next: string | null) {
    const previous = coverImage
    setCoverImage(next)
    try {
      await setPageCover(page.id, workspace.slug, next)
    } catch (err) {
      setCoverImage(previous)
      toast({
        title: "Couldn't update the cover",
        description:
          err instanceof Error && err.message ? err.message : 'Try reloading the page — it may be running an older version of the app.',
        variant: 'destructive',
      })
    }
  }

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

        {coverImage && (
          <div
            className={cn('group relative h-40 w-full', isGradientCover && `bg-gradient-to-br ${coverImage.replace('gradient:', '')}`)}
            style={!isGradientCover ? { backgroundImage: `url(${coverImageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
          >
            {!locked && (
              <div className="absolute bottom-3 right-3 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                <CoverPicker workspaceId={workspace.id} trigger="Change cover" onSelect={(v) => void updateCover(v)} />
                <button
                  type="button"
                  onClick={() => void updateCover(null)}
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
          {/* R7.4 — a row page or task document says where it belongs. These
              are kept out of the sidebar tree on purpose (they would bury it),
              which left them with no on-screen context at all. */}
          <PageOriginHeader workspaceSlug={workspace.slug} origin={origin ?? null} />

          <div className="mb-1 flex flex-col gap-2">
            {icon &&
              (locked ? (
                <span className="w-fit text-6xl leading-none">{icon}</span>
              ) : (
                <EmojiPicker
                  value={icon}
                  onSelect={(emoji) => void updateIcon(emoji)}
                  onClear={() => void updateIcon(null)}
                />
              ))}

            {!locked && (!icon || !coverImage) && (
              <div className="flex gap-2">
                {!icon && (
                  <EmojiPicker
                    value={null}
                    onSelect={(emoji) => void updateIcon(emoji)}
                    onClear={() => void updateIcon(null)}
                  />
                )}
                {!coverImage && (
                  <CoverPicker workspaceId={workspace.id} trigger="Add cover" onSelect={(v) => void updateCover(v)} />
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
            aria-label="Page title"
            className="page-canvas-title w-full rounded-sm bg-transparent text-5xl font-bold leading-tight outline-none placeholder:text-black/20 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed dark:placeholder:text-white/20"
          />

          {rowFields && <RowProperties fields={rowFields} />}

          <PageProvenanceStrip
            provenance={provenance}
            workspaceSlug={workspace.slug}
            timeFilter={timeFilter}
            onTimeFilterChange={setTimeFilter}
          />

          {/* R12-P1.2 — only the editor is inside the boundary. BlockSuite
              mounts a CRDT document and a pile of extensions against a doc
              state we did not write and cannot validate up front, so it is the
              part of this screen most likely to throw at render; the title,
              the breadcrumbs, the cover and the lock/archive menu are plain
              React over a row we already have. Scoped this way, a document
              that will not open still lets you rename it, lock it or leave. */}
          <div className="mt-8">
            <PaneBoundary label="The editor">
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
            </PaneBoundary>
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
