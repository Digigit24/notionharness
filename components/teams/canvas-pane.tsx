'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BlockSuiteEditor } from '@/components/editor/BlockSuiteEditor'
import {
  ensureChannelCanvasAction,
  type ChannelCanvas,
} from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'

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
  const [error, setError] = useState<string | null>(null)

  // Created and loaded on first OPEN, not on room mount. Most channels never
  // grow a canvas, and creating one per channel up front would fill the
  // workspace with empty documents nobody asked for.
  useEffect(() => {
    let cancelled = false
    setError(null)
    ensureChannelCanvasAction({ workspaceId, teamId })
      .then((result) => {
        if (!cancelled) setCanvas(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not open the canvas.')
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, teamId])

  return (
    <aside className="flex min-h-0 w-[26rem] shrink-0 flex-col rounded-xl border border-black/10 dark:border-white/10">
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
          <p className="px-3 py-6 text-xs text-red-600 dark:text-red-400">{error}</p>
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
    </aside>
  )
}
