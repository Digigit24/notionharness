'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Send, User } from 'lucide-react'
import type { TeamMessageKind } from '@/lib/broker'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { MESSAGE_KIND_LABEL, colourOf, initialsOf, type TeamSlotView } from './shared'

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
}) {
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<TeamMessageKind>('status')
  const [toSlotId, setToSlotId] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [caret, setCaret] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [pickerDismissed, setPickerDismissed] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
    setSending(true)
    try {
      await onSend({ body: text, kind, toSlotId })
      setBody('')
      setCaret(0)
    } finally {
      setSending(false)
    }
  }

  const busy = sending || disabled

  return (
    <div className="shrink-0 px-3 pb-3">
      <div
        className={cn(
          'relative rounded-xl border border-black/12 bg-white shadow-sm focus-within:border-black/30 dark:border-white/15 dark:bg-[#202020] dark:focus-within:border-white/35',
          busy && 'opacity-70',
        )}
      >
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
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          placeholder={placeholder}
          rows={2}
          autoFocus={autoFocus}
          disabled={busy}
          className="resize-none border-0 bg-transparent px-3 py-2.5 shadow-none focus-visible:ring-0"
          onKeyDown={(e) => {
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
          </span>
          <Button type="button" size="sm" disabled={busy || !body.trim()} onClick={() => void send()}>
            <Send size={13} />
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}
