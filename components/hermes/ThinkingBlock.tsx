'use client'

import { useEffect, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDuration } from './format-duration'

/**
 * A reasoning block. Open while it's the live edge of the turn, collapsed
 * once prose starts arriving after it.
 *
 * Thinking is scaffolding: useful to watch as it happens, noise to scroll
 * past afterwards. Leaving every block expanded turned a finished answer
 * into a wall of planning notes with the actual reply buried inside it. The
 * collapse is automatic but never destructive — the header stays clickable,
 * and a manual toggle sticks (so re-reading an old block doesn't get undone
 * by the next chunk arriving).
 */
/**
 * Hermes emits reasoning as a run of bold-headed fragments — `**Planning the
 * file listing**`, `**Confirming the directory**` — which merge into one
 * block. Rendered raw they showed literal asterisks, and consecutive headings
 * ran together mid-sentence ("Searching files in target directory Initiating
 * top-level file search"). Promoting each heading to its own line is enough
 * to make the block readable; full markdown parsing here would be a
 * dependency and an XSS surface for text nobody needs formatted.
 */
function humanizeThinking(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, (_match, heading: string) => `\n${heading}\n`)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function ThinkingBlock({
  text,
  durationMs,
  superseded,
  streaming,
}: {
  text: string
  durationMs?: number
  /** True once later content exists — i.e. the agent moved on from this. */
  superseded: boolean
  streaming?: boolean
}) {
  const [manual, setManual] = useState<boolean | null>(null)
  // Auto-state follows the turn; a manual click pins it and wins from then on.
  const open = manual ?? !superseded

  useEffect(() => {
    // A block that gets superseded while the user hasn't touched it should
    // fold on its own — but if they already expanded it deliberately, leave
    // their choice alone.
    if (superseded && manual === null) setManual(null)
  }, [superseded, manual])

  return (
    <div className="rounded-md border border-black/10 bg-black/[0.02] dark:border-white/10 dark:bg-white/[0.03]">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left"
      >
        <ChevronRight
          size={12}
          className={cn('shrink-0 text-black/30 transition-transform dark:text-white/30', open && 'rotate-90')}
        />
        <Brain size={11} className="shrink-0 text-black/35 dark:text-white/35" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-black/35 dark:text-white/35">
          Thinking
        </span>
        {durationMs != null && durationMs > 0 && (
          <span className="text-[11px] text-black/30 dark:text-white/30">· {formatDuration(durationMs)}</span>
        )}
        {streaming && <span className="ml-auto text-[11px] text-black/30 dark:text-white/30">…</span>}
        {!open && !streaming && (
          <span className="ml-auto max-w-[50%] truncate text-[11px] italic text-black/25 dark:text-white/25">
            {humanizeThinking(text).replace(/\n+/g, ' · ')}
          </span>
        )}
      </button>
      {open && (
        <div className="whitespace-pre-wrap break-words px-2.5 pb-2 text-[13px] italic leading-relaxed text-black/55 dark:text-white/50">
          {humanizeThinking(text)}
        </div>
      )}
    </div>
  )
}
