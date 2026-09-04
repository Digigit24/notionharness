'use client'

import { ReactNode } from 'react'
import { Bot, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopyButton } from './CopyButton'
import { formatRelativeTime, formatTimestamp } from '@/lib/relative-time'

/**
 * Message bubble component for rendering individual messages.
 * Supports user, assistant, and system roles with styling variants.
 */
export interface MessageProps {
  role: 'user' | 'assistant' | 'system'
  children?: ReactNode
  className?: string
  /** Real event time — surfaced on hover so a reader can orient in a long
   * conversation without timestamps cluttering every row. */
  createdAt?: Date
  /** Prose to offer on the hover copy button. Omitted for messages whose
   * content is entirely tool/terminal blocks (those copy their own output). */
  copyText?: string
  /** Shown under a user bubble that has not been confirmed by the server
   * yet. Pressing Enter paints the message immediately; this is what tells
   * the reader the difference between "sent" and "on screen". */
  delivery?: 'sending' | 'failed'
  /** Offered on assistant replies when the surface can promote one into a
   * page. Absent means the action is not available here. */
  onConvertToPage?: () => void
}

export function Message({
  role,
  children,
  className,
  createdAt,
  copyText,
  delivery,
  onConvertToPage,
}: MessageProps) {
  const stamp = createdAt ? formatRelativeTime(createdAt.toISOString()) : undefined
  const exact = createdAt ? formatTimestamp(createdAt) : undefined
  if (role === 'system') {
    return (
      <div className="flex justify-center">
        <div className={cn('rounded-full bg-black/[0.04] px-3 py-1 text-xs italic text-black/40 dark:bg-white/[0.06] dark:text-white/40', className)}>
          {children}
        </div>
      </div>
    )
  }

  if (role === 'user') {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <div className="group flex items-end justify-end gap-1.5" title={exact}>
          {copyText && <CopyButton value={copyText} className="mb-1" />}
          <div
            className={cn(
              // Bubble (rendered inside `children`) owns its own padding —
              // this wrapper only owns background/shape, so text isn't
              // double-padded.
              'max-w-[82%] overflow-hidden rounded-2xl rounded-br-sm bg-primary text-primary-foreground',
              // An unconfirmed message is dimmed rather than hidden: the text
              // is real and readable, it simply has not landed yet.
              delivery === 'sending' && 'opacity-70',
              delivery === 'failed' && 'opacity-70 ring-1 ring-destructive/50',
              className,
            )}
          >
            {children}
          </div>
        </div>
        {delivery && (
          <span
            className={cn(
              'pr-1 text-[10px]',
              delivery === 'failed' ? 'text-destructive' : 'text-black/35 dark:text-white/35',
            )}
          >
            {delivery === 'failed' ? 'Not sent' : 'Sending…'}
          </span>
        )}
      </div>
    )
  }

  // Assistant content flows next to its avatar with no outer bubble chrome
  // — each content piece (text/thinking/tool-call/terminal) already draws
  // its own card where it needs one, matching how assistant-style chat UIs
  // (this codebase's own reference point) render agent turns: an avatar and
  // a column of blocks, not a single boxed bubble around everything.
  return (
    <div className="group flex max-w-[92%] gap-2" title={exact}>
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-black/50 dark:bg-white/10 dark:text-white/50">
        <Bot size={13} />
      </div>
      <div className={cn('min-w-0 flex-1', className)}>
        {children}
        {(copyText || stamp || onConvertToPage) && (
          <div className="flex items-center gap-2 px-3 pt-0.5">
            {copyText && <CopyButton value={copyText} />}
            {onConvertToPage && (
              // A good answer should not be trapped in a chat log. Appears on
              // hover beside Copy, so the row stays quiet until wanted.
              <button
                type="button"
                onClick={onConvertToPage}
                title="Turn this reply into a page"
                className="flex items-center gap-1 text-[11px] text-black/25 opacity-0 transition hover:text-black/60 group-hover:opacity-100 dark:text-white/25 dark:hover:text-white/60"
              >
                <FileText size={11} />
                Save as page
              </button>
            )}
            {stamp && (
              <span className="text-[11px] text-black/25 opacity-0 transition group-hover:opacity-100 dark:text-white/25">
                {stamp}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
