'use client'

import { useCallback, useMemo } from 'react'
import Link from 'next/link'
import { ExternalLink, Loader2, TriangleAlert, X } from 'lucide-react'
import { unwrap } from '@/lib/failures'
import { cn } from '@/lib/utils'
import { useRunEventStream } from '@/components/runs/use-run-event-stream'
import { StreamingText } from '@/components/thread/StreamingText'
import { adaptRunSnapshotsToThread } from '@/lib/hermes/runEvent-adapter'
import { loadChannelRunSnapshotAction } from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'
import { colourOf, initialsOf, slotById, type PendingReply, type TeamSlotView } from './shared'

/**
 * The gap this component exists to close.
 *
 * Mentioning an agent enqueues a run (`lib/teams/mention-dispatch.ts`) and the
 * answer arrives as a thread reply minutes later. Between those two moments
 * the channel showed NOTHING — no row, no spinner, no acknowledgement that
 * anything had been started at all. A person who has just asked an agent a
 * question and sees an unchanged feed concludes, correctly on the evidence,
 * that nothing happened.
 *
 * So: a real row, in the feed, from the instant the run is enqueued, carrying
 * the run's own output as it streams.
 *
 * WHY `useRunEventStream` AND NOT A POLL. The run's events already push
 * through `lib/broker/live-bus.ts` → `/api/runs/[id]/events/stream`, and that
 * hook already owns reconnect, `Last-Event-ID` resume, frame coalescing on
 * `requestAnimationFrame` and the four connection states. Writing a second,
 * smaller streaming client here would be a worse copy of all of it and would
 * drift the first time the route changed. The room's own six-second cursor
 * poll is NOT used for this: it would make a live reply arrive in six-second
 * steps, which is the exact latency D0 forbids where a push already exists.
 *
 * WHY `StreamingText`. Hermes emits assistant text in uneven bursts, and
 * painting each burst the instant it lands makes a reply jump-cut. That
 * component's reveal buffer already smooths it AND already becomes a no-op
 * under `prefers-reduced-motion`. It is imported, not reimplemented.
 */
