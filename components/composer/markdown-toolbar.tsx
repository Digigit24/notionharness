'use client'

import type { RefObject } from 'react'
import { Bold, Code, Italic, List, Quote, SquareCode } from 'lucide-react'
import { insertCodeFence, toggleLinePrefix, toggleWrap, type TextEdit } from '@/lib/markdown-lite'

/**
 * The markdown-lite toolbar (bold/italic/code/quote/list/fence), factored out
 * of `components/teams/message-composer.tsx`'s own inline `toolbar`/
 * `ToolbarButton` (R14-P0.4) so the Work hero composer gets the same six
 * actions without a second hand-rolled copy of the caret-restoring dance
 * `applyTextEdit` does there. `lib/markdown-lite.ts` was already standalone
 * and needed no changes; this is the UI half that sat inside the channel
 * composer instead.
 *
 * NOT wired back into `message-composer.tsx` — see `use-attachment-uploads.ts`'s
 * header for why that file is read-only for this unit of work.
 */

/** One toolbar button. `onMouseDown` prevents the default focus steal so
 * clicking a button never loses the textarea's current selection before the
 * handler acts on it — `message-composer.tsx`'s own reasoning for the same
 * pattern. */
export function ToolbarButton({
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

/** Applies a `TextEdit` to a controlled textarea and restores its selection
 * on the next frame — React re-renders the textarea with the new value and
 * would otherwise drop the caret to the end. */
export function useMarkdownActions(
  value: string,
  setValue: (next: string) => void,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
) {
  const applyTextEdit = (edit: TextEdit) => {
    setValue(edit.value)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(edit.selectionStart, edit.selectionEnd)
    })
  }

  const withSelection = (fn: (v: string, s: number, e: number) => TextEdit) => {
    const el = textareaRef.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    return fn(value, start, end)
  }

  return {
    bold: () => applyTextEdit(withSelection((v, s, e) => toggleWrap(v, s, e, '**'))),
    italic: () => applyTextEdit(withSelection((v, s, e) => toggleWrap(v, s, e, '_'))),
    code: () => applyTextEdit(withSelection((v, s, e) => toggleWrap(v, s, e, '`'))),
    quote: () => applyTextEdit(withSelection((v, s, e) => toggleLinePrefix(v, s, e, '> '))),
    list: () => applyTextEdit(withSelection((v, s, e) => toggleLinePrefix(v, s, e, '- '))),
    codeBlock: () => applyTextEdit(withSelection((v, s, e) => insertCodeFence(v, s, e))),
  }
}

export function MarkdownToolbar({
  value,
  setValue,
  textareaRef,
  disabled,
  children,
}: {
  value: string
  setValue: (next: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  disabled?: boolean
  /** The attach button (and anything else) sits after the markdown group —
   * a slot rather than a hard-coded prop, since not every consumer wants
   * attachments in the same toolbar. */
  children?: React.ReactNode
}) {
  const actions = useMarkdownActions(value, setValue, textareaRef)
  return (
    <div className="flex items-center gap-0.5">
      <ToolbarButton icon={Bold} label="Bold (Ctrl+B)" onClick={actions.bold} disabled={disabled} />
      <ToolbarButton icon={Italic} label="Italic (Ctrl+I)" onClick={actions.italic} disabled={disabled} />
      <ToolbarButton icon={Code} label="Inline code" onClick={actions.code} disabled={disabled} />
      <ToolbarButton icon={Quote} label="Quote" onClick={actions.quote} disabled={disabled} />
      <ToolbarButton icon={List} label="List" onClick={actions.list} disabled={disabled} />
      <ToolbarButton icon={SquareCode} label="Code block" onClick={actions.codeBlock} disabled={disabled} />
      {children}
    </div>
  )
}
