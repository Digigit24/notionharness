'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PaneBoundary } from '@/components/ui/pane-boundary'
import { ClientFailure, unwrap } from '@/lib/failures'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'
import { PaneDivider, useResizablePane } from '@/components/ui/resizable-pane'
import {
  ensureChannelCanvasAction,
  type ChannelCanvas,
} from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'

/**
 * R12-P2.4 - the editor arrives when it is needed, not with the page.
 *
 * Measured: `/workspace/[workspaceSlug]/teams/[teamId]` was 564 kB first load,
 * second only to the page canvas itself, because this file imported
 * `BlockSuiteEditor` statically while the canvas pane is CLOSED by default.
 * Everyone reading a channel paid for an editor almost nobody opened.
 *
 * `ssr: false` because BlockSuite is a browser editor with no useful server
 * render, and the placeholder is shaped like a document rather than being a
 * spinner - the pane has already been opened deliberately, so what belongs
 * there is the shape of what is coming.
 */
const BlockSuiteEditor = dynamic(
  () => import('@/components/editor/BlockSuiteEditor').then((m) => m.BlockSuiteEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    ),
  },
)

/**
 * The channel's canvas, beside the feed.
 *
 * THIS is the BlockSuite surface, and it is the only one in the Teams route.
 * R6.5 draws the line: the FEED is a typed React list because a CRDT is the
 * wrong substrate for a high-frequency append-only log, and the CANVAS is a
 * document because that is exactly what a CRDT is for. Nothing is shared
 * between them but the pane they sit in.
 *
 * The page behind it is an ordinary `pages` row tagged
 * `linkedSourceType='team'` / `linkedSourceId=<teamId>`, created lazily by
 * `ensureChannelCanvasAction` the first time this pane is opened. There is no
 * `canvas_page_id` column, deliberately: the tag already keeps the canvas out
 * of the sidebar tree (`getSidebarPages` skips any page with a
 * `linkedSourceType`), already gives it a "Canvas for #channel" origin header
 * through `lib/page-origin.ts`, and already makes the full-page editor work
 * with no changes. A column would have bought none of the three.
 *
 * `BlockSuiteEditor` is mounted directly rather than `PageCanvas`. PageCanvas
 * is the whole page chrome — breadcrumbs, cover, icon picker, docked agent
 * panel — and it is built to own a viewport, not to sit in a 420px column. The
 * editor itself explicitly supports being embedded (see its `workspaceSlug`
 * comment), and the "open it properly" case is one click away below.
 */
export function CanvasPane({
  workspaceId,
  workspaceSlug,
  teamId,
  channelName,
  onClose,
}: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  channelName: string
  onClose: () => void
}) {
  const [canvas, setCanvas] = useState<ChannelCanvas | null>(null)
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null)

  // Created and loaded on first OPEN, not on room mount. Most channels never
  // grow a canvas, and creating one per channel up front would fill the
  // workspace with empty documents nobody asked for.
  useEffect(() => {
    let cancelled = false
    setError(null)
    ensureChannelCanvasAction({ workspaceId, teamId })
      .then((result) => {
        if (!cancelled) setCanvas(unwrap(result))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError({
          message: err instanceof Error ? err.message : 'Could not open the canvas.',
          // The underlying text, when the failure carried one. This is the
          // pane that diagnoses a missing migration (see the action), and the
          // driver's own sentence is the only thing on screen that says which.
          detail: err instanceof ClientFailure ? err.detail : undefined,
        })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, teamId])

  // A canvas wants more room than a thread does, so it gets a wider default
  // and a higher ceiling - and its own key, because the two are separate
  // preferences about two different things.
  const pane = useResizablePane({ storageKey: 'notionharness.channel.canvas.width', defaultWidth: 416, min: 320, max: 1100 })

  return (
    <>
      <PaneDivider label="Resize the canvas" dragging={pane.dragging} {...pane.dividerProps} />
      <aside
        ref={pane.paneRef as React.RefObject<HTMLElement>}
        style={{ width: pane.width }}
        className="flex min-h-0 shrink-0 flex-col"
      >
      {/* R12-P1.2 — same reason as the thread beside it: this pane is a
          BlockSuite document inside the channel route, not a route of its own,
          so without a boundary here a bad doc state takes the room's feed with
          it. The failed state above only covers the action that FETCHES the
          canvas; this covers the editor that renders it. */}
      <PaneBoundary label="The canvas">
        <header className="flex shrink-0 items-center gap-2 border-b border-black/10 px-3 py-2 dark:border-white/10">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Canvas</span>
            <span className="block truncate text-[11px] text-black/45 dark:text-white/45">
              The channel&apos;s document — #{channelName}
            </span>
          </span>
          {canvas && (
            <Link
              href={`/workspace/${workspaceSlug}/p/${canvas.pageId}`}
              title="Open the canvas as a full page"
              className="rounded p-1 text-black/45 hover:bg-black/[.06] dark:text-white/45 dark:hover:bg-white/[.10]"
            >
              <ExternalLink size={13} />
            </Link>
          )}
          <Button type="button" size="icon-xs" variant="ghost" onClick={onClose} title="Close canvas">
            <X size={13} />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            // Said out loud rather than left as an empty pane. A canvas that
            // silently fails to appear is indistinguishable from one that is
            // simply blank, and the difference matters to whoever has to fix it.
            <div className="px-3 py-6 text-xs text-red-600 dark:text-red-400">
              <p>{error.message}</p>
              {error.detail && <p className="mt-1 break-words opacity-70">{error.detail}</p>}
            </div>
          ) : canvas == null ? (
            <p className="flex items-center justify-center gap-2 py-10 text-xs text-black/40 dark:text-white/40">
              <Loader2 size={13} className="animate-spin" />
              Opening the canvas…
            </p>
          ) : (
            <BlockSuiteEditor
              pageId={canvas.pageId}
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
              initialTitle={canvas.title}
              initialDocState={canvas.docState}
              locked={canvas.isLocked}
            />
          )}
        </div>
      </PaneBoundary>
      </aside>
    </>
  )
}
