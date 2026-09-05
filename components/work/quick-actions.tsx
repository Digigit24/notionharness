'use client'

import { Bug, ChevronDown, FileText, ListTodo, SearchCode, TestTube2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * The hero composer's quick-action starter chips.
 *
 * Wording is this app's own — a coding/agent-ops product — rather than the
 * unrelated reference screenshot's ("Design a website", "Source candidates"),
 * per this unit's own brief. Clicking one FILLS the composer; it never sends
 * on its own, since a one-line starter is rarely the whole ask and an
 * accidental send would cost a real turn.
 */
const STARTERS = [
  { icon: Bug, label: 'Fix a bug', text: 'Help me track down and fix a bug: ' },
  { icon: SearchCode, label: 'Review a PR', text: 'Review this pull request for correctness and style: ' },
  { icon: ListTodo, label: 'Plan a feature', text: 'Help me plan the implementation of a new feature: ' },
  { icon: FileText, label: 'Summarize changes', text: 'Summarize what changed on this branch and why.' },
] as const

/** A second row of starters, tucked behind "More…" rather than shown up
 * front — four chips already covers the common cases, and a wider row would
 * crowd the composer above it more than it would help. */
const MORE_STARTERS = [
  { label: 'Write tests', text: 'Write tests for ' },
  { label: 'Explain this code', text: 'Explain what this code does: ' },
] as const

export function QuickActions({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
      {STARTERS.map(({ icon: Icon, label, text }) => (
        <button
          key={label}
          type="button"
          onClick={() => onPick(text)}
          className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-black/65 transition hover:border-black/20 hover:bg-black/[.02] dark:border-white/15 dark:bg-white/[.03] dark:text-white/65 dark:hover:border-white/25"
        >
          <Icon size={12} />
          {label}
        </button>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-black/65 transition hover:border-black/20 hover:bg-black/[.02] dark:border-white/15 dark:bg-white/[.03] dark:text-white/65 dark:hover:border-white/25"
          >
            More…
            <ChevronDown size={11} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          {MORE_STARTERS.map((s) => (
            <DropdownMenuItem key={s.label} onClick={() => onPick(s.text)}>
              <TestTube2 size={12} className="mr-1.5" />
              {s.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
