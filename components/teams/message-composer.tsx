'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bold,
  Bot,
  Code,
  FileText,
  Italic,
  List,
  Paperclip,
  Quote,
  Send,
  SquareCode,
  TriangleAlert,
  User,
  X,
} from 'lucide-react'
import type { TeamMessageKind } from '@/lib/broker'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { insertCodeFence, toggleLinePrefix, toggleWrap, type TextEdit } from '@/lib/markdown-lite'
import { uploadMediaAction } from '@/app/api/media/actions'
import { unwrap } from '@/lib/failures'
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

/**
 * R14-P0.4 — one attachment as the composer sees it, BEFORE it is a message.
 *
 * `status: 'uploading'` is the only state the Send button ever looks at
 * (see `busy` below) — everything else about typing, mentions and commands
 * stays exactly as fast as it always was; only a genuinely in-flight upload
 * ever blocks Send, matching this phase's "optimistic attachments" brief.
 */
interface ComposerAttachment {
  /** Client-local only — never sent anywhere. Keys the chip in the list and
   * matches a finished upload back to the row that started it. */
  key: string
  file: File
  status: 'uploading' | 'done' | 'error'
  /** Set once `uploadMediaAction` returns. This IS the id `onSend` carries. */
  mediaId?: number
  filesize: number
  mimeType: string
  /** `URL.createObjectURL(file)` — the instant local preview, shown before
   * the network round trip even starts. Revoked on removal/unmount. */
  objectUrl: string | null
  errorMessage?: string
}

/** Same cap `collections/Media.ts`'s `upload.filesize.max` and
 * `uploadMediaAction`'s own check enforce — restated here purely so an
 * oversized file is refused BEFORE a wasted upload attempt, with the same
 * sentence the server would have given anyway. */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
/** A chat message, not a file drop — bounds how many chips one send can
 * carry, the same instinct D0 names for lists ("no unbounded lists") applied
 * to a single compose action. */
const MAX_ATTACHMENTS_PER_MESSAGE = 6

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

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

/** One markdown-lite/attachment toolbar button. `onMouseDown` prevents the
 * default focus steal so clicking a button never loses the textarea's
 * current selection before the handler gets to act on it — the exact
 * `onMouseDown`-not-`onClick` reasoning the mention list already uses below. */
