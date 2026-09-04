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
import { Loader2, Minus, Plus, Trash2 } from 'lucide-react'
import { useTheme } from '@/components/theme/theme-provider'
import type { ReviewComment, ReviewCommentSide } from '@/lib/review-comments'

/** Draft comment as the composer submits it — the server assigns id/author. */
export interface NewReviewComment {
  side: ReviewCommentSide
  lineNumber: number
  body: string
  lineContent: string | null
}

/**
 * One hunk of this file's patch, as the server measured it.
 *
 * Structurally the same as `SessionHunk` from
 * `app/(app)/workspace/[workspaceSlug]/work/git-actions.ts`, declared here
 * rather than imported so this component keeps no dependency on a `'use
 * server'` module — the viewer is also used by the run-review surface, which
 * has no index to stage into.
 *
 * `fingerprint` is what actually identifies the hunk to the server; `index` is
 * only its position in the patch these numbers came from.
 */
export interface StageableHunk {
  index: number
  fingerprint: string
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  additions: number
  deletions: number
}

/** What one extend row carries. A hunk's action row and a line comment can
 * land on the same line, so it is one payload with both slots rather than two
 * competing `extendData` maps — the library allows exactly one entry per
 * (side, line). */
interface ExtendPayload {
  comments: ReviewComment[]
  hunk: StageableHunk | null
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
  hunks,
  hunkAction,
  onHunkAction,
  pendingHunk,
  enableComments = true,
}: {
  filePath: string
  oldPath: string | null
  patch: string
  /** Every comment on THIS file, open and already-sent. */
  comments: ReviewComment[]
  onAddComment: (draft: NewReviewComment) => void
  onDeleteComment: (id: number) => void
  wrap: boolean
  /** Hunk boundaries for THIS patch. Omitted (or empty) means no staging
   * affordance at all, which is the run-review surface's case: its diff is a
   * commit range, where there is no index for a hunk to move into. */
  hunks?: StageableHunk[]
  /** Which direction the button offers — a diff of the worktree can only be
   * staged, a diff of the index can only be unstaged. */
  hunkAction?: 'stage' | 'unstage'
  onHunkAction?: (hunk: StageableHunk) => void
  /** Fingerprint of the hunk currently being applied, if any. */
  pendingHunk?: string | null
  /** Off for hosts with nowhere to put a comment — the staging panel in the
   * Work rail has no review-comment store, and leaving the per-line "+"
   * showing there would be a button that silently does nothing. */
  enableComments?: boolean
}) {
  const { resolvedTheme } = useTheme()

  // Keyed by line number per side, which is exactly the shape `extendData`
  // wants — built once per comment-set change rather than filtered per row,
  // because `renderExtendLine` runs for every annotated line and an O(n) scan
  // inside it turns a 40-comment review into a 40x walk on every paint.
  const extendData = useMemo(() => {
    const oldFile: Record<string, { data: ExtendPayload }> = {}
    const newFile: Record<string, { data: ExtendPayload }> = {}
    const slot = (bucket: Record<string, { data: ExtendPayload }>, line: number) => {
      const key = String(line)
      if (!bucket[key]) bucket[key] = { data: { comments: [], hunk: null } }
      return bucket[key].data
    }
    for (const comment of comments) {
      slot(comment.side === 'old' ? oldFile : newFile, comment.lineNumber).comments.push(comment)
    }
    // The action row is anchored to the hunk's LAST line, so it reads as the
    // end of the block it acts on rather than interrupting it. The library has
    // no per-hunk render slot (there is `renderExtendLine` and
    // `renderWidgetLine`, both per line, and nothing keyed to a `@@` header),
    // so a line anchor is the only way to get the control INSIDE the scroll
    // flow — and being in the flow is the point: a floating button would have
    // to track a row that moves as hunks are staged away.
    for (const hunk of hunks ?? []) {
      // A pure deletion has no new-side line to hang from; use the old side.
      const onNew = hunk.newLines > 0
      const line = onNew ? hunk.newStart + hunk.newLines - 1 : hunk.oldStart + hunk.oldLines - 1
      if (line < 1) continue
      slot(onNew ? newFile : oldFile, line).hunk = hunk
    }
    return { oldFile, newFile }
  }, [comments, hunks])

  const lang = useMemo(() => langFromPath(filePath), [filePath])

  return (
    <div className="min-w-0 text-xs">
      <DiffView<ExtendPayload>
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
        diffViewAddWidget={enableComments}
        extendData={extendData}
        renderWidgetLine={
          enableComments
            ? ({ diffFile, side, lineNumber, onClose }) => (
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
              )
            : undefined
        }
        renderExtendLine={({ data, side, lineNumber }) => {
          // `data` really can arrive undefined: the library computes the
          // rendered node for BOTH sides whenever either side has an entry,
          // and only then decides which one to mount.
          const payload: ExtendPayload = data ?? { comments: [], hunk: null }
          const hunk = payload.hunk
          return (
            // Rendered per (side, line); the key is only here so React does
            // not reuse one line's row DOM for another's when rows shift.
            <div key={`${splitSideToSide(side)}:${lineNumber}`}>
              {payload.comments.length > 0 && (
                <CommentThread comments={payload.comments} onDelete={onDeleteComment} />
              )}
              {hunk && onHunkAction && hunkAction && (
                <HunkActionRow
                  hunk={hunk}
                  action={hunkAction}
                  busy={pendingHunk === hunk.fingerprint}
                  onAct={() => onHunkAction(hunk)}
                />
              )}
            </div>
          )
        }}
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

/**
 * The stage/unstage control for one hunk, sitting in the scroll flow at the
 * end of the block it acts on.
 *
 * The `@@` header is shown because it is the only durable name a hunk has —
 * when the button reports "this hunk no longer applies", the header is what
 * lets a person find what moved. The counts are shown because "+3 −1" is the
 * fastest possible answer to "what am I about to stage".
 */
function HunkActionRow({
  hunk,
  action,
  busy,
  onAct,
}: {
  hunk: StageableHunk
  action: 'stage' | 'unstage'
  busy: boolean
  onAct: () => void
}) {
  return (
    <div className="flex items-center gap-2 border-y border-black/10 bg-black/[.03] px-2 py-1 font-sans dark:border-white/10 dark:bg-white/[.05]">
      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-black/40 dark:text-white/40">
        {hunk.header}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-black/50 dark:text-white/50">
        +{hunk.additions} −{hunk.deletions}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={onAct}
        className="flex shrink-0 items-center gap-1 rounded border border-black/10 px-1.5 py-0.5 text-[11px] font-medium hover:bg-black/[.06] disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.10]"
      >
        {busy ? (
          <Loader2 size={11} className="animate-spin" />
        ) : action === 'stage' ? (
          <Plus size={11} />
        ) : (
          <Minus size={11} />
        )}
        {action === 'stage' ? 'Stage hunk' : 'Unstage hunk'}
      </button>
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
