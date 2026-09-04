'use client'

import { ReactNode, useEffect, useState } from 'react'
import { MessageScroller } from './MessageScroller'
import { Message } from './Message'
import { Bubble } from './Bubble'
import { TerminalBlock } from './TerminalBlock'
import { TypingIndicator } from './Marker'
import { getToolRenderer } from './tool-renderers'
import type { ChatThread, ChatContent, ChatMessage, TurnStats, UsageData } from '@/lib/hermes/runEvent-adapter'
import { ThinkingBlock } from './ThinkingBlock'
import { PermissionCard } from './PermissionCard'
import { DiffBlock } from './DiffBlock'
import { StreamingText } from './StreamingText'
import { durationBetween, formatDuration } from './format-duration'
import { classifyRunError, looksLikeAgentError } from '@/lib/hermes/classify-run-error'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { formatCount } from '@/lib/relative-time'

/** Collapses `thread.usage` into one row per provider/model, summing tokens
 * and cost, and drops entries that carry zero information (`unknown/unknown`
 * at 0 tokens — a real, frequent shape from acp-client.ts's usage
 * normalization, not a hypothetical). Without this, a long-running or
 * multi-run conversation (e.g. the "Ask" page's combined thread — see
 * adaptRunSnapshotsToThread) renders one line per raw `usage` RunEvent,
 * unbounded — confirmed live: 32 identical "unknown/unknown: 0 tokens (0
 * ticks)" lines pushed the actual conversation out of view above the
 * composer. */
function aggregateUsage(usage: UsageData[]): UsageData[] {
  const byKey = new Map<string, UsageData>()
  for (const u of usage) {
    if (u.provider === 'unknown' && u.model === 'unknown' && u.tokens === 0 && u.costTicks === 0) continue
    const key = `${u.provider}/${u.model}`
    const existing = byKey.get(key)
    if (existing) {
      existing.tokens += u.tokens
      existing.costTicks += u.costTicks
    } else {
      byKey.set(key, { ...u })
    }
  }
  return [...byKey.values()]
}

/**
 * Thread component
 *
 * Main UI component for rendering a ChatThread built from RunEvent stream.
 * Handles streaming updates via React re-renders.
 *
 * Usage:
 *   const thread = adaptRunEventsToThread(envelopes)
 *   <Thread thread={thread} />
 */
export interface ThreadProps {
  thread: ChatThread
  autoScroll?: boolean
  showUsage?: boolean
  showRunId?: boolean
  /** Re-checks the run's real status against the broker. Offered only when the
   * thread has gone quiet long enough to look stalled. */
  onCheckStatus?: () => void
  /** Cancels the in-flight run. Same action as the composer's Stop button. */
  onStop?: () => void
  /** Promotes one assistant reply into a page. Offered only by surfaces that
   * know which session the reply belongs to. */
  onConvertToPage?: (message: ChatMessage) => void
}

/** No output for this long, while the run still claims to be running, is
 * reported as a stall. Chosen well above any normal gap: a model thinking
 * hard, a long tool call, and a slow first token all stay comfortably inside
 * it, so this fires on genuine hangs rather than on slow work. */
const STALL_AFTER_MS = 90_000

/**
 * One coarse clock for the whole thread. Every deadline in the UI (the stall
 * watchdog here, the per-tool-call timeout in ToolCard) reads this instead of
 * owning a timer, so a conversation with fifty tool cards still has exactly
 * one interval — and it only exists while something is actually running, so a
 * finished conversation costs nothing at all. Five seconds is deliberate:
 * these are 60s and 90s thresholds, so a faster tick would buy no accuracy
 * and would re-render the transcript twelve times a minute for nothing.
 */
function useCoarseClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** Past this many messages the transcript stops growing the DOM and keeps
 * only the tail mounted. Chosen over a windowing library deliberately: every
 * virtualizer needs measured, stable row heights, and these rows change height
 * continuously while a run streams (thinking blocks collapse, tool cards
 * expand, text grows token by token) — measurement thrash there would cost
 * exactly the smoothness this is meant to protect. Slicing the tail is O(1),
 * touches nothing on the hot path, and leaves `use-stick-to-bottom`'s anchoring
 * untouched. Older messages stay one click away. */
