'use client'

import { Dialog as DialogPrimitive } from 'radix-ui'
import { Loader2, X } from 'lucide-react'
import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useRunEventStream, type RunEventLoader } from '@/components/runs/use-run-event-stream'
import { adaptRunSnapshotsToThread } from '@/lib/hermes/runEvent-adapter'
import { Thread } from '@/components/thread/Thread'

/**
 * R14-P0.5 — the run-execution-log viewer, as a slide-over rather than a
 * page you leave the channel to reach.
 *
 * WHY THIS IS THE SAME `Thread` COMPONENT, NOT A SECOND RENDERER. Every tool
 * call, terminal line and diff already has a correct implementation in
 * `components/thread/Thread.tsx` — the exact one the Work page mounts. A
 * second transcript renderer built for this sheet would drift from that one
 * the first time either was touched, which is precisely the mistake this
 * codebase's own conventions warn against. This component's entire job is to
 * get a `runId` INTO that renderer through a slide-over shell, nothing more.
 *
 * WHY `useRunEventStream` NEEDS NO CHANGES. Confirmed by reading its body,
 * not its (misleadingly named) `taskId` parameter: it opens
 * `/api/runs/${runId}/events/stream` internally and has no assumption about
 * being mounted on the Work page. `pending-reply-row.tsx` already proves this
 * by streaming a ghost row's output through the exact same hook with a
 * channel-specific loader. This sheet does the same thing, just full-size
 * and on demand instead of inline and automatic.
 *
 * WHY A STYLED `Dialog`, AND NOT A NEW DEPENDENCY. This codebase has exactly
 * one overlay primitive, `components/ui/dialog.tsx` (Radix `Dialog`,
 * centered by default). No `Sheet`/`Drawer` primitive exists. Rather than
 * add one, this reaches past `DialogContent`'s hardcoded centered-modal
 * classes to the lower-level `DialogPrimitive.Content` Radix already
 * exports, and positions it as a right-anchored panel instead. Same
 * dependency, same focus-trap and Escape-to-close behaviour, different
 * geometry — not a new primitive.
 *
 * WHY THE LOADER IS A PROP, NOT BAKED IN. The only authorisation-checked way
 * to read a run's snapshot today is scoped to the surface asking for it (see
 * `loadChannelRunSnapshotAction` — it verifies the run's `channel_message_id`
 * belongs to the CALLER's channel before returning anything). Baking one
 * loader into this component would either weaken that check for other
 * callers or make this component channel-only forever. Taking it as a prop
 * keeps the authorisation exactly where the roadmap's own security work put
 * it — at the edge, per caller — while this component owns only the
 * presentation.
 */
export function RunDetailSheet({
  open,
  onOpenChange,
  runId,
  loader,
  title,
  fullPageHref,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null while nothing is selected — lets a caller keep one sheet mounted
   * and swap which run it shows rather than mounting/unmounting per row. */
  runId: number | null
  loader: RunEventLoader
  /** What to call this run in the header — usually the message or task
   * subject that started it. Falls back to a plain run number. */
  title?: string
  /** "Open in Work" — the escape hatch to the full page for someone who
   * wants the session rail, other runs in the same conversation, or a
   * bookmarkable URL. Omitted when the caller has no session to link to. */
  fullPageHref?: string
}) {
  // The hook needs a real number to key its internal maps on even while
  // closed/unselected; 0 is never a legal run id, so it is a safe sentinel
  // that produces an empty, inert stream rather than a conditional hook call.
  const { snapshots, connectionStatus, connectionAttempt, maxConnectionAttempts, retry } = useRunEventStream(
    runId ?? 0,
    open && runId != null,
    loader,
  )

  const thread = snapshots.length > 0 ? adaptRunSnapshotsToThread(snapshots) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-background shadow-2xl outline-none sm:w-[560px] lg:w-[680px]',
            // Radix drives open/close via `data-state`; a translate-based
            // slide reads as "from the edge" the way a centered zoom does not,
            // and stays off the compositor's paint path (transform only).
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=closed]:duration-150 data-[state=open]:duration-200',
          )}
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-black/10 px-4 py-3 dark:border-white/10">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-semibold">
              {title ?? (runId != null ? `Run ${runId}` : 'Run')}
            </DialogPrimitive.Title>
            {fullPageHref && (
              <a
                href={fullPageHref}
                className="shrink-0 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Open in Work
              </a>
            )}
            <DialogPrimitive.Close className="shrink-0 rounded p-1 text-black/45 hover:bg-black/[.06] dark:text-white/45 dark:hover:bg-white/[.10]">
              <X size={14} />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-hidden">
            {runId == null ? (
              <div className="flex h-full items-center justify-center text-sm text-black/40 dark:text-white/40">
                Nothing selected.
              </div>
            ) : thread ? (
              <Thread thread={thread} showUsage showRunId={false} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-black/40 dark:text-white/40">
                <Loader2 size={16} className="animate-spin" />
                <span className="text-xs">Loading the run…</span>
              </div>
            )}
          </div>

          {(connectionStatus === 'reconnecting' || connectionStatus === 'offline') && (
            <p className="shrink-0 border-t border-black/10 px-4 py-2 text-[11px] text-amber-600 dark:border-white/10 dark:text-amber-400">
              {connectionStatus === 'offline' ? (
                <>
                  Live updates stopped.{' '}
                  <button type="button" onClick={retry} className="underline">
                    Retry
                  </button>
                </>
              ) : (
                `Reconnecting (${connectionAttempt}/${maxConnectionAttempts})…`
              )}
            </p>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
