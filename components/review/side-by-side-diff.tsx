'use client'

// R5.2 / R5.3 — the side-by-side diff, and the comment widgets pinned to a
// side and a line.
//
// Why `@git-diff-view/react` and not the renderer we already have: R5.3 needs
// an arbitrary React node anchored to (file, side, line) and living INSIDE the
// scroll flow, so the rows below it move down instead of the comment floating
// over them. That is a layout primitive, not a styling detail, and it is the
// one thing `components/thread/DiffBlock.tsx` cannot be made to do without
// becoming a second diff engine. It is also why DiffBlock stays exactly as it
// is (roadmap R5.2a): the thread renders agent output of unknown shape, where
// a parser that throws loses the message, and this library parses properly and
// therefore can throw. Two renderers, for two genuinely different jobs.
import { useMemo, useState } from 'react'
import { DiffModeEnum, DiffView, SplitSide, type DiffFile } from '@git-diff-view/react'
// Every rule in this stylesheet is scoped under `.diff-tailwindcss-wrapper`
// (checked in node_modules before importing it) — it carries no preflight and
// cannot reach the rest of the app, so a plain global import is safe here and
// avoids a second Tailwind build step.
import '@git-diff-view/react/styles/diff-view.css'
import { Trash2 } from 'lucide-react'
import { useTheme } from '@/components/theme/theme-provider'
import type { ReviewComment, ReviewCommentSide } from '@/lib/review-comments'

/** Draft comment as the composer submits it — the server assigns id/author. */
export interface NewReviewComment {
  side: ReviewCommentSide
  lineNumber: number
  body: string
  lineContent: string | null
}

// Highlighting is worth having and not worth a lookup table of every language
// on earth: `lowlight` (bundled with the library) resolves by name, so the
// extension is passed straight through for anything not renamed below and an
// unknown one simply renders unhighlighted rather than failing.
function langFromPath(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  const ext = path.slice(dot + 1).toLowerCase()
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript'
    case 'tsx':
      return 'tsx'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'jsx':
      return 'jsx'
    case 'md':
      return 'markdown'
    case 'yml':
      return 'yaml'
    default:
      return ext
  }
}

function splitSideToSide(side: SplitSide): ReviewCommentSide {
  return side === SplitSide.old ? 'old' : 'new'
}

export function SideBySideDiff({
  filePath,
  oldPath,
  patch,
  comments,
  onAddComment,
  onDeleteComment,
  wrap,
}: {
  filePath: string
  oldPath: string | null
  patch: string
  /** Every comment on THIS file, open and already-sent. */
  comments: ReviewComment[]
  onAddComment: (draft: NewReviewComment) => void
  onDeleteComment: (id: number) => void
  wrap: boolean
}) {
  const { resolvedTheme } = useTheme()

  // Keyed by line number per side, which is exactly the shape `extendData`
  // wants — built once per comment-set change rather than filtered per row,
  // because `renderExtendLine` runs for every annotated line and an O(n) scan
  // inside it turns a 40-comment review into a 40x walk on every paint.
  const extendData = useMemo(() => {
    const oldFile: Record<string, { data: ReviewComment[] }> = {}
    const newFile: Record<string, { data: ReviewComment[] }> = {}
    for (const comment of comments) {
      const bucket = comment.side === 'old' ? oldFile : newFile
      const key = String(comment.lineNumber)
      if (!bucket[key]) bucket[key] = { data: [] }
      bucket[key].data.push(comment)
    }
    return { oldFile, newFile }
  }, [comments])

  const lang = useMemo(() => langFromPath(filePath), [filePath])

  return (
    <div className="min-w-0 text-xs">
      <DiffView<ReviewComment[]>
        data={{
          // One element, the whole per-file patch: `DiffFile` parses each
          // string in `hunks` as an independent diff, and `getFileDiff`
          // already returns exactly one file's `git diff` output. Splitting it
          // into individual @@ blocks here would throw away the headers the
          // parser needs to know a file was added, deleted or renamed.
          hunks: [patch],
          oldFile: { fileName: oldPath ?? filePath, fileLang: lang },
          newFile: { fileName: filePath, fileLang: lang },
        }}
        diffViewMode={DiffModeEnum.Split}
        diffViewWrap={wrap}
        diffViewHighlight
        diffViewTheme={resolvedTheme}
        diffViewFontSize={12}
        // Turns on the per-line "+" that opens `renderWidgetLine`. Known
        // limitation, from the library rather than from us: it is gated on
        // `hasDiff` (DiffSplitContentLineNormal.tsx), so a comment can be
        // anchored to an added or removed line but NOT to an unchanged context
        // line. Working around it would mean forking the line renderer; for a
        // review of what a run changed, commenting on changed lines is the
        // case that matters, so it is recorded here rather than papered over.
        diffViewAddWidget
        extendData={extendData}
        renderWidgetLine={({ diffFile, side, lineNumber, onClose }) => (
          <CommentComposer
            onCancel={onClose}
            onSubmit={(body) => {
              onAddComment({
                side: splitSideToSide(side),
                lineNumber,
                body,
                lineContent: readLineContent(diffFile, side, lineNumber),
              })
              onClose()
            }}
          />
        )}
        renderExtendLine={({ data, side, lineNumber }) => (
          <CommentThread
            // Rendered per (side, line); the key is only here so React does
            // not reuse one line's thread DOM for another's when rows shift.
            key={`${splitSideToSide(side)}:${lineNumber}`}
            comments={data}
            onDelete={onDeleteComment}
          />
        )}
      />
    </div>
  )
}

