'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, MailX, Send, X } from 'lucide-react'
import type { TeamMessageKind, TeamTask } from '@/lib/broker'
import type { TeamRoomMessage } from '@/lib/teams/reliability'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/relative-time'
import { postTeamMessageAction } from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'
import {
  MESSAGE_KIND_CLASS,
  MESSAGE_KIND_LABEL,
  colourOf,
  recipientLabel,
  senderLabelForMessage,
  slotById,
  type TeamSlotView,
} from './shared'

const KINDS: TeamMessageKind[] = ['instruction', 'question', 'answer', 'report', 'status']

/**
 * How many rows are mounted at once.
 *
 * D0 / R6.5 are explicit that this feed is a **capped React list over typed
 * rows**, never a BlockSuite document: a CRDT is catastrophic for an
 * append-only log because every append becomes a Yjs update and a persistence
 * write. Nothing in this file imports the editor, and a message is a plain
 * `TeamMessage` row rendered by a hand-written component.
 *
 * The cap is a window, not a limit on the data: older rows are still held in
 * memory and mounted on demand. Real windowing — mounting only what intersects
 * the viewport — needs a virtualiser, and this unit may not add a dependency;
 * a 150-row ceiling keeps the DOM in the same order of magnitude a virtualiser
 * would, which is what the rule is actually protecting.
 */
const WINDOW_SIZE = 150