const VISIBLE_TAIL = 100

export function Thread({
  thread,
  autoScroll = true,
  showUsage = true,
  showRunId = false,
  onCheckStatus,
  onStop,
  onConvertToPage,
}: ThreadProps) {
  const [showAll, setShowAll] = useState(false)
  // Only tick while something can actually change. A thread whose runs have
  // all ended has no deadline left to evaluate, so the timer would be pure
  // re-render cost.
  const now = useCoarseClock(thread.isRunning)
  const hiddenCount = showAll ? 0 : Math.max(0, thread.messages.length - VISIBLE_TAIL)
  const messages = hiddenCount > 0 ? thread.messages.slice(hiddenCount) : thread.messages
  const lastMessage = thread.messages[thread.messages.length - 1]
  // Nothing from the assistant has landed yet for the in-progress turn —
  // either no messages exist at all, the last one is the user's own prompt,
  // or an assistant message exists but is still empty (its very first
  // RunEvent hasn't arrived). Shown as three bouncing dots, same signal
  // assistant-style chat UIs use for "the model is working."
  const awaitingFirstToken =
    thread.isRunning && (!lastMessage || lastMessage.role !== 'assistant' || lastMessage.content.length === 0)
  // Once content exists, swap the dots for a blinking cursor at the end of
  // whatever's actively growing instead — the dots would otherwise sit
  // beneath already-arrived text, which reads as stuck rather than live.
  const isStreamingLastMessage = thread.isRunning && lastMessage?.role === 'assistant' && lastMessage.content.length > 0

  // `thread.isRunning` comes from the run's row in the broker, which can go on
  // saying "running" long after the process behind it is gone — a server
  // restart mid-run orphans the row, and the sweeper only reclaims it on its
  // own schedule. Silence is the only signal available from the client, so
  // measure it: nothing has arrived for STALL_AFTER_MS while the row still
  // claims to be live.
  const silentForMs = thread.isRunning && thread.lastEventAt ? now - new Date(thread.lastEventAt).getTime() : 0
  const stalled = thread.isRunning && silentForMs > STALL_AFTER_MS
  // A stalled run must not also render the "working" affordances — a blinking
  // cursor next to a "no output for 3m" notice contradicts itself.
  const showTyping = awaitingFirstToken && !stalled
  const showCursorOnLast = isStreamingLastMessage && !stalled

  return (
    <div className="flex flex-col h-full">
      <MessageScroller autoScroll={autoScroll} className="flex-1" itemCount={thread.messages.length}>
        {thread.messages.length === 0 && !awaitingFirstToken && !stalled ? (
          <div className="text-center text-sm text-black/40 dark:text-white/40 py-8">No messages yet</div>
        ) : (
          <>
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="mx-auto rounded-full border border-black/10 px-3 py-1 text-xs text-black/45 transition hover:text-black dark:border-white/10 dark:text-white/45 dark:hover:text-white"
              >
                Show {hiddenCount} earlier message{hiddenCount === 1 ? '' : 's'}
              </button>
            )}
            {messages.map((message, mIdx) => {
              const isLastMessage = mIdx === messages.length - 1
              const lastContentIdx = message.content.length - 1
              // Plain prose only — tool/terminal blocks carry their own copy
              // affordances, and copying a mixed blob would be meaningless.
              const copyText = message.content
                .filter((c) => c.type === 'text')
                .map((c) => (c.type === 'text' ? c.text : ''))
                .join('')
                .trim()

              return (
                <Message
                  key={message.id}
                  role={message.role}
                  createdAt={message.createdAt}
                  copyText={copyText}
                  delivery={message.delivery}
                  onConvertToPage={
                    onConvertToPage && message.role === 'assistant' && message.content.length > 0
                      ? () => onConvertToPage(message)
                      : undefined
                  }
                >
                  <div className="flex flex-col gap-2">
                    {message.content.map((content, idx) =>
                      renderContent(
                        content,
                        idx,
                        isLastMessage && showCursorOnLast && idx === lastContentIdx,
                        idx === lastContentIdx,
                        now,
                        // Per-message, not per-thread. In the combined "Ask"
                        // view many runs share one thread, so a live run must
                        // not make an hour-old run's unfinished tool call look
                        // live too (and tick at 1Hz forever).
                        message.runEnded ?? !thread.isRunning,
                      ),
                    )}
                    {message.error && <TurnError raw={message.error} />}
                    {message.stats && !showCursorOnLast && <TurnFooter stats={message.stats} />}
                  </div>
                </Message>
              )
            })}
            {showTyping && (
              <Message role="assistant">
                <TypingIndicator />
              </Message>
            )}
            {stalled && (
              <StalledNotice silentForMs={silentForMs} onCheckStatus={onCheckStatus} onStop={onStop} />
            )}
          </>
        )}
      </MessageScroller>

      {/* Run metadata footer */}
      <div className="border-t border-black/10 bg-black/[0.015] px-4 py-2.5 text-xs text-black/45 dark:border-white/10 dark:bg-white/[0.02] dark:text-white/40">
        {showRunId && thread.runId && <div>Run: {thread.runId}</div>}

        {showUsage && (() => {
          const usage = aggregateUsage(thread.usage)
          return (
            usage.length > 0 && (
              <div className="mt-1">
                {usage.map((u) => (
                  <div key={`${u.provider}/${u.model}`}>
                    {u.provider}/{u.model}: {u.tokens} tokens (${(u.costTicks / 100).toFixed(4)})
                  </div>
                ))}
              </div>
            )
          )
        })()}

        {thread.done && (
          <div
            className={`mt-1 font-semibold ${thread.done.status === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}
          >
            {thread.done.status.toUpperCase()}
            {thread.done.reason && `: ${thread.done.reason}`}
          </div>
        )}

        {thread.isRunning && <div>{stalled ? 'No response — see above' : 'Running…'}</div>}
      </div>
    </div>
  )
}

/** A blinking caret appended to the content block currently receiving
 * chunks — the visual cue that this bubble is still live, not finished. */
function StreamCursor() {
  return (
    <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-current align-middle" />
  )
}

/**
 * Render individual content pieces within a message.
 * `showCursor` is true only for the trailing block of the message currently
 * streaming — see the `isStreamingLastMessage` check above.
 */
function renderContent(
  content: ChatContent,
  key: number,
  showCursor: boolean,
  isLastBlock: boolean,
  now: number,
  runEnded: boolean,
): ReactNode {
  switch (content.type) {
    case 'text':
      // A provider failure that Hermes handed back as prose is not an answer,
      // and must not be dressed as one. Only once it has stopped streaming —
      // a partial chunk can look like anything on its way past.
      if (!showCursor && looksLikeAgentError(content.text)) {
        return <TurnError key={key} raw={content.text} />
      }
      return (
        // `max-w-[72ch]` is the only width constraint on assistant prose.
        // Without it, answers ran the full ~1120px container — roughly 180
        // characters a line, well past the point where the eye loses its
        // place returning to the next line. User bubbles were already capped;
        // the long-form side, which is where the reading actually happens,
        // was not. `whitespace-pre-wrap` preserves the model's own paragraph
        // breaks, which were previously collapsing into one block of text.
        <Bubble key={key} type="text" className="max-w-[72ch] whitespace-pre-wrap break-words">
          {showCursor ? <StreamingText text={content.text} active /> : content.text}
          {showCursor && <StreamCursor />}
        </Bubble>
      )

    case 'thinking':
      return (
        <ThinkingBlock
          key={key}
          text={content.text}
          durationMs={durationBetween(content.startedAt, content.endedAt)}
          // Anything after this block means the agent moved on, so the
          // planning notes fold away and the answer stays readable.
          superseded={!isLastBlock}
          streaming={showCursor}
        />
      )

    case 'terminal':
      return (
        <TerminalBlock
          key={key}
          text={content.text}
          streaming={showCursor && !content.exited}
          exited={content.exited}
          exitCode={content.exitCode}
          signal={content.signal}
          runEnded={runEnded}
        />
      )

    case 'permission':
      return (
        <PermissionCard
          key={key}
          requestId={content.requestId}
          title={content.title}
          detail={content.detail}
          options={content.options}
          outcome={content.outcome}
          selectedOptionId={content.selectedOptionId}
          reason={content.reason}
        />
      )

    case 'file_change':
      return <DiffBlock key={key} diff={content.diff} path={content.path} />

    case 'tool_call': {
      const renderer = getToolRenderer(content.toolName)
      return (
        <div key={key}>
          {renderer({
            toolName: content.toolName,
            toolInput: content.toolInput,
            toolOutput: content.toolOutput,
            isError: content.isError,
            durationMs: durationBetween(content.startedAt, content.endedAt),
            toolLocations: content.toolLocations,
            toolKind: content.toolKind,
            startedAt: content.startedAt,
            now,
            runEnded,
          })}
        </div>
      )
    }

    default:
      return null
  }
}

/**
 * What a stalled run says instead of a spinner. Both actions are the ones a
 * person would otherwise have to find elsewhere in the app: re-check what the
 * broker actually thinks, or end it.
 */
function StalledNotice({
  silentForMs,
  onCheckStatus,
  onStop,
}: {
  silentForMs: number
  onCheckStatus?: () => void
  onStop?: () => void
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.05] px-4 py-3 text-center">
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-amber-700 dark:text-amber-400">
        <AlertTriangle size={13} />
        Stalled — no output for {formatDuration(silentForMs)}
      </div>
      <p className="text-xs text-black/45 dark:text-white/45">
        The run still reports as active, but nothing has arrived. It may have been interrupted.
      </p>
      {(onCheckStatus || onStop) && (
        <div className="flex items-center gap-1.5">
          {onCheckStatus && (
            <button
              type="button"
              onClick={onCheckStatus}
              className="rounded-full border border-black/15 px-2.5 py-1 text-xs font-medium text-black/65 transition hover:bg-black/[0.04] dark:border-white/15 dark:text-white/65 dark:hover:bg-white/[0.06]"
            >
              Check status
            </button>
          )}
          {onStop && (
            <button
              type="button"
              onClick={onStop}
              className="rounded-full border border-black/15 px-2.5 py-1 text-xs font-medium text-black/65 transition hover:bg-black/[0.04] dark:border-white/15 dark:text-white/65 dark:hover:bg-white/[0.06]"
            >
              Stop
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A failure stated as a diagnosis, with the raw text one click away. The
 * previous version printed the error's first line, which for this stack's
 * real failures meant showing `EEXIST: file already exists, mkdir '...'` to
 * someone who needed to know the agent's workspace didn't get set up.
 */
function TurnError({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false)
  const classified = classifyRunError(raw)
  if (!classified) return null
  const hasMore = classified.raw !== classified.headline

  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/[0.05] px-3 py-2 text-[13px] text-red-600 dark:text-red-400">
      <p className="font-medium">{classified.headline}</p>
      {classified.hint && <p className="mt-0.5 text-xs opacity-80">{classified.hint}</p>}
      {hasMore && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1 flex items-center gap-0.5 text-xs opacity-70 hover:opacity-100"
          >
            <ChevronRight size={11} className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
            Details
          </button>
          {open && (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/[0.06] px-2 py-1.5 font-mono text-[11px] leading-relaxed dark:bg-black/40">
              {classified.raw}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

/** The quiet line under a finished answer: how long it took, what it spent,
 * how much tool work it did. Every number comes from events already in the
 * stream, so this costs nothing to produce. */
function TurnFooter({ stats }: { stats: TurnStats }) {
  const parts: string[] = []
  if (stats.durationMs != null && stats.durationMs > 0) parts.push(formatDuration(stats.durationMs))
  if (stats.tokens > 0) parts.push(`${formatCount(stats.tokens)} tokens`)
  if (stats.toolCount > 0) parts.push(`${stats.toolCount} tool${stats.toolCount === 1 ? '' : 's'}`)
  if (parts.length === 0) return null
  return (
    <div className="px-3 pt-0.5 text-[11px] tabular-nums text-black/30 dark:text-white/30">{parts.join(' · ')}</div>
  )
}
