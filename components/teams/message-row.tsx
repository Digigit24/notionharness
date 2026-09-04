'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ExternalLink, ListPlus, MailX, MessageSquareReply, SmilePlus } from 'lucide-react'
import type { TeamTaskStatus } from '@/lib/broker'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/relative-time'
import {
  MESSAGE_KIND_CLASS,
  MESSAGE_KIND_LABEL,
  REACTION_CHOICES,
  TASK_STATUS_CLASS,
  TASK_STATUS_LABEL,
  colourOf,
  formatClock,
  initialsOf,
  mentionsSlot,
  recipientLabel,
  senderLabelForMessage,
  slotById,
  splitMentions,
  type RoomFeedMessage,
  type TeamSlotView,
} from './shared'

/** The task a message is about, already resolved by the caller. Resolved
 * there rather than here because the feed holds the task list once and this
 * component is rendered a hundred times. */
export interface MessageTaskChip {
  id: number
  subject: string
  status: TeamTaskStatus
  ownerName: string | null
  ownerColour: string | null
}

/**
 * One message in the channel.
 *
 * A row, not a card. The visual weight goes on the AUTHOR and the BODY, and
 * everything else — kind, recipient, reactions, replies — is quiet until it
 * has something to say. That is why:
 *
 *  - a `status` message shows no kind chip. `status` is what a plain chat
 *    message carries, so chipping it would put a badge on every single line;
 *    the four kinds that mean something (instruction, question, answer,
 *    report) still get one, because seeing a delegation at a glance is the
 *    reason this feed exists.
 *  - "→ everyone" is not printed. A broadcast is the default in a room, and
 *    labelling the default is noise; a DIRECTED note still says who it is for,
 *    because that is the exception and it is the interesting one.
 *  - a grouped continuation prints no avatar, no name and no time. Repeating
 *    them on every line of a burst is what makes a chat log read like a table.
 */