export function ChannelFeed({
  workspaceId,
  workspaceSlug,
  teamId,
  slots,
  messages,
  tasks,
  focusSlotId,
  onFocusSlot,
  onAppendMessage,
}: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  slots: TeamSlotView[]
  messages: TeamRoomMessage[]
  tasks: TeamTask[]
  focusSlotId: number | null
  onFocusSlot: (id: number | null) => void
  onAppendMessage: (message: TeamRoomMessage) => void
}) {
  const [cap, setCap] = useState(WINDOW_SIZE)
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<TeamMessageKind>('instruction')
  const [toSlotId, setToSlotId] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)

  const visible = useMemo(() => (messages.length > cap ? messages.slice(-cap) : messages), [messages, cap])
  const hidden = messages.length - visible.length

  const taskSubjectById = useMemo(() => new Map(tasks.map((t) => [t.id, t.subject])), [tasks])

  // Sticky-bottom, the way a chat client behaves: follow new messages only
  // while the reader is already at the bottom. Yanking someone back down while
  // they are reading history is the single worst thing a feed can do.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el || !pinnedToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [visible.length])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => {
      pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  async function send() {
    const text = body.trim()
    if (!text) return
    setSending(true)
    try {
      const message = await postTeamMessageAction({ workspaceId, teamId, body: text, kind, toSlotId })
      // Appended from the returned row rather than refetching the room: the
      // insert already told us exactly what landed.
      onAppendMessage(message)
      setBody('')
      pinnedToBottom.current = true
    } catch (error) {
      toast({
        title: 'Message not sent',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSending(false)
    }
  }

  const focusSlot = slotById(slots, focusSlotId)
  const focusMessages = useMemo(
    () =>
      focusSlot ? messages.filter((m) => m.fromSlotId === focusSlot.id || m.toSlotId === focusSlot.id) : [],
    [messages, focusSlot],
  )

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-black/10 dark:border-white/10">
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {messages.length === 0 && (
            <p className="py-10 text-center text-sm text-black/40 dark:text-white/40">
              Nothing has been said in this room yet. An instruction here is addressed to the whole team unless you
              pick a member.
            </p>
          )}

          {hidden > 0 && (
            <div className="mb-2 text-center">
              <Button type="button" size="xs" variant="outline" onClick={() => setCap((c) => c + WINDOW_SIZE)}>
                Show {Math.min(hidden, WINDOW_SIZE)} earlier
              </Button>
            </div>
          )}

          <ul className="space-y-2">
            {visible.map((message) => {
              const from = slotById(slots, message.fromSlotId)
              // Three senders now, not two: a person (null sender, no system
              // kind), a slot (an id, live or departed), and the room itself
              // (null sender WITH a system kind - the reliability sweep and the
              // room-wide stop write those). Before R6.6 the third case did not
              // exist and the second was destroyed on slot deletion, so both
              // were printed as "You".
              const isSystem = message.systemKind != null
              const isHuman = message.fromSlotId == null && !isSystem
              const dead = message.undeliverableAt != null
              return (
                <li
                  key={message.id}
                  className={cn(
                    'flex gap-2.5',
                    isSystem && 'rounded-md bg-black/[.03] px-1.5 py-1 dark:bg-white/[.05]',
                  )}
                >
                  <span
                    aria-hidden
                    className="mt-1.5 size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: isSystem ? '#f59e0b' : isHuman ? '#94a3b8' : colourOf(from) }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
                      {/* Sender AND recipient on every row, deliberately.
                          Watching the leader delegate is the point of the
                          channel, and "→ everyone" vs "→ Reviewer" is the
                          difference between a broadcast and an assignment. */}
                      <button
                        type="button"
                        className={cn(
                          'font-medium',
                          from ? 'hover:underline' : 'cursor-default text-black/70 dark:text-white/70',
                        )}
                        onClick={() => from && onFocusSlot(from.id)}
                        disabled={!from}
                      >
                        {senderLabelForMessage(slots, message)}
                      </button>
                      <span className="text-black/35 dark:text-white/35">→</span>
                      <span
                        className={cn(
                          'text-black/55 dark:text-white/55',
                          message.addresseeMissing && 'text-red-600 dark:text-red-400',
                        )}
                      >
                        {recipientLabel(slots, message.toSlotId)}
                      </span>
                      {/* A dead letter is shown, not hidden. The bug R6.6 fixes
                          was a private message quietly becoming a broadcast;
                          replacing it with a private message quietly vanishing
                          would be the same failure with better manners. */}
                      {dead && (
                        <span
                          className="inline-flex items-center gap-1 rounded border border-red-500/40 px-1 py-px text-[10px] uppercase tracking-wide text-red-600 dark:text-red-400"
                          title={message.undeliverableReason ?? undefined}
                        >
                          <MailX size={10} />
                          undelivered
                        </span>
                      )}
                      <span
                        className={cn(
                          'rounded border px-1 py-px text-[10px] uppercase tracking-wide',
                          MESSAGE_KIND_CLASS[message.kind],
                        )}
                      >
                        {MESSAGE_KIND_LABEL[message.kind]}
                      </span>
                      {message.taskId != null && (
                        <span className="text-[11px] text-black/45 dark:text-white/45">
                          on “{taskSubjectById.get(message.taskId) ?? `task ${message.taskId}`}”
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-black/35 dark:text-white/35">
                        {formatRelativeTime(message.createdAt)}
                      </span>
                    </div>
                    <p
                      className={cn(
                        'mt-0.5 text-sm whitespace-pre-wrap break-words',
                        dead && 'text-black/45 line-through dark:text-white/45',
                        isSystem && 'text-black/70 dark:text-white/70',
                      )}
                    >
                      {message.body}
                    </p>
                    {dead && message.undeliverableReason && (
                      <p className="mt-0.5 text-[11px] text-red-600/80 dark:text-red-400/80">
                        {message.undeliverableReason} Nobody else received it.
                      </p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>

          <p className="mt-4 border-t border-black/5 pt-2 text-[11px] text-black/35 dark:border-white/5 dark:text-white/35">
            Messages sent from this box are attributed to you. Rows from &ldquo;Room&rdquo; were written by the
            reliability sweep or by a room-wide stop, not by a person. A departed member now keeps its identity and
            reads as &ldquo;a removed member&rdquo;; only rows written before that fix are still indistinguishable
            from yours, because their sender id was destroyed and cannot be recovered.
          </p>
        </div>

        <div className="shrink-0 border-t border-black/10 p-2.5 dark:border-white/10">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Give the room an instruction…"
            rows={2}
            disabled={sending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="mt-2 flex items-center gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as TeamMessageKind)} disabled={sending}>
              <SelectTrigger className="h-7 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {MESSAGE_KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={toSlotId == null ? 'all' : String(toSlotId)}
              onValueChange={(v) => setToSlotId(v === 'all' ? null : Number(v))}
              disabled={sending}
            >
              <SelectTrigger className="h-7 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">everyone</SelectItem>
                {slots.map((slot) => (
                  <SelectItem key={slot.id} value={String(slot.id)}>
                    {slot.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              disabled={sending || !body.trim()}
              onClick={() => void send()}
            >
              <Send size={13} />
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-black/35 dark:text-white/35">
            Written to the team mailbox. Nothing dispatches a run from here yet — a member picks this up the next
            time it polls its inbox through the team MCP surface (R6.2).
          </p>
        </div>
      </div>

      {focusSlot && (
        <aside className="flex min-h-0 w-72 shrink-0 flex-col rounded-xl border border-black/10 dark:border-white/10">
          <div className="flex items-center gap-2 border-b border-black/10 px-3 py-2 dark:border-white/10">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: colourOf(focusSlot) }}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{focusSlot.displayName}</span>
            <Button type="button" size="icon-xs" variant="ghost" onClick={() => onFocusSlot(null)} title="Close">
              <X size={12} />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {/*
              R6.4 asks for the member's live thread beside the feed. This is
              their mailbox side of the room, not their thread: mounting the
              streaming transcript here would mean fetching run snapshots
              through the Work unit's server actions, which this unit does not
              own and cannot safely couple to mid-flight. The link below opens
              the real thread, which is a genuine conversation row.
            */}
            {focusMessages.length === 0 ? (
              <p className="py-6 text-center text-xs text-black/40 dark:text-white/40">
                Nothing to or from this slot yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {focusMessages.slice(-WINDOW_SIZE).map((m) => (
                  <li key={m.id} className="text-xs">
                    <div className="flex items-baseline gap-1.5 text-[11px] text-black/45 dark:text-white/45">
                      <span>{senderLabelForMessage(slots, m)}</span>
                      <span>→</span>
                      <span>{recipientLabel(slots, m.toSlotId)}</span>
                      <span className="ml-auto">{formatRelativeTime(m.createdAt)}</span>
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap break-words">{m.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="shrink-0 border-t border-black/10 p-2 dark:border-white/10">
            {focusSlot.sessionId != null ? (
              <Link
                href={`/workspace/${workspaceSlug}/work?session=${focusSlot.sessionId}`}
                className="inline-flex items-center gap-1.5 text-xs text-black/60 hover:underline dark:text-white/60"
              >
                <ExternalLink size={12} />
                Open this slot&apos;s thread in Work
              </Link>
            ) : (
              <p className="text-xs text-black/40 dark:text-white/40">
                This slot has no conversation bound to it, so there is no thread to open.
              </p>
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
