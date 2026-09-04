'use client'

/**
 * R5.2 + R5.3 — the run review surface: side-by-side diff, line-anchored
 * comments, and ONE send.
 *
 * This replaced `components/runs/review-panel.tsx` (now deleted) as the review route
 * renders. It is a new file rather than an edit because that one was outside
 * this unit's owned paths; the chrome it shares (DetailLayout, the run rail,
 * approve-and-merge) is reproduced here rather than imported because that file
 * exports only the panel. The old panel is now unreferenced and should be
 * deleted by whoever owns `components/runs/` — flagged, not silently left to
 * rot.
 *
 * The batching is the point, and it drives the layout: comments accumulate as
 * rows attached to lines, the diff shows all of them at once, and a single
 * "Send N comments" composes the lot into one prompt and delivers it as one
 * turn. Sending one comment at a time would mean a dozen full model latencies
 * per review, each revision blind to the remarks that follow it.
 */
import { useCallback, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { FileWarning, GitBranch, Send, WrapText } from 'lucide-react'
import {
  addReviewCommentAction,
  approveAndMergeRun,
  deleteReviewCommentAction,
  getFileDiffAction,
  sendReviewCommentsAction,
} from '@/app/(app)/workspace/[workspaceSlug]/runs/[runId]/review/actions'
import type { ChangedFile, WorktreeState } from '@/lib/run-worktrees/diff'
import type { ReviewComment } from '@/lib/review-comments'
import type { Run, RunStatus } from '@/lib/broker'
import { DetailLayout, type DetailLayoutTab } from '@/components/layout/detail-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatTimestamp } from '@/lib/relative-time'
import { ReviewFileTree, buildFileTree } from './file-tree'
import { SideBySideDiff, type NewReviewComment } from './side-by-side-diff'

const STATUS_BADGE_VARIANT: Record<RunStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  failed: 'destructive',
  cancelled: 'outline',
  queued: 'secondary',
  dispatched: 'secondary',
  running: 'secondary',
  waiting_directory: 'secondary',
}

interface PatchState {
  patch: string
  /** `git diff` says so in the body rather than in a status letter. */
  isBinary: boolean
}

function isBinaryPatch(patch: string): boolean {
  return patch.includes('Binary files ') && patch.includes(' differ')
}

