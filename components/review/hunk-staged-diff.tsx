'use client'

/**
 * R5.2 — one file's diff with a stage/unstage control on every hunk.
 *
 * WHY IT LIVES IN `components/review/` AND WHAT IS NOT DONE YET
 * -------------------------------------------------------------
 * This unit owns `components/review/**` and the side-by-side viewer lives
 * here, so the hunk affordance was built onto that viewer. The surface that
 * should MOUNT this component is the Work git rail
 * (`components/work/git-rail.tsx`), which is the only place in the app with
 * both a session-bound checkout and a real index — and that file belongs to
 * another unit, so this one does not touch it. The rail currently renders
 * whole-file diffs through `components/thread/DiffBlock.tsx` and whole-file
 * Stage/Unstage buttons.
 *
 * So: the server half is finished and verified, this component is finished,
 * and it is NOT yet rendered anywhere. Wiring it is one substitution inside
 * `git-rail.tsx`'s `openDiff`/diff area — replace the `DiffBlock` render with
 *
 *     <HunkStagedDiff sessionId={sessionId} path={path} staged={isStaged}
 *                     untracked={change.untracked} onChanged={refresh} />
 *
 * and drop that file's own `getSessionDiff` call, which this component
 * replaces (it fetches the patch and the hunk boundaries together). Said out
 * loud rather than left to be discovered.
 *
 * The run-review surface is deliberately NOT a host for this: its diff is a
 * commit range (`base...branch` against a bare clone), where there is no index
 * for a hunk to be staged into.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import {
  getSessionFileHunks,
  stageSessionHunk,
  unstageSessionHunk,
  type SessionFileHunks,
} from '@/app/(app)/workspace/[workspaceSlug]/work/git-actions'
import { SideBySideDiff, type StageableHunk } from './side-by-side-diff'
import { ClientFailure, unwrap, type FailureInfo } from '@/lib/failures'

/** The server's own sentence and underlying text, which only survive because
 * `unwrap` re-throws in the browser. */
function toFailureInfo(err: unknown, fallback: string): FailureInfo {
  if (err instanceof ClientFailure) {
    return { code: err.code, message: err.message, detail: err.detail, retryable: err.retryable }
  }
  return { code: 'unknown', message: err instanceof Error ? err.message : fallback, retryable: false }
}

export function HunkStagedDiff({
  sessionId,
  path,
  oldPath = null,
  staged,
  untracked = false,
  wrap = false,
  onChanged,
}: {
  sessionId: number
  /** Repository-relative, exactly as `git status` reported it. */
  path: string
  oldPath?: string | null
  /** Which side of the index this is showing: the staged diff (HEAD → index)
   * or the unstaged one (index → worktree). It decides both what is fetched
   * and which direction the buttons offer. */
  staged: boolean
  /** An untracked file has no diff to cut into hunks; saying so beats an
   * empty panel, and it saves a round trip that could only come back empty. */
  untracked?: boolean
  wrap?: boolean
  /** Called after the index changes, so the surrounding rail can re-read its
   * own status. */
  onChanged?: () => void
}) {
  const [data, setData] = useState<SessionFileHunks | null>(null)
  const [loading, setLoading] = useState(!untracked)
  // The whole failure: a hunk that will not apply is explained by git's own
  // `error: patch failed: …` line, and the sentence above it cannot name the
  // line that moved.
  const [error, setError] = useState<FailureInfo | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  // Which (path, staged) the newest request was for. A person clicking down a
  // file list faster than the server answers must not end up with an earlier
  // file's diff painted under a later file's name.
  const requestRef = useRef(0)

  const load = useCallback(async () => {
    if (untracked) {
      setData(null)
      setLoading(false)
      return
    }
    const token = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      // `unwrap` whether or not this action has been migrated to return its
      // failures: it passes a plain value straight through, and turns an
      // envelope into an Error the browser itself created.
      const result = unwrap(await getSessionFileHunks(sessionId, path, { staged }))
      if (requestRef.current !== token) return
      setData(result)
    } catch (err) {
      if (requestRef.current !== token) return
      setError(toFailureInfo(err, 'Could not read this diff.'))
    } finally {
      if (requestRef.current === token) setLoading(false)
    }
  }, [sessionId, path, staged, untracked])

  useEffect(() => {
    void load()
  }, [load])

  async function act(hunk: StageableHunk) {
    setPending(hunk.fingerprint)
    setError(null)
    const token = requestRef.current
    try {
      const input = { path, hunkIndex: hunk.index, fingerprint: hunk.fingerprint }
      const result = unwrap(
        staged ? await unstageSessionHunk(sessionId, input) : await stageSessionHunk(sessionId, input),
      )
      // Ignore a result that arrived after the user moved to another file.
      if (requestRef.current !== token) return
      // The action already re-read this side of the diff, so the new state is
      // in hand — no second fetch, and no window where the buttons still refer
      // to hunks that have moved.
      if (result.next) setData(result.next)
      if (!result.ok) setError({ code: 'conflict', message: result.message ?? 'That hunk could not be applied.', retryable: false })
      else onChanged?.()
    } catch (err) {
      if (requestRef.current !== token) return
      setError(toFailureInfo(err, 'That hunk could not be applied.'))
    } finally {
      setPending((current) => (current === hunk.fingerprint ? null : current))
    }
  }

  if (untracked) {
    return (
      <p className="p-3 text-xs text-black/40 dark:text-white/40">
        This file is untracked — git has nothing to diff it against, so it can only be staged whole.
      </p>
    )
  }

  return (
    <div className="min-w-0">
      {error && (
        <div className="border-b border-black/10 px-3 py-1.5 dark:border-white/10">
          <p className="text-xs text-red-600 dark:text-red-400">{error.message}</p>
          {error.detail && (
            <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-red-600/70 dark:text-red-400/70">
              {error.detail}
            </pre>
          )}
        </div>
      )}
      {loading && !data && (
        <p className="flex items-center gap-1.5 p-3 text-xs text-black/40 dark:text-white/40">
          <Loader2 size={12} className="animate-spin" /> Loading diff…
        </p>
      )}
      {data && data.unavailable && (
        <p className="border-b border-black/10 px-3 py-1.5 text-xs text-black/50 dark:border-white/10 dark:text-white/50">
          {data.unavailable}
        </p>
      )}
      {data && data.patch.trim() === '' && !data.unavailable && (
        <p className="p-3 text-xs text-black/40 dark:text-white/40">
          {staged ? 'Nothing staged for this file.' : 'No unstaged changes in this file.'}
        </p>
      )}
      {data && data.patch.trim() !== '' && !data.isBinary && (
        <SideBySideDiff
          // Remounting per file and per side is intentional: `DiffFile` is a
          // parsed, stateful instance and reusing one across patches carries
          // the previous patch's expansion state onto the next.
          key={`${path}:${staged ? 'staged' : 'unstaged'}`}
          filePath={path}
          oldPath={oldPath}
          patch={data.patch}
          // No review comments in this context — those belong to a run review,
          // which is a different surface with a different store. Turning the
          // affordance off rather than passing a no-op handler: a "+" that
          // opens a composer whose Add button does nothing is worse than no
          // "+" at all.
          enableComments={false}
          comments={[]}
          onAddComment={() => {}}
          onDeleteComment={() => {}}
          wrap={wrap}
          hunks={data.hunks}
          hunkAction={staged ? 'unstage' : 'stage'}
          onHunkAction={(hunk) => void act(hunk)}
          pendingHunk={pending}
        />
      )}
    </div>
  )
}
