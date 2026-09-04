'use client'

import { useMemo, useState } from 'react'
import { FileDiff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopyButton } from './CopyButton'

/**
 * Coloured unified-diff renderer.
 *
 * Agents produce diffs constantly — `file_change` RunEvents carry one
 * directly, and edit/write tools return one as their output — and until now
 * every one of them rendered as undifferentiated grey monospace, which is the
 * one format where colour is doing real work rather than decoration. Parsing
 * is deliberately line-shaped rather than a real patch parser: a unified diff
 * is defined line-by-line, the agent's output is not guaranteed to be a
 * well-formed patch, and a parser that throws on malformed input would lose
 * the content entirely instead of showing it plainly.
 */

type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'

interface DiffLine {
  kind: DiffLineKind
  text: string
  /** Line numbers as of the old/new file, tracked through the hunk headers so
   * the gutter matches what an editor would show. Null on hunk/meta rows. */
  oldNo: number | null
  newNo: number | null
}

function classifyLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk'
  // `+++`/`---` are file headers, not content — checked before the single-
  // character cases so they aren't miscoloured as a giant add/delete.
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity index') || line.startsWith('rename ')) {
    return 'meta'
  }
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const text of diff.replace(/\r\n/g, '\n').split('\n')) {
    const kind = classifyLine(text)
    if (kind === 'hunk') {
      // "@@ -12,7 +12,9 @@" — the two starting line numbers reset the gutter.
      const match = /^@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/.exec(text)
      if (match) {
        oldNo = Number(match[1])
        newNo = Number(match[2])
      }
      out.push({ kind, text, oldNo: null, newNo: null })
      continue
    }
    if (kind === 'meta') {
      out.push({ kind, text, oldNo: null, newNo: null })
      continue
    }
    if (kind === 'add') {
      out.push({ kind, text, oldNo: null, newNo: newNo++ })
      continue
    }
    if (kind === 'del') {
      out.push({ kind, text, oldNo: oldNo++, newNo: null })
      continue
    }
    out.push({ kind, text, oldNo: oldNo++, newNo: newNo++ })
  }
  // A trailing newline in the source produces one empty context row that is
  // pure noise in the rendered output.
  if (out.length > 0 && out[out.length - 1].text === '' && out[out.length - 1].kind === 'context') out.pop()
  return out
}

/**
 * True when a blob is worth rendering as a diff. Intentionally strict: a
 * prose answer that happens to start a line with "-" (a bullet list, very
 * common in agent output) must NOT be recoloured as deletions, so a real hunk
 * header is required rather than merely counting +/- prefixes.
 */
export function looksLikeDiff(text: string): boolean {
  if (!text) return false
  if (!/^@@ .*@@/m.test(text)) return false
  return /^[+-]/m.test(text)
}

const LINE_STYLES: Record<DiffLineKind, string> = {
  add: 'bg-emerald-500/[0.10] text-emerald-800 dark:text-emerald-300',
  del: 'bg-red-500/[0.10] text-red-700 dark:text-red-300',
  hunk: 'bg-sky-500/[0.08] text-sky-700 dark:text-sky-300',
  meta: 'text-black/40 dark:text-white/40',
  context: 'text-black/70 dark:text-white/60',
}

/** Diffs can be enormous; only the head renders until asked for the rest. */
const COLLAPSE_AFTER_LINES = 300

export function DiffBlock({ diff, path, className }: { diff: string; path?: string; className?: string }) {
  const lines = useMemo(() => parseDiff(diff), [diff])
  const [expanded, setExpanded] = useState(false)

  const { added, removed } = useMemo(() => {
    let added = 0
    let removed = 0
    for (const line of lines) {
      if (line.kind === 'add') added += 1
      else if (line.kind === 'del') removed += 1
    }
    return { added, removed }
  }, [lines])

  const hiddenCount = expanded ? 0 : Math.max(0, lines.length - COLLAPSE_AFTER_LINES)
  const visible = hiddenCount > 0 ? lines.slice(0, COLLAPSE_AFTER_LINES) : lines

  return (
    <div className={cn('overflow-hidden rounded-lg border border-black/10 dark:border-white/10', className)}>
      <div className="flex items-center gap-2 border-b border-black/10 bg-black/[0.02] px-3 py-1.5 text-xs dark:border-white/10 dark:bg-white/[0.03]">
        <FileDiff size={13} className="shrink-0 text-black/40 dark:text-white/40" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-black/70 dark:text-white/70">
          {path ?? 'diff'}
        </span>
        {added > 0 && <span className="tabular-nums text-emerald-600 dark:text-emerald-400">+{added}</span>}
        {removed > 0 && <span className="tabular-nums text-red-600 dark:text-red-400">−{removed}</span>}
        <CopyButton value={diff} />
      </div>

      <div className="overflow-x-auto">
        <pre className="min-w-full font-mono text-[11.5px] leading-[1.55]">
          {visible.map((line, idx) => (
            <div key={idx} className={cn('flex', LINE_STYLES[line.kind])}>
              {/* Gutters are `select-none` so copying the rendered diff yields
                  a diff again, not one interleaved with line numbers. */}
              <span className="w-9 shrink-0 select-none px-1 text-right text-black/25 dark:text-white/25">
                {line.oldNo ?? ''}
              </span>
              <span className="w-9 shrink-0 select-none px-1 text-right text-black/25 dark:text-white/25">
                {line.newNo ?? ''}
              </span>
              <span className="whitespace-pre px-2">{line.text === '' ? ' ' : line.text}</span>
            </div>
          ))}
        </pre>
      </div>

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-black/10 px-3 py-1.5 text-left text-xs text-black/45 transition hover:bg-black/[0.03] hover:text-black dark:border-white/10 dark:text-white/45 dark:hover:bg-white/[0.04] dark:hover:text-white"
        >
          Show {hiddenCount} more line{hiddenCount === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}