export function ReviewSurface({
  workspaceSlug,
  run,
  taskTitle,
  agentName,
  worktreeState,
  files,
  initialComments,
  initialPatches,
}: {
  workspaceSlug: string
  run: Run
  taskTitle: string | null
  agentName: string | null
  worktreeState: WorktreeState
  files: ChangedFile[]
  initialComments: ReviewComment[]
  /** Patches the server already had when it rendered — at minimum the first
   * file's, so the diff is on screen at first paint instead of after a round
   * trip. Keyed by path. */
  initialPatches: Record<string, string>
}) {
  const tree = useMemo(() => buildFileTree(files), [files])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree.map((n) => n.path)))
  const [selected, setSelected] = useState<ChangedFile | null>(files[0] ?? null)
  const [patches, setPatches] = useState<Record<string, PatchState>>(() =>
    Object.fromEntries(
      Object.entries(initialPatches).map(([path, patch]) => [path, { patch, isBinary: isBinaryPatch(patch) }]),
    ),
  )
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [comments, setComments] = useState<ReviewComment[]>(initialComments)
  const [note, setNote] = useState('')
  const [wrap, setWrap] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Comment writes are optimistic; the persist runs in a transition so a slow
  // database never blocks the next comment being typed.
  const [, startPersist] = useTransition()

  const openComments = useMemo(() => comments.filter((c) => c.status === 'open'), [comments])
  const openCountsByFile = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of openComments) counts.set(c.filePath, (counts.get(c.filePath) ?? 0) + 1)
    return counts
  }, [openComments])
  const commentsForSelected = useMemo(
    () => (selected ? comments.filter((c) => c.filePath === selected.path) : []),
    [comments, selected],
  )

  const loadPatch = useCallback(
    async (file: ChangedFile, { silent }: { silent?: boolean } = {}) => {
      if (patches[file.path]) return
      if (!silent) setLoadingPath(file.path)
      try {
        const { patch } = await getFileDiffAction(run.id, file.path)
        setPatches((prev) => (prev[file.path] ? prev : { ...prev, [file.path]: { patch, isBinary: isBinaryPatch(patch) } }))
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : 'Failed to load diff.')
      } finally {
        if (!silent) setLoadingPath((prev) => (prev === file.path ? null : prev))
      }
    },
    [patches, run.id],
  )

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function selectFile(file: ChangedFile) {
    setSelected(file)
    void loadPatch(file)
  }

  function addComment(draft: NewReviewComment) {
    if (!selected) return
    // A negative temporary id: the row renders instantly, and the real row
    // swaps in when the insert returns. Waiting for the round trip here would
    // put full database latency between "I typed a comment" and "I can see
    // it", on the one interaction this feature expects you to repeat ten times
    // in a row.
    const tempId = -Date.now()
    const optimistic: ReviewComment = {
      id: tempId,
      runId: run.id,
      filePath: selected.path,
      side: draft.side,
      lineNumber: draft.lineNumber,
      body: draft.body,
      lineContent: draft.lineContent,
      authorUserId: null,
      status: 'open',
      sentRunId: null,
      sentAt: null,
      createdAt: new Date().toISOString(),
    }
    setComments((prev) => [...prev, optimistic])
    startPersist(async () => {
      try {
        const saved = await addReviewCommentAction({
          runId: run.id,
          filePath: optimistic.filePath,
          side: draft.side,
          lineNumber: draft.lineNumber,
          body: draft.body,
          lineContent: draft.lineContent,
        })
        setComments((prev) => prev.map((c) => (c.id === tempId ? saved : c)))
      } catch (err) {
        // Roll the optimistic row back rather than leaving a comment on screen
        // that no send will ever pick up — an unsent comment that looks sent
        // is the worst outcome this feature can produce.
        setComments((prev) => prev.filter((c) => c.id !== tempId))
        setError(err instanceof Error ? err.message : 'Failed to save comment.')
      }
    })
  }

  function deleteComment(id: number) {
    const previous = comments
    setComments((prev) => prev.filter((c) => c.id !== id))
    // A negative id was never persisted (its insert is still in flight or
    // already failed), so there is nothing to delete server-side.
    if (id < 0) return
    startPersist(async () => {
      try {
        await deleteReviewCommentAction(run.id, id)
      } catch (err) {
        setComments(previous)
        setError(err instanceof Error ? err.message : 'Failed to delete comment.')
      }
    })
  }

  async function handleSend() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await sendReviewCommentsAction(run.id, workspaceSlug, note)
      // Flip locally instead of refetching: the server just told us exactly
      // which run took the batch, and a re-read would be a round trip for
      // information already in hand. Flipped by the ids the server actually
      // marked — not by a pre-send snapshot, which would show an optimistic
      // comment whose insert had not landed yet as "sent" when the batch
      // never contained it.
      const sentIds = new Set(result.sentCommentIds)
      if (sentIds.size > 0) {
        setComments((prev) =>
          prev.map((c) =>
            sentIds.has(c.id) ? { ...c, status: 'sent', sentRunId: result.runId, sentAt: new Date().toISOString() } : c,
          ),
        )
      }
      // The note is only consumed if it actually went somewhere; clearing it
      // on the undelivered path would throw away the one copy the user still
      // has on screen.
      if (result.promptDelivered) setNote('')
      if (result.promptDelivered) {
        setNotice(
          result.deliveredAs === 'session-turn'
            ? `Sent ${result.commentCount} ${result.commentCount === 1 ? 'comment' : 'comments'} as one turn in this run's conversation (run #${result.runId}).`
            : `Sent ${result.commentCount} ${result.commentCount === 1 ? 'comment' : 'comments'} to run #${result.runId}.`,
        )
      } else {
        // Not a soft failure to bury: the follow-up run is real and queued,
        // but the composed prompt will not reach the agent, because
        // `buildPromptText` in lib/dispatcher/worker.ts ignores `run.prompt`
        // whenever the run has a task attached. Saying so is the only honest
        // option until the dispatcher is fixed.
        setError(
          `Queued follow-up run #${result.runId} with ${result.commentCount} comments — but this run has no conversation, and the dispatcher currently drops a task-scoped run's prompt (lib/dispatcher/worker.ts, buildPromptText). The composed review was saved to the task's Activity entry, and your comments are deliberately still unsent so they can be delivered for real once that is fixed.`,
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send review comments.')
    } finally {
      setBusy(false)
    }
  }

  async function handleApprove() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await approveAndMergeRun(run.id, workspaceSlug)
      if (result.merged) {
        setNotice(
          `Merged (${result.fastForward ? 'fast-forward' : 'merge commit'}${result.mergeCommit ? `: ${result.mergeCommit.slice(0, 10)}` : ''}).`,
        )
      } else {
        setError(result.error ?? 'Merge did not complete.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve and merge.')
    } finally {
      setBusy(false)
    }
  }

  const selectedPatch = selected ? patches[selected.path] : undefined

  const primaryAction = (
    <>
      <Button
        type="button"
        size="sm"
        disabled={busy || run.status !== 'completed'}
        onClick={() => void handleApprove()}
        title={run.status !== 'completed' ? 'Only a completed run can be approved and merged.' : undefined}
      >
        Approve &amp; merge
      </Button>
    </>
  )

  const diffTabContent = (
    <div className="flex min-h-0 flex-1 flex-col">
      {(notice || error) && (
        <div className="border-b border-black/10 px-6 py-2 dark:border-white/10">
          {notice && <p className="text-xs text-green-600 dark:text-green-400">{notice}</p>}
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}

      {!worktreeState.branchExists ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-black/50 dark:text-white/50">
            Nothing to review yet — no worktree/branch has been created for this run. That happens once a dispatcher
            actually executes the run; until then there&apos;s no diff to show.
          </p>
          <Link
            href={`/workspace/${workspaceSlug}/review`}
            className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
          >
            Back to Review list
          </Link>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-72 shrink-0 overflow-y-auto border-r border-black/10 p-2 dark:border-white/10">
            {files.length === 0 ? (
              <p className="p-2 text-xs text-black/40 dark:text-white/40">No file changes.</p>
            ) : (
              <ReviewFileTree
                nodes={tree}
                expanded={expanded}
                onToggle={toggle}
                selected={selected}
                onSelect={selectFile}
                onPrefetch={(file) => void loadPatch(file, { silent: true })}
                commentCounts={openCountsByFile}
              />
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-3 border-b border-black/10 px-3 py-1.5 dark:border-white/10">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{selected?.path ?? 'No file selected'}</span>
              <button
                type="button"
                onClick={() => setWrap((v) => !v)}
                aria-pressed={wrap}
                title="Wrap long lines"
                className={`flex items-center gap-1 rounded px-1.5 py-1 text-xs ${
                  wrap ? 'bg-black/[.08] dark:bg-white/[.12]' : 'hover:bg-black/[.06] dark:hover:bg-white/[.08]'
                }`}
              >
                <WrapText size={12} /> Wrap
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {!selected && <p className="p-6 text-sm text-black/40 dark:text-white/40">Select a file to view its diff.</p>}
              {selected && !selectedPatch && loadingPath === selected.path && (
                <p className="p-6 text-sm text-black/40 dark:text-white/40">Loading diff…</p>
              )}
              {selected && selectedPatch?.isBinary && (
                <p className="p-6 text-sm text-black/40 dark:text-white/40">Binary file — no textual diff.</p>
              )}
              {selected && selectedPatch && !selectedPatch.isBinary && (
                <SideBySideDiff
                  // Remounting per file is intentional: `DiffFile` is a parsed,
                  // stateful instance (expanded hunks, built split lines), and
                  // reusing one across files would carry the previous file's
                  // expansion state onto the next.
                  key={selected.path}
                  filePath={selected.path}
                  oldPath={selected.oldPath}
                  patch={selectedPatch.patch}
                  comments={commentsForSelected}
                  onAddComment={addComment}
                  onDeleteComment={deleteComment}
                  wrap={wrap}
                />
              )}
            </div>

            <ReviewSendBar
              openCount={openComments.length}
              note={note}
              onNoteChange={setNote}
              busy={busy}
              onSend={() => void handleSend()}
            />
          </div>
        </div>
      )}
    </div>
  )

  const tabs: DetailLayoutTab[] = [{ key: 'diff', label: 'Diff', count: files.length, content: diffTabContent }]

  const rightRail = (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Task</h2>
        {run.taskId ? (
          <Link href={`/workspace/${workspaceSlug}/tasks?task=${run.taskId}`} className="mt-1 block truncate font-medium hover:underline">
            {taskTitle ?? `Task #${run.taskId}`}
          </Link>
        ) : (
          <p className="mt-1 text-black/50 dark:text-white/50">No linked task</p>
        )}
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Agent</h2>
        <p className="mt-1">{agentName ?? 'Unassigned'}</p>
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Review</h2>
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          {openComments.length} unsent · {comments.length - openComments.length} sent
        </p>
        {/* Where the batch will actually go, stated before you press send —
            the two paths behave differently enough (same worktree vs a fresh
            branch off base) that a reviewer should not have to guess. */}
        <p className="mt-1 text-xs text-black/40 dark:text-white/40">
          {run.sessionId != null
            ? 'Sends as one turn in this run’s conversation.'
            : 'No conversation on this run — sends as a new follow-up run.'}
        </p>
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Run</h2>
        <p className="mt-1">
          #{run.id} · attempt {run.attempt}/{run.maxAttempts}
        </p>
        {run.startedAt && <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">started {formatTimestamp(run.startedAt)}</p>}
        {run.completedAt && <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">completed {formatTimestamp(run.completedAt)}</p>}
        <div className="mt-1 flex flex-wrap gap-2 text-xs">
          {run.sessionId != null && (
            <Link
              href={`/workspace/${workspaceSlug}/work?session=${run.sessionId}`}
              className="text-black/60 underline underline-offset-2 hover:text-black dark:text-white/60 dark:hover:text-white"
            >
              Open conversation
            </Link>
          )}
          {run.pageId != null && (
            <Link
              href={`/workspace/${workspaceSlug}/p/${run.pageId}`}
              className="text-black/60 underline underline-offset-2 hover:text-black dark:text-white/60 dark:hover:text-white"
            >
              Open page
            </Link>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Branch</h2>
        <div className="mt-1 flex flex-col gap-1 text-xs text-black/60 dark:text-white/60">
          <span className="flex items-center gap-1">
            <GitBranch size={12} />
            {worktreeState.branchExists ? 'branch created' : 'no branch'}
          </span>
          {worktreeState.branchExists && (
            <>
              <span>
                {worktreeState.aheadCount} ahead / {worktreeState.behindCount} behind base
              </span>
              {worktreeState.headCommit && <span className="font-mono">{worktreeState.headCommit.slice(0, 10)}</span>}
              {worktreeState.headSubject && <span className="italic">&ldquo;{worktreeState.headSubject}&rdquo;</span>}
            </>
          )}
          <span className={worktreeState.worktreeExists ? '' : 'italic'}>
            {worktreeState.worktreeExists ? 'worktree on disk' : 'worktree already cleaned up'}
          </span>
          {worktreeState.hasUncommittedChanges && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <FileWarning size={12} /> uncommitted changes in worktree
            </span>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <DetailLayout
      breadcrumb={[{ label: 'Review', href: `/workspace/${workspaceSlug}/review` }, { label: `Run #${run.id}` }]}
      title={`Run #${run.id}`}
      statusBadge={<Badge variant={STATUS_BADGE_VARIANT[run.status]}>{run.status}</Badge>}
      primaryAction={primaryAction}
      tabs={tabs}
      defaultTab="diff"
      rightRail={rightRail}
    />
  )
}

/**
 * The one send. Deliberately a persistent bar rather than a button that
 * appears once you have comments: it is the only place the count of pending
 * remarks is visible while you scroll a long diff, and "how many am I about to
 * send" is the question this whole surface is answering.
 */
function ReviewSendBar({
  openCount,
  note,
  onNoteChange,
  busy,
  onSend,
}: {
  openCount: number
  note: string
  onNoteChange: (value: string) => void
  busy: boolean
  onSend: () => void
}) {
  const canSend = !busy && (openCount > 0 || note.trim().length > 0)
  return (
    <div className="flex shrink-0 items-end gap-2 border-t border-black/10 px-3 py-2 dark:border-white/10">
      <textarea
        rows={2}
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        placeholder="Optional overall note, sent with the line comments."
        aria-label="Overall review note"
        className="min-w-0 flex-1 resize-none rounded border border-black/10 bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:border-white/10"
      />
      <button
        type="button"
        disabled={!canSend}
        onClick={onSend}
        className="flex shrink-0 items-center gap-1.5 rounded bg-black px-3 py-2 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
      >
        <Send size={12} />
        {openCount > 0 ? `Send ${openCount} ${openCount === 1 ? 'comment' : 'comments'}` : 'Send note'}
      </button>
    </div>
  )
}