function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Bold
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded text-black/45 hover:bg-black/[.06] hover:text-black/80 disabled:pointer-events-none disabled:opacity-40 dark:text-white/45 dark:hover:bg-white/[.08] dark:hover:text-white/80"
    >
      <Icon size={14} />
    </button>
  )
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
  workspaceId,
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
  /** Which workspace an attachment upload belongs to — `uploadMediaAction`
   * re-checks membership against this server-side, so it is load-bearing for
   * authorization, not just for routing the upload to the right bucket. */
  workspaceId: number
  slots: TeamSlotView[]
  disabled?: boolean
  placeholder: string
  /** The thread pane hides both: a reply inherits the conversation it is in,
   * and a directed reply inside a thread is a distinction nobody asked for. */
  showKind: boolean
  showRecipient: boolean
  autoFocus?: boolean
  onSend: (input: {
    body: string
    kind: TeamMessageKind
    toSlotId: number | null
    /** Media ids already uploaded by the time Enter is pressed — see this
     * component's own `addFiles`. */
    attachments: number[]
  }) => Promise<void>
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

  // -------------------------------------------------------------------------
  // R14-P0.4 — attachments. Chosen, dropped or pasted; uploaded in the
  // background the instant they are added; removable any time before Send.
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  // Revoke every object URL still held when the composer itself unmounts
  // (navigating away mid-upload) — not on every render, which is why this is
  // a ref rather than living inside `addFiles`/`removeAttachment` alone.
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  useEffect(
    () => () => {
      for (const a of attachmentsRef.current) if (a.objectUrl) URL.revokeObjectURL(a.objectUrl)
    },
    [],
  )

  const uploadOne = useCallback(
    (key: string, file: File) => {
      const formData = new FormData()
      formData.set('workspaceId', String(workspaceId))
      formData.set('file', file)
      uploadMediaAction(formData)
        .then((result) => {
          const uploaded = unwrap(result)
          setAttachments((prev) =>
            prev.map((a) => (a.key === key ? { ...a, status: 'done', mediaId: uploaded.id } : a)),
          )
        })
        .catch((error: unknown) => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.key === key
                ? { ...a, status: 'error', errorMessage: error instanceof Error ? error.message : 'Upload failed.' }
                : a,
            ),
          )
        })
    },
    [workspaceId],
  )

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files)
      if (list.length === 0) return
      setAttachmentError(null)

      const room = MAX_ATTACHMENTS_PER_MESSAGE - attachmentsRef.current.length
      if (room <= 0) {
        setAttachmentError(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`)
        return
      }
      const accepted = list.slice(0, room)
      if (list.length > accepted.length) {
        setAttachmentError(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message — only the first ${accepted.length} were added.`)
      }

      const next: ComposerAttachment[] = []
      for (const file of accepted) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setAttachmentError(`"${file.name}" is over ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB and was not added.`)
          continue
        }
        const key = `att-${Date.now()}-${Math.random().toString(36).slice(2)}`
        next.push({
          key,
          file,
          status: 'uploading',
          filesize: file.size,
          mimeType: file.type || 'application/octet-stream',
          objectUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        })
      }
      if (next.length === 0) return
      setAttachments((prev) => [...prev, ...next])
      for (const a of next) uploadOne(a.key, a.file)
    },
    [uploadOne],
  )

  const removeAttachment = useCallback((key: string) => {
    setAttachments((prev) => {
      const found = prev.find((a) => a.key === key)
      if (found?.objectUrl) URL.revokeObjectURL(found.objectUrl)
      return prev.filter((a) => a.key !== key)
    })
  }, [])

  const retryAttachment = useCallback(
    (key: string) => {
      const found = attachmentsRef.current.find((a) => a.key === key)
      if (!found) return
      setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, status: 'uploading', errorMessage: undefined } : a)))
      uploadOne(key, found.file)
    },
    [uploadOne],
  )

  const uploadingCount = attachments.filter((a) => a.status === 'uploading').length

  // -------------------------------------------------------------------------
  // R14-P0.4 — the markdown-lite toolbar. Every button (and Cmd/Ctrl+B/I) goes
  // through this one helper: apply the edit to `body`, then restore the
  // textarea's own selection on the next frame, exactly the same caret dance
  // `insertMention`/`completeCommand` below already do for the same reason —
  // React re-renders the textarea with the new value and would otherwise drop
  // the caret to the end.
  const applyTextEdit = useCallback((edit: TextEdit) => {
    setBody(edit.value)
    setCaret(edit.selectionEnd)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(edit.selectionStart, edit.selectionEnd)
    })
  }, [])

  const withSelection = useCallback((fn: (value: string, start: number, end: number) => TextEdit) => {
    const el = textareaRef.current
    const start = el?.selectionStart ?? body.length
    const end = el?.selectionEnd ?? body.length
    return fn(body, start, end)
  }, [body])

  const toolbar = {
    bold: () => applyTextEdit(withSelection((v, s, e) => toggleWrap(v, s, e, '**'))),
    italic: () => applyTextEdit(withSelection((v, s, e) => toggleWrap(v, s, e, '_'))),
    code: () => applyTextEdit(withSelection((v, s, e) => toggleWrap(v, s, e, '`'))),
    quote: () => applyTextEdit(withSelection((v, s, e) => toggleLinePrefix(v, s, e, '> '))),
    list: () => applyTextEdit(withSelection((v, s, e) => toggleLinePrefix(v, s, e, '- '))),
    codeBlock: () => applyTextEdit(withSelection((v, s, e) => insertCodeFence(v, s, e))),
  }

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
    const doneAttachmentIds = attachments
      .filter((a): a is ComposerAttachment & { mediaId: number } => a.status === 'done' && a.mediaId != null)
      .map((a) => a.mediaId)
    // Nothing to send (no text and no finished attachment), already sending,
    // or an upload is still genuinely in flight — the one condition that
    // blocks Send without touching anything else about the box (typing stays
    // live the whole time an upload runs).
    if ((!text && doneAttachmentIds.length === 0) || sending || uploadingCount > 0) return

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
    for (const a of attachments) if (a.objectUrl) URL.revokeObjectURL(a.objectUrl)
    setAttachments([])
    setAttachmentError(null)
    void onSend({ body: text, kind, toSlotId, attachments: doneAttachmentIds })
  }

  const busy = sending || disabled
  const failedAttachmentCount = attachments.filter((a) => a.status === 'error').length
  const sendDisabled =
    busy ||
    uploadingCount > 0 ||
    (!body.trim() && attachments.filter((a) => a.status === 'done').length === 0)

  return (
    <div className="shrink-0 px-3 pb-3">
      <div
        className={cn(
          'relative rounded-xl border border-black/12 bg-white shadow-sm focus-within:border-black/30 dark:border-white/15 dark:bg-[#202020] dark:focus-within:border-white/35',
          busy && 'opacity-70',
          dragOver && 'border-blue-400 ring-2 ring-blue-400/30 dark:border-blue-400',
        )}
        onDragOver={(e) => {
          // Files only — dragging selected text/links within the page must
          // not paint the drop styling or swallow the browser's own drop
          // behaviour for it.
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setDragOver(false)
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length === 0) return
          e.preventDefault()
          setDragOver(false)
          addFiles(e.dataTransfer.files)
        }}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-xl bg-blue-500/10 text-xs font-medium text-blue-700 backdrop-blur-[1px] dark:text-blue-300">
            Drop to attach
          </div>
        )}
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

        {/* R14-P0.4 — the markdown-lite toolbar. Every button routes through
            `toolbar`/`applyTextEdit` above; `onMouseDown` preventDefault on
            each one so clicking a button never blurs the textarea (the same
            reason the mention list's own buttons do it) and the selection the
            button is about to act on is never lost first. */}
        <div className="flex items-center gap-0.5 px-2 pt-1.5">
          <ToolbarButton icon={Bold} label="Bold (Ctrl+B)" onClick={toolbar.bold} disabled={busy} />
          <ToolbarButton icon={Italic} label="Italic (Ctrl+I)" onClick={toolbar.italic} disabled={busy} />
          <ToolbarButton icon={Code} label="Inline code" onClick={toolbar.code} disabled={busy} />
          <ToolbarButton icon={Quote} label="Quote" onClick={toolbar.quote} disabled={busy} />
          <ToolbarButton icon={List} label="List" onClick={toolbar.list} disabled={busy} />
          <ToolbarButton icon={SquareCode} label="Code block" onClick={toolbar.codeBlock} disabled={busy} />
          <span className="mx-1 h-4 w-px bg-black/10 dark:bg-white/10" aria-hidden />
          <ToolbarButton
            icon={Paperclip}
            label="Attach a file"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) addFiles(e.target.files)
              // Reset so choosing the SAME file twice in a row still fires
              // `onChange` — the browser otherwise treats an identical
              // selection as a no-op change event.
              e.target.value = ''
            }}
          />
        </div>

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
          onPaste={(e) => {
            // Only intercepted when the clipboard actually carries a file —
            // pasting plain text (the overwhelming majority of pastes) is
            // left completely alone so it lands in the textarea exactly as
            // it always did.
            const files = Array.from(e.clipboardData?.items ?? [])
              .filter((item) => item.kind === 'file')
              .map((item) => item.getAsFile())
              .filter((f): f is File => f != null)
            if (files.length === 0) return
            e.preventDefault()
            addFiles(files)
          }}
          placeholder={placeholder}
          rows={2}
          autoFocus={autoFocus}
          disabled={busy}
          className="resize-none border-0 bg-transparent px-3 py-2.5 shadow-none focus-visible:ring-0"
          onKeyDown={(e) => {
            // Markdown-lite toggles. Checked before the command/mention
            // palettes: bold/italic is a text-editing action, not a
            // navigation one, and should work identically whether or not a
            // picker happens to be open above the caret.
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
              if (e.key.toLowerCase() === 'b') {
                e.preventDefault()
                toolbar.bold()
                return
              }
              if (e.key.toLowerCase() === 'i') {
                e.preventDefault()
                toolbar.italic()
                return
              }
            }
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

        {/* Attachment chips/previews — visible the INSTANT a file is chosen
            (per this phase's own "optimistic UI" brief), before the upload
            that fills in `mediaId` has even resolved. Removable any time
            before Send by design: an attachment is a draft until it is part
            of a sent message, same as the text beside it. */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-black/[.07] px-2 py-2 dark:border-white/[.08]">
            {attachments.map((a) => (
              <div
                key={a.key}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs',
                  a.status === 'error'
                    ? 'border-red-500/40 bg-red-500/5'
                    : 'border-black/10 bg-black/[.02] dark:border-white/10 dark:bg-white/[.04]',
                )}
              >
                {a.objectUrl ? (
                  // A local blob: URL, never a remote asset next/image would
                  // optimise or cache.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.objectUrl} alt={a.file.name} className="h-9 w-9 shrink-0 rounded object-cover" />
                ) : (
                  <FileText size={16} className="shrink-0 text-black/40 dark:text-white/40" />
                )}
                <div className="min-w-0">
                  <div className="max-w-40 truncate font-medium">{a.file.name}</div>
                  <div className="text-[10px] text-black/40 dark:text-white/40">
                    {a.status === 'uploading'
                      ? 'Uploading…'
                      : a.status === 'error'
                        ? (a.errorMessage ?? 'Upload failed.')
                        : formatBytes(a.filesize)}
                  </div>
                </div>
                {a.status === 'uploading' && (
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 animate-pulse rounded-full bg-blue-500"
                  />
                )}
                {a.status === 'error' && (
                  <button
                    type="button"
                    onClick={() => retryAttachment(a.key)}
                    className="shrink-0 text-[10px] font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(a.key)}
                  className="shrink-0 rounded p-0.5 text-black/30 hover:bg-black/10 hover:text-black/60 dark:text-white/30 dark:hover:bg-white/10 dark:hover:text-white/60"
                  aria-label={`Remove ${a.file.name}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {(attachmentError || failedAttachmentCount > 0) && (
          <p className="flex items-start gap-1.5 px-2 pb-1.5 text-[11px] text-red-600 dark:text-red-400">
            <TriangleAlert size={12} className="mt-px shrink-0" />
            <span>{attachmentError ?? `${failedAttachmentCount} attachment${failedAttachmentCount === 1 ? '' : 's'} failed to upload.`}</span>
          </p>
        )}

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
          <Button type="button" size="sm" disabled={sendDisabled} onClick={() => void send()}>
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