/**
 * The text of the line being commented on, captured at comment time.
 *
 * Wrapped in try/catch on purpose: `getSplitLineByLineNumber` indexes into
 * arrays built by the split-mode pass, and a line inside a collapsed region
 * (or an old-side lookup on a pure addition) legitimately has no entry. A
 * missing quote degrades the prompt slightly; a thrown error would take the
 * whole review surface down mid-comment.
 */
function readLineContent(diffFile: DiffFile, side: SplitSide, lineNumber: number): string | null {
  try {
    return diffFile.getSplitLineByLineNumber(lineNumber, side)?.value ?? null
  } catch {
    return null
  }
}

function CommentComposer({ onSubmit, onCancel }: { onSubmit: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState('')
  const trimmed = body.trim()
  return (
    <div className="border-y border-black/10 bg-black/[.03] p-2 dark:border-white/10 dark:bg-white/[.04]">
      <textarea
        autoFocus
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        // Cmd/Ctrl+Enter to add, Escape to abandon. This matters more than the
        // usual keyboard-shortcut politeness: the entire feature is "write
        // several, send once", so adding one must never require the mouse.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && trimmed) {
            e.preventDefault()
            onSubmit(trimmed)
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        placeholder="Comment on this line — batched with the rest until you press Send."
        aria-label="Comment on this line"
        className="w-full rounded border border-black/10 bg-white px-2 py-1.5 font-sans text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:border-white/10 dark:bg-black"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 font-sans text-xs hover:bg-black/[.06] dark:hover:bg-white/[.08]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!trimmed}
          onClick={() => onSubmit(trimmed)}
          className="rounded bg-black px-2 py-1 font-sans text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
        >
          Add comment
        </button>
      </div>
    </div>
  )
}

function CommentThread({ comments, onDelete }: { comments: ReviewComment[]; onDelete: (id: number) => void }) {
  return (
    <div className="border-y border-black/10 bg-amber-500/[.07] px-2 py-1.5 font-sans dark:border-white/10">
      {comments.map((comment) => (
        <div key={comment.id} className="group flex items-start gap-2 py-0.5">
          <span
            className={`mt-0.5 shrink-0 rounded px-1 text-[10px] font-medium uppercase tracking-wide ${
              comment.status === 'sent'
                ? 'bg-black/[.06] text-black/50 dark:bg-white/[.10] dark:text-white/50'
                : 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
            }`}
          >
            {comment.status === 'sent' ? 'sent' : 'draft'}
          </span>
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs">{comment.body}</p>
          {/* Sent comments are deliberately not deletable: they are the record
              the revision gets checked against. */}
          {comment.status === 'open' && (
            <button
              type="button"
              onClick={() => onDelete(comment.id)}
              aria-label="Delete comment"
              className="shrink-0 rounded p-1 text-black/30 opacity-0 transition-opacity hover:bg-black/[.06] hover:text-black/70 focus-visible:opacity-100 group-hover:opacity-100 dark:text-white/30 dark:hover:bg-white/[.08] dark:hover:text-white/70"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