export function PendingReplyRow({
  workspaceId,
  workspaceSlug,
  teamId,
  pending,
  slots,
  onDismiss,
}: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  pending: PendingReply
  slots: TeamSlotView[]
  onDismiss: (runId: number) => void
}) {
  const slot = slotById(slots, pending.slotId)

  const loader = useCallback(
    // `unwrap` rather than a silent empty array: `useRunEventStream` already
    // owns the retry-and-report path for a loader that rejects, so a refused
    // snapshot surfaces as the stream's own reconnecting state instead of as a
    // ghost row that never fills in.
    async (runId: number) => unwrap(await loadChannelRunSnapshotAction({ workspaceId, teamId, runId })),
    [workspaceId, teamId],
  )
  // `observed` is unconditionally true: this component only ever mounts while
  // its run is pending, and unmounting is how the room stops the stream.
  const { snapshots, connectionStatus, connectionAttempt, maxConnectionAttempts, retry } = useRunEventStream(
    pending.runId,
    true,
    loader,
  )

  const thread = useMemo(
    () => (snapshots.length > 0 ? adaptRunSnapshotsToThread(snapshots) : null),
    [snapshots],
  )

  /**
   * What to show as the agent's answer-so-far.
   *
   * The LAST assistant message's text blocks, joined. Not every assistant
   * message in the run: a turn that thought, called three tools and then wrote
   * its answer would otherwise print its intermediate narration above the
   * answer and the ghost row would grow taller than the conversation it sits
   * in. The full transcript is one click away, which is the point of the link.
   */
  const { text, toolCount, running } = useMemo(() => {
    if (!thread) return { text: '', toolCount: 0, running: true }
    let tools = 0
    let latest = ''
    for (const message of thread.messages) {
      for (const block of message.content) {
        if (block.type === 'tool_call') tools += 1
      }
      if (message.role !== 'assistant') continue
      const joined = message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined.trim().length > 0) latest = joined
    }
    return { text: latest, toolCount: tools, running: thread.isRunning }
  }, [thread])

  const done = thread?.done ?? null
  // A failed or cancelled turn is STATED. The failure mode this whole unit
  // exists to remove is silence, and replacing "nothing happened" with a
  // spinner that quietly disappears would be the same bug wearing a hat.
  const failed = done != null && done.status !== 'ok'

  return (
    <li
      className={cn(
        'group relative mt-1 flex gap-2.5 rounded-md px-2 py-1',
        failed
          ? 'bg-red-500/[.05] dark:bg-red-400/[.07]'
          : 'bg-indigo-500/[.05] dark:bg-indigo-400/[.06]',
      )}
      aria-live="polite"
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 w-0.5 rounded-full',
          failed ? 'bg-red-500' : 'bg-indigo-500',
        )}
      />

      <div className="w-7 shrink-0 pt-0.5">
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-md text-[11px] font-semibold text-white"
          style={{ backgroundColor: colourOf(slot) }}
        >
          {initialsOf(pending.displayName)}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="text-sm font-semibold">{pending.displayName}</span>
          {failed ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-600 dark:text-red-400">
              <TriangleAlert size={11} />
              {done?.status === 'cancelled' ? 'turn cancelled' : 'turn failed'}
            </span>
          ) : running ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400">
              <Loader2 size={11} className="animate-spin motion-reduce:animate-none" />
              replying…
            </span>
          ) : (
            <span className="text-[11px] text-black/45 dark:text-white/45">
              finished — waiting for the reply to land in the thread
            </span>
          )}
          {toolCount > 0 && (
            <span className="text-[11px] text-black/40 dark:text-white/40">
              · {toolCount} tool {toolCount === 1 ? 'call' : 'calls'}
            </span>
          )}
          {pending.sessionId != null && (
            <Link
              href={`/workspace/${workspaceSlug}/work?session=${pending.sessionId}`}
              className="inline-flex items-center gap-1 text-[11px] text-indigo-600 hover:underline dark:text-indigo-400"
            >
              <ExternalLink size={10} />
              See full run
            </Link>
          )}
        </div>

        {text.trim().length > 0 ? (
          <p className="text-sm leading-snug whitespace-pre-wrap break-words text-black/75 dark:text-white/75">
            <StreamingText text={text} active={running} />
          </p>
        ) : (
          // Deliberately not a skeleton. A shimmering grey bar implies text is
          // arriving; before the first token there is genuinely nothing to
          // show, and saying so is more useful than pretending otherwise.
          <p className="text-xs text-black/40 dark:text-white/40">
            {failed
              ? (done?.reason ?? 'The run ended without producing an answer.')
              : toolCount > 0
                ? 'Working — no text yet.'
                : 'Started. Waiting for the first token.'}
          </p>
        )}

        {/* The one connection state worth interrupting for. `connecting` is
            silent on purpose: most reconnects finish inside the hook's grace
            period, and a banner that flashes on every healthy blip teaches
            people to ignore it. */}
        {(connectionStatus === 'reconnecting' || connectionStatus === 'offline') && (
          <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
            {connectionStatus === 'offline' ? (
              <>
                Live updates stopped.{' '}
                <button type="button" onClick={retry} className="underline">
                  Retry
                </button>{' '}
                — the run itself is unaffected.
              </>
            ) : (
              <>
                Reconnecting to the run ({connectionAttempt}/{maxConnectionAttempts})…
              </>
            )}
          </p>
        )}
      </div>

      {/* Dismiss, because a ghost row must never be able to outlive its run on
          screen. The room drops these on its own when the reply lands; this is
          the escape hatch for a run that ends without ever posting one. */}
      <button
        type="button"
        title="Hide this row (the run is not affected)"
        onClick={() => onDismiss(pending.runId)}
        className="absolute right-1.5 top-1 hidden rounded p-1 text-black/40 hover:bg-black/[.06] group-hover:block dark:text-white/40 dark:hover:bg-white/[.10]"
      >
        <X size={12} />
      </button>
    </li>
  )
}