export function MessageRow({
  message,
  grouped,
  slots,
  mySlotId,
  taskChip,
  runSessionId,
  runIsExact,
  runId,
  onOpenRun,
  workspaceSlug,
  focused,
  threadOpen,
  onOpenThread,
  onOpenTask,
  onMakeTask,
  onToggleReaction,
  onRetrySend,
  onDiscardSend,
  busy,
}: {
  message: RoomFeedMessage
  grouped: boolean
  slots: TeamSlotView[]
  mySlotId: number | null
  /** Present when `team_messages.task_id` is set AND that task is still on the
   * board. Null covers both "no task" and "task deleted". */
  taskChip: MessageTaskChip | null
  /** The Work session holding the run behind this message, or null when there
   * is nothing honest to link to. See `runLinkFor` for the two cases. */
  runSessionId: number | null
  /** False when the link is the agent's SESSION rather than the exact run —
   * the tooltip says so rather than overclaiming. */
  runIsExact: boolean
  /** R14-P0.5 — set only in the exact case (see `runLinkFor`). When present,
   * "See full run" opens the run-detail sheet in place instead of navigating
   * to Work; a session-only link (no exact run id) still goes to Work,
   * because the sheet's loader needs a specific run, not just a session. */
  runId?: number
  onOpenRun?: (runId: number) => void
  workspaceSlug: string
  /** Keyboard cursor. Drawn as a ring, never as a background: a focused row
   * that is also a mention must still read as a mention. */
  focused: boolean
  threadOpen: boolean
  onOpenThread: (rootId: number) => void
  onOpenTask: (taskId: number) => void
  /** Null when this row cannot become a task (a system row, or one that
   * already has one) — the hover action is then simply absent. */
  onMakeTask: ((messageId: number) => void) | null
  onToggleReaction: (messageId: number, emoji: string) => void
  /** R12-P3.1 - a refused message keeps its text and offers to go again.
   * Absent in the thread pane's read-only contexts. */
  onRetrySend?: (pendingKey: string) => void
  onDiscardSend?: (pendingKey: string) => void
  busy: boolean
}) {
  const [picking, setPicking] = useState(false)

  const from = slotById(slots, message.fromSlotId)
  // Three senders, not two. A person (null sender, no system kind), a slot (an
  // id, live or departed), and the room itself (null sender WITH a system
  // kind — the reliability sweep and the room-wide stop write those).
  const isSystem = message.systemKind != null
  const isHuman = message.fromSlotId == null && !isSystem
  const isMine = mySlotId != null && message.fromSlotId === mySlotId
  const dead = message.undeliverableAt != null
  // R12-P3.1 - three states a row can be in that the database knows nothing
  // about: on its way, refused, or (the usual case) neither.
  const sending = message.sendState === 'sending'
  const failedToSend = message.sendState === 'failed'
  const mentionsMe = mentionsSlot(message, mySlotId)
  const name = senderLabelForMessage(slots, message)
  const avatarColour = isSystem ? '#f59e0b' : isHuman ? '#64748b' : colourOf(from)

  return (
    <li
      id={`team-message-${message.id}`}
      className={cn(
        'group relative flex gap-2.5 rounded-md px-2 py-0.5 hover:bg-black/[.025] dark:hover:bg-white/[.03]',
        grouped ? 'mt-px' : 'mt-2 first:mt-0',
        focused && 'ring-2 ring-indigo-500/60 ring-offset-0',
        // Dimmed while it is on its way. Deliberately subtle: the message IS
        // there, and making it look provisional would undo the point of
        // painting it early.
        sending && 'opacity-60',
        failedToSend && 'bg-red-500/[.06]',
        // A message naming you gets a left edge and a wash, the way every chat
        // client marks one. Loud enough to find by scrolling, quiet enough not
        // to shout over the conversation around it.
        mentionsMe && 'bg-amber-500/[.07] hover:bg-amber-500/[.10] dark:bg-amber-400/[.08]',
        isSystem && 'bg-black/[.03] dark:bg-white/[.04]',
      )}
    >
      {mentionsMe && (
        <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 rounded-full bg-amber-500" />
      )}

      {/* The gutter keeps its width when grouped, so bodies stay on one
          left edge instead of stepping in and out as runs start and end. */}
      <div className="w-7 shrink-0 pt-0.5">
        {grouped ? (
          <span className="block pt-1 text-center text-[10px] leading-none text-transparent tabular-nums group-hover:text-black/30 dark:group-hover:text-white/30">
            {formatClock(message.createdAt)}
          </span>
        ) : (
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-md text-[11px] font-semibold text-white"
            style={{ backgroundColor: avatarColour }}
          >
            {isSystem ? '#' : initialsOf(name)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="text-sm font-semibold">{name}</span>
            {from?.role === 'leader' && (
              <span className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">lead</span>
            )}
            <span className="text-[11px] text-black/35 dark:text-white/35" title={message.createdAt}>
              {sending ? 'Sending…' : formatClock(message.createdAt)}
            </span>
            {message.toSlotId != null && (
              <span
                className={cn(
                  'text-[11px] text-black/50 dark:text-white/50',
                  message.addresseeMissing && 'text-red-600 dark:text-red-400',
                )}
              >
                → {recipientLabel(slots, message.toSlotId)}
              </span>
            )}
            {message.kind !== 'status' && (
              <span
                className={cn(
                  'rounded border px-1 py-px text-[10px] uppercase tracking-wide',
                  MESSAGE_KIND_CLASS[message.kind],
                )}
              >
                {MESSAGE_KIND_LABEL[message.kind]}
              </span>
            )}
            {/* The chip, not a quoted subject. A message that is about a task
                should say what STATE that task is in and who holds it —
                otherwise the channel and the board are two products that
                happen to share a database. Clicking jumps to the card. */}
            {taskChip && (
              <button
                type="button"
                onClick={() => onOpenTask(taskChip.id)}
                title={`${TASK_STATUS_LABEL[taskChip.status]}${
                  taskChip.ownerName ? ` · ${taskChip.ownerName}` : ' · unassigned'
                } — open on the board`}
                className="inline-flex max-w-[16rem] items-center gap-1 rounded border border-black/10 px-1 py-px text-[10px] hover:border-black/30 dark:border-white/15 dark:hover:border-white/35"
              >
                {taskChip.ownerColour ? (
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: taskChip.ownerColour }}
                  />
                ) : (
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-black/20 dark:bg-white/25" />
                )}
                <span className="truncate">{taskChip.subject}</span>
                <span className={cn('shrink-0 uppercase tracking-wide', TASK_STATUS_CLASS[taskChip.status])}>
                  {TASK_STATUS_LABEL[taskChip.status]}
                </span>
              </button>
            )}
            {/* A dead letter is shown, not hidden. The bug R6.6 fixes was a
                private message quietly becoming a broadcast; replacing it with
                a private message quietly vanishing would be the same failure
                with better manners. */}
            {dead && (
              <span
                className="inline-flex items-center gap-1 rounded border border-red-500/40 px-1 py-px text-[10px] uppercase tracking-wide text-red-600 dark:text-red-400"
                title={message.undeliverableReason ?? undefined}
              >
                <MailX size={10} />
                undelivered
              </span>
            )}
          </div>
        )}

        <p
          className={cn(
            'text-sm leading-snug whitespace-pre-wrap break-words',
            dead && 'text-black/45 line-through dark:text-white/45',
            isSystem && 'text-black/70 dark:text-white/70',
          )}
        >
          {splitMentions(message.body, slots).map((segment, index) =>
            segment.mentionSlotId == null ? (
              <span key={index}>{segment.text}</span>
            ) : (
              <span
                key={index}
                className={cn(
                  'rounded px-0.5 font-medium',
                  segment.mentionSlotId === mySlotId
                    ? 'bg-amber-500/25 text-amber-800 dark:text-amber-200'
                    : 'bg-black/[.06] text-black/70 dark:bg-white/[.10] dark:text-white/70',
                )}
              >
                {segment.text}
              </span>
            ),
          )}
        </p>

        {failedToSend && (
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-red-600 dark:text-red-400">
            <span>{message.failureMessage ?? 'Not sent.'}</span>
            {message.pendingKey && onRetrySend && (
              <button
                type="button"
                onClick={() => onRetrySend(message.pendingKey!)}
                className="rounded border border-red-500/40 px-1.5 py-px hover:bg-red-500/10"
              >
                Try again
              </button>
            )}
            {message.pendingKey && onDiscardSend && (
              <button
                type="button"
                onClick={() => onDiscardSend(message.pendingKey!)}
                className="rounded px-1 py-px underline-offset-2 hover:underline"
              >
                Discard
              </button>
            )}
          </div>
        )}

        {dead && message.undeliverableReason && (
          <p className="text-[11px] text-red-600/80 dark:text-red-400/80">
            {message.undeliverableReason} Nobody else received it.
          </p>
        )}

        {(message.reactions.length > 0 || picking) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {message.reactions.map((reaction) => {
              // "You reacted" needs no extra query: `toggleReaction` already
              // returns the actor ids and `listChannelFeed` ships them with
              // every row, which is exactly why the column is a table rather
              // than a count.
              const mine = mySlotId != null && reaction.actorSlotIds.includes(mySlotId)
              return (
                <button
                  key={reaction.emoji}
                  type="button"
                  disabled={busy || mySlotId == null}
                  onClick={() => onToggleReaction(message.id, reaction.emoji)}
                  title={mine ? 'You reacted — click to remove' : 'Add this reaction'}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-xs disabled:opacity-60',
                    mine
                      ? 'border-indigo-500/60 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
                      : 'border-black/10 hover:border-black/25 dark:border-white/15 dark:hover:border-white/30',
                  )}
                >
                  <span aria-hidden>{reaction.emoji}</span>
                  <span className="tabular-nums">{reaction.count}</span>
                </button>
              )
            })}
            {picking &&
              REACTION_CHOICES.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    onToggleReaction(message.id, emoji)
                    setPicking(false)
                  }}
                  className="rounded-full border border-black/10 px-1.5 py-px text-xs hover:bg-black/[.05] dark:border-white/15 dark:hover:bg-white/[.08]"
                >
                  {emoji}
                </button>
              ))}
          </div>
        )}

        {/*
          THE ROUTE FROM THE ANSWER TO THE WORK.

          A channel reply is a summary; the tool calls, the terminal output and
          the diffs that produced it live in the run. Without this link the
          feed is a wall of claims with no way to check any of them, which is
          the second half of the bug this unit exists to fix.

          Always rendered, never hover-only: "this came from a run you can
          read" is a fact about the message, and hiding facts behind a hover
          is how people never learn they exist.
        */}
        {runSessionId != null && runIsExact && runId != null && onOpenRun ? (
          <button
            type="button"
            onClick={() => onOpenRun(runId)}
            title="Open the run this message started — every tool call, terminal line and diff, without leaving the channel."
            className="mt-1 mr-2 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-black/45 hover:bg-black/[.05] hover:text-black/70 dark:text-white/45 dark:hover:bg-white/[.08] dark:hover:text-white/70"
          >
            <ExternalLink size={11} />
            See full run
          </button>
        ) : (
          runSessionId != null && (
            <Link
              href={`/workspace/${workspaceSlug}/work?session=${runSessionId}`}
              title={
                runIsExact
                  ? 'Open the run this message started — every tool call, terminal line and diff.'
                  : "Open this member's conversation in Work. `team_messages` carries no run id, so the exact run behind this reply cannot be named — this is the session it ran in."
              }
              className="mt-1 mr-2 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-black/45 hover:bg-black/[.05] hover:text-black/70 dark:text-white/45 dark:hover:bg-white/[.08] dark:hover:text-white/70"
            >
              <ExternalLink size={11} />
              See full run
            </Link>
          )
        )}

        {/* The thread summary. A root that has replies always shows this, open
            or not, because "there is a conversation under this" is a fact
            about the message rather than a hover affordance. */}
        {message.replyCount > 0 && (
          <button
            type="button"
            onClick={() => onOpenThread(message.id)}
            className={cn(
              'mt-1 inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-xs',
              threadOpen
                ? 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
                : 'text-indigo-600 hover:bg-indigo-500/10 dark:text-indigo-400',
            )}
          >
            <MessageSquareReply size={12} />
            {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
            {message.lastReplyAt && (
              <span className="font-normal text-black/40 dark:text-white/40">
                · last {formatRelativeTime(message.lastReplyAt)}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Hover actions, absolutely positioned so they never reflow the row.
          A toolbar that pushes the message sideways on hover makes a feed feel
          unstable while you read it. */}
      {!isSystem && (
        <div className="absolute -top-2 right-2 hidden items-center gap-0.5 rounded-md border border-black/10 bg-white p-0.5 shadow-sm group-hover:flex dark:border-white/15 dark:bg-[#242424]">
          <button
            type="button"
            title={mySlotId == null ? 'Join the channel to react' : 'Add a reaction'}
            disabled={mySlotId == null}
            onClick={() => setPicking((p) => !p)}
            className="rounded p-1 text-black/50 hover:bg-black/[.06] disabled:opacity-40 dark:text-white/50 dark:hover:bg-white/[.10]"
          >
            <SmilePlus size={13} />
          </button>
          <button
            type="button"
            title="Reply in thread"
            onClick={() => onOpenThread(message.id)}
            className="rounded p-1 text-black/50 hover:bg-black/[.06] dark:text-white/50 dark:hover:bg-white/[.10]"
          >
            <MessageSquareReply size={13} />
          </button>
          {/* One action, not a dialog. "Say a thing, then track the thing" is
              the move this room is for, and asking for a subject when the
              message already has one would put a form between the two. The
              subject is the first line and the body is the description; the
              chip that appears is the edit surface if either is wrong. */}
          {onMakeTask && (
            <button
              type="button"
              title="Make this a task on the board"
              disabled={busy}
              onClick={() => onMakeTask(message.id)}
              className="rounded p-1 text-black/50 hover:bg-black/[.06] disabled:opacity-40 dark:text-white/50 dark:hover:bg-white/[.10]"
            >
              <ListPlus size={13} />
            </button>
          )}
        </div>
      )}
      {isMine && <span className="sr-only">(your message)</span>}
    </li>
  )
}
