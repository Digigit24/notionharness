'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Send, TriangleAlert, User } from 'lucide-react'
import type { TeamMessageKind } from '@/lib/broker'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  MESSAGE_KIND_LABEL,
  SLASH_COMMANDS,
  colourOf,
  initialsOf,
  slashCommandAt,
  type TeamSlotView,
} from './shared'

/** What a slash command hands back to the composer. `null` means it ran; a
 * string is the reason it did not, printed under the box. Deliberately not a
 * toast: the text that caused it is still sitting in the composer, and the
 * explanation belongs beside it. */
export type SlashCommandRunner = (command: { name: string; rest: string }) => Promise<string | null>

const KINDS: TeamMessageKind[] = ['status', 'instruction', 'question', 'answer', 'report']

/** The token being typed, if the caret sits inside an `@…`. Stops at a
 * newline and at a second `@`, so "email a@b" never opens the picker on "b". */
function mentionQueryAt(value: string, caret: number): { query: string; start: number } | null {
  const upToCaret = value.slice(0, caret)
  const at = upToCaret.lastIndexOf('@')
  if (at === -1) return null
  // An `@` only starts a mention at the beginning of the text or after
  // whitespace or an opening bracket — "user@host" is an address, not a ping.
  const before = at === 0 ? '' : upToCaret[at - 1]
  if (before && !/[\s(\[{]/.test(before)) return null
  const query = upToCaret.slice(at + 1)
  if (/[\n@]/.test(query)) return null
  // Display names contain spaces ("Review Bot"), so a space cannot end the
  // token — but an unbounded run would keep the picker open forever. Two words
  // is enough for every default name this app generates.
  if (query.split(' ').length > 3) return null
  return { query, start: at }
}

/**
 * The composer: what you type, who it is for, and the mention picker.
 *
 * Mentions are typed as plain `@Name` text and stay that way — the body is
 * canonical and is never rewritten into markup. The server parses it with
 * `parseMentions` against the roster it reads itself, which is also why this
 * component does not send a mention array: a client-supplied one would be a
 * way to write an arbitrary slot id into an indexed column and light up
 * somebody else's badge from outside the room.
 *
 * The picker exists so the text you type actually MATCHES a roster name.
 * `parseMentions` is a literal, case-insensitive substring match on
 * `@DisplayName`, so "@Rev" pings nobody — autocomplete is what makes the
 * feature usable rather than a guessing game.
 */
export function MessageComposer({
  slots,
  disabled,
  placeholder,
  showKind,
  showRecipient,
  autoFocus,
  onSend,
  onTyping,
  onCommand,
  focusToken,
}: {
  slots: TeamSlotView[]
  disabled?: boolean
  placeholder: string
  /** The thread pane hides both: a reply inherits the conversation it is in,
   * and a directed reply inside a thread is a distinction nobody asked for. */
  showKind: boolean
  showRecipient: boolean
  autoFocus?: boolean
  onSend: (input: { body: string; kind: TeamMessageKind; toSlotId: number | null }) => Promise<void>
  /**
   * R12-P3.2 — fired at most once every two seconds while the box holds
   * uncommitted text. The throttle lives HERE rather than in the caller so
   * every composer in the room (the feed's and the thread's) gets it for
   * free and cannot disagree about the interval. Absent entirely for a
   * composer with nobody to tell — there is none today, but the prop is
   * optional rather than required so a future read-only or preview composer
   * never has to wire a no-op.
   */
  onTyping?: () => void
  /**
   * Enables slash commands. Absent (the thread pane) means a leading "/" is
   * just a character — a reply that starts with a path should not be
   * intercepted by a command palette the thread has no commands for.
   */
  onCommand?: SlashCommandRunner
  /** Bumped by the parent to pull focus here — the "/" shortcut. A token
   * rather than a boolean so pressing it twice in a row works. */
  focusToken?: number
}) {
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<TeamMessageKind>('status')
  const [toSlotId, setToSlotId] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [caret, setCaret] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [pickerDismissed, setPickerDismissed] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [commandHighlight, setCommandHighlight] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // R12-P3.2's throttle. A ref, not state: this value changing must never
  // cause a re-render — it exists purely to gate a fire-and-forget call.
  const lastTypingNotifyRef = useRef(0)
  const notifyTypingThrottled = useCallback(() => {
    if (!onTyping) return
    const now = Date.now()
    if (now - lastTypingNotifyRef.current < 2000) return
    lastTypingNotifyRef.current = now
    onTyping()
  }, [onTyping])

  useEffect(() => {
    if (focusToken === undefined || focusToken === 0) return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    // To the END, not to 0: the shortcut is "let me type", and dropping the
    // caret in front of whatever draft is already there is the classic way a
    // focus shortcut eats a sentence.
    const end = el.value.length
    el.setSelectionRange(end, end)
    setCaret(end)
  }, [focusToken])

  /**
   * The command being typed, and the palette over it.
   *
   * The same scanner shape as `mentionQueryAt`, deliberately: one grammar for
   * "a token that opens a picker" rather than two that drift. Position 0 only
   * — see `slashCommandAt`.
   */
  const slash = useMemo(() => (onCommand ? slashCommandAt(body) : null), [onCommand, body])
  const commandMatches = useMemo(() => {
    if (!slash || slash.complete) return []
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(slash.name))
  }, [slash])
  const knownCommand = slash ? SLASH_COMMANDS.find((c) => c.name === slash.name) : undefined

  useEffect(() => setCommandHighlight(0), [slash?.name])

  const completeCommand = useCallback((name: string) => {
    setBody(`/${name} `)
    setCommandError(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
      setCaret(end)
    })
  }, [])

  const mention = useMemo(() => (pickerDismissed ? null : mentionQueryAt(body, caret)), [body, caret, pickerDismissed])
  const matches = useMemo(() => {
    if (!mention) return []
    const needle = mention.query.trim().toLowerCase()
    return slots
      .filter((s) => s.displayName.toLowerCase().includes(needle))
      .slice(0, 6)
  }, [mention, slots])

  useEffect(() => setHighlight(0), [mention?.query])

  const insertMention = useCallback(
    (slot: TeamSlotView) => {
      if (!mention) return
      const next = `${body.slice(0, mention.start)}@${slot.displayName} ${body.slice(caret)}`
      const nextCaret = mention.start + slot.displayName.length + 2
      setBody(next)
      setPickerDismissed(true)
      // The caret has to be restored by hand: React re-renders the textarea
      // with the new value and would otherwise leave the caret at the end.
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(nextCaret, nextCaret)
        setCaret(nextCaret)
      })
    },
    [body, caret, mention],
  )

  async function send() {
    const text = body.trim()
    if (!text || sending) return

    // A COMMAND IS NEVER POSTED AS A MESSAGE. Typing "/tsak fix the build" and
    // watching it land in the channel as chat is the failure that teaches
    // people the command palette cannot be trusted, so an unrecognised name is
    // refused here — before the network — and the text is left in the box to
    // be corrected.
    if (onCommand && slash) {
      if (!knownCommand) {
        setCommandError(
          `Unknown command /${slash.name || '…'}. Try ${SLASH_COMMANDS.map((c) => `/${c.name}`).join(', ')}.`,
        )
        return
      }
      setSending(true)
      try {
        // Caught, not just awaited. A runner is supposed to RETURN its refusal
        // as a string, but a rejected server action thrown from inside one
        // would otherwise escape this handler entirely — `send()` is invoked
        // as `void send()`, so the rejection would be unhandled and a refused
        // command would look identical to one that worked: the box clears
        // nothing, and nothing is said.
        const failure = await onCommand({ name: knownCommand.name, rest: slash.rest }).catch((error: unknown) =>
          error instanceof Error ? error.message : 'Something went wrong.',
        )
        if (failure) {
          setCommandError(failure)
          return
        }
        setCommandError(null)
        setBody('')
        setCaret(0)
      } finally {
        setSending(false)
      }
      return
    }

    // R12-P3.1 - CLEAR FIRST, SEND AFTER.
    //
    // This used to `await onSend(...)` and only then clear the box, with the
    // whole composer at `opacity-70` meanwhile. D0 names this exact path: the
    // paint must not wait on the server. `onSend` now paints the row itself and
    // reconciles later, so there is nothing left here worth blocking on - and
    // nothing to put back on failure either, because the failed row keeps the
    // text and offers to send it again.
    setBody('')
    setCaret(0)
    setCommandError(null)
    void onSend({ body: text, kind, toSlotId })
  }

  const busy = sending || disabled

  return (
    <div className="shrink-0 border-t border-black/10 px-3 pb-3 pt-2 dark:border-white/10">
      <div
        className={cn(
          'relative rounded-lg focus-within:bg-black/[.03] dark:focus-within:bg-white/[.04]',
          busy && 'opacity-70',
        )}
      >
        {/* The command palette. Same position and same shape as the mention
            picker below it — they are the same interaction with a different
            sigil, and giving them two different looks would make one of them
            feel broken. The two can never be open at once: a "/" only counts
            at position 0, where an "@" cannot also be starting a token. */}
        {slash && commandMatches.length > 0 && (
          <ul className="absolute bottom-full left-2 z-20 mb-1 w-80 overflow-hidden rounded-lg border border-black/10 bg-white py-1 shadow-lg dark:border-white/15 dark:bg-[#232323]">
            {commandMatches.map((command, index) => (
              <li key={command.name}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    completeCommand(command.name)
                  }}
                  className={cn(
                    'flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-sm',
                    index === commandHighlight
                      ? 'bg-black/[.06] dark:bg-white/[.10]'
                      : 'hover:bg-black/[.04] dark:hover:bg-white/[.07]',
                  )}
                >
                  <span className="shrink-0 font-medium">/{command.name}</span>
                  {command.args && (
                    <span className="shrink-0 text-[11px] text-black/35 dark:text-white/35">{command.args}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-right text-[11px] text-black/45 dark:text-white/45">
                    {command.hint}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {mention && matches.length > 0 && (
          <ul className="absolute bottom-full left-2 z-20 mb-1 w-64 overflow-hidden rounded-lg border border-black/10 bg-white py-1 shadow-lg dark:border-white/15 dark:bg-[#232323]">
            {matches.map((slot, index) => (
              <li key={slot.id}>
                <button
                  type="button"
                  // `onMouseDown`, not `onClick`: a click would blur the
                  // textarea first and the caret position would be lost.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    insertMention(slot)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm',
                    index === highlight ? 'bg-black/[.06] dark:bg-white/[.10]' : 'hover:bg-black/[.04] dark:hover:bg-white/[.07]',
                  )}
                >
                  <span
                    aria-hidden
                    className="flex size-5 shrink-0 items-center justify-center rounded text-[9px] font-semibold text-white"
                    style={{ backgroundColor: colourOf(slot) }}
                  >
                    {initialsOf(slot.displayName)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{slot.displayName}</span>
                  <span className="shrink-0 text-black/30 dark:text-white/30">
                    {slot.userId != null ? <User size={11} /> : <Bot size={11} />}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <Textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => {
            setBody(e.target.value)
            setCaret(e.target.selectionStart ?? e.target.value.length)
            setPickerDismissed(false)
            // Only while there is something to be typing — clearing the box
            // must not itself announce "typing", or Enter-to-send would look
            // like the sender started a new message the instant they finished
            // the last one.
            if (e.target.value.trim().length > 0) notifyTypingThrottled()
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          placeholder={placeholder}
          rows={2}
          autoFocus={autoFocus}
          disabled={busy}
          className="resize-none border-0 bg-transparent px-3 py-2.5 shadow-none focus-visible:ring-0"
          onKeyDown={(e) => {
            if (slash && commandMatches.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCommandHighlight((h) => (h + 1) % commandMatches.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCommandHighlight((h) => (h - 1 + commandMatches.length) % commandMatches.length)
                return
              }
              if (e.key === 'Tab') {
                e.preventDefault()
                completeCommand(commandMatches[commandHighlight].name)
                return
              }
              // Enter deliberately falls through to `send()` rather than
              // completing: "/task" on its own is a complete command with an
              // empty argument, and swallowing Enter would make the palette
              // feel like it had stolen the keystroke.
            }
            if (mention && matches.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setHighlight((h) => (h + 1) % matches.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setHighlight((h) => (h - 1 + matches.length) % matches.length)
                return
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault()
                insertMention(matches[highlight])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setPickerDismissed(true)
                return
              }
            }
            // Enter sends, Shift+Enter is a newline — the convention every
            // chat client shares, and the reason the old Cmd+Enter binding is
            // gone: it made the fast path the unusual one.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />

        <div className="flex items-center gap-2 border-t border-black/[.07] px-2 py-1.5 dark:border-white/[.08]">
          {showKind && (
            <Select value={kind} onValueChange={(v) => setKind(v as TeamMessageKind)} disabled={busy}>
              <SelectTrigger className="h-7 w-32 border-0 text-xs shadow-none">
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
          )}
          {showRecipient && (
            <Select
              value={toSlotId == null ? 'all' : String(toSlotId)}
              onValueChange={(v) => setToSlotId(v === 'all' ? null : Number(v))}
              disabled={busy}
            >
              <SelectTrigger className="h-7 w-40 border-0 text-xs shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">to everyone</SelectItem>
                {slots.map((slot) => (
                  <SelectItem key={slot.id} value={String(slot.id)}>
                    to {slot.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <span className="ml-auto hidden text-[11px] text-black/30 sm:block dark:text-white/30">
            Enter to send · Shift+Enter for a new line · @ to mention
            {onCommand ? ' · / for commands' : ''}
          </span>
          <Button type="button" size="sm" disabled={busy || !body.trim()} onClick={() => void send()}>
            <Send size={13} />
            {sending ? 'Sending…' : knownCommand ? `Run /${knownCommand.name}` : 'Send'}
          </Button>
        </div>
      </div>

      {/* Beside the text that caused it, not in a toast. The draft is still in
          the box and the correction is one keystroke away; a notification in
          the corner would make the reader look away from it. */}
      {commandError && (
        <p className="mt-1 flex items-start gap-1.5 px-1 text-[11px] text-red-600 dark:text-red-400">
          <TriangleAlert size={12} className="mt-px shrink-0" />
          <span>{commandError}</span>
        </p>
      )}
    </div>
  )
}
