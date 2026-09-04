'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { ChevronDown, ChevronRight, GitBranch, GitPullRequest, Loader2, RefreshCw, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DiffBlock } from '@/components/thread/DiffBlock'
import {
  commitSession,
  getSessionDiff,
  getSessionGitState,
  pushSession,
  stageSessionPaths,
  suggestCommitMessage,
  unstageSessionPaths,
  type SessionGitState,
} from '@/app/(app)/workspace/[workspaceSlug]/work/git-actions'

/**
 * R5.1/R5.4/R5.5 — what the agent changed, next to the conversation about it.
 *
 * This is the whole point of binding a session to a worktree: the person
 * asking "what did it just do" is looking at the thread, and until now the
 * answer lived on a different screen. Branch, ahead/behind, changed files,
 * their diffs, and the three actions that follow — stage, commit, push.
 *
 * **Refreshed on demand and after our own writes, never polled.** D0 forbids
 * an interval where a push already exists, and there is no push for the
 * filesystem here. A two-second stat loop is what R5.7 proposes and it is a
 * real cost on a rail that is usually not even open; a person who wants to
 * know reaches for Refresh, and every action this component performs
 * refreshes as part of finishing. The one thing that must never happen —
 * stale state at the moment of a commit — cannot, because the commit reads
 * the index server-side rather than trusting what is drawn here.
 */
export function GitRail({
  sessionId,
  open,
  onToggle,
}: {
  sessionId: number
  open: boolean
  onToggle: () => void
}) {
  const [state, setState] = useState<SessionGitState | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ path: string; patch: string; truncated: boolean } | null>(null)
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingPush, setConfirmingPush] = useState<null | 'push' | 'pr'>(null)
  const [busy, startTransition] = useTransition()

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setState(await getSessionGitState(sessionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the repository.')
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  // Only when the rail is actually open. A closed rail costs nothing, which
  // is what makes "no polling" affordable rather than merely principled.
  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  if (!open) {
    // A thin edge strip rather than a floating button: it reads as the
    // collapsed side of a panel, which is what it is, and it keeps the
    // conversation's own width stable whether or not the rail is open.
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Show changes"
        className="flex w-8 shrink-0 flex-col items-center gap-2 border-l border-black/10 py-3 text-black/40 transition hover:bg-black/[0.03] dark:border-white/10 dark:text-white/40 dark:hover:bg-white/[0.05]"
      >
        <GitBranch size={13} />
        <span className="text-[10px] uppercase tracking-wide [writing-mode:vertical-rl]">Changes</span>
      </button>
    )
  }

  const staged = state?.changes.filter((c) => c.staged) ?? []
  const unstaged = state?.changes.filter((c) => !c.staged) ?? []

  async function openDiff(path: string, isStaged: boolean) {
    if (expanded === path) {
      setExpanded(null)
      setDiff(null)
      return
    }
    setExpanded(path)
    setDiff(null)
    const result = await getSessionDiff(sessionId, { path, staged: isStaged })
    if (result) setDiff({ path, patch: result.patch, truncated: result.truncated })
  }

  function act(work: () => Promise<void>) {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      try {
        await work()
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That did not work.')
      }
    })
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-black/10 dark:border-white/10">
      <header className="flex items-center gap-2 border-b border-black/10 px-3 py-2 dark:border-white/10">
        <GitBranch size={13} className="text-black/40 dark:text-white/40" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{state?.branch ?? 'Changes'}</span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded p-1 text-black/40 transition hover:bg-black/[0.05] dark:text-white/40 dark:hover:bg-white/[0.07]"
          aria-label="Refresh"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="rounded p-1 text-black/40 transition hover:bg-black/[0.05] dark:text-white/40 dark:hover:bg-white/[0.07]"
          aria-label="Close changes"
        >
          <ChevronRight size={13} />
        </button>
      </header>

      <div className="flex flex-col gap-3 p-3">
        {!state?.bound && !loading && (
          <p className="text-xs text-black/45 dark:text-white/45">
            This conversation is not bound to a checkout. Pick a project and a worktree above, and the agent&apos;s
            changes will show up here.
          </p>
        )}

        {state?.error && (
          <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
            {state.error}
          </p>
        )}
        {error && (
          <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
            {notice}
          </p>
        )}

        {state?.bound && (
          <p className="text-[11px] text-black/45 dark:text-white/45">
            {state.upstream ? (
              <>
                {state.ahead} ahead, {state.behind} behind {state.upstream}
              </>
            ) : (
              'No upstream branch yet — pushing will create one.'
            )}
          </p>
        )}

        {state?.bound && state.clean && (
          <p className="text-xs text-black/45 dark:text-white/45">No changes in this checkout.</p>
        )}

        {unstaged.length > 0 && (
          <FileGroup
            title="Changed"
            files={unstaged.map((c) => c.path)}
            expanded={expanded}
            diff={diff}
            busy={busy}
            actionLabel="Stage"
            onAction={(paths) => act(() => stageSessionPaths(sessionId, paths))}
            onOpen={(path) => void openDiff(path, false)}
          />
        )}

        {staged.length > 0 && (
          <FileGroup
            title="Staged"
            files={staged.map((c) => c.path)}
            expanded={expanded}
            diff={diff}
            busy={busy}
            actionLabel="Unstage"
            onAction={(paths) => act(() => unstageSessionPaths(sessionId, paths))}
            onOpen={(path) => void openDiff(path, true)}
          />
        )}

        {staged.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-black/10 pt-3 dark:border-white/10">
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={3}
              placeholder="Commit message"
              className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-xs dark:border-white/15"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  startTransition(async () => {
                    // A draft, never a decision: it fills the box the person
                    // is about to edit.
                    setMessage(await suggestCommitMessage(sessionId))
                  })
                }
              >
                Suggest
              </Button>
              <Button
                size="sm"
                disabled={busy || !message.trim()}
                onClick={() =>
                  act(async () => {
                    const made = await commitSession(sessionId, message)
                    setMessage('')
                    setNotice(made ? `Committed ${made.shortHash}.` : 'Nothing to commit.')
                  })
                }
              >
                Commit
              </Button>
            </div>
          </div>
        )}

        {state?.bound && (
          <div className="flex flex-col gap-2 border-t border-black/10 pt-3 dark:border-white/10">
            {/* Pushing publishes work other people can see, so it asks first
                every time. Approval of one push is not approval of the next. */}
            {confirmingPush ? (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] text-black/60 dark:text-white/60">
                  {confirmingPush === 'pr'
                    ? `Push ${state.branch} to origin and open a pull request?`
                    : `Push ${state.branch} to origin?`}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const result = await pushSession(sessionId, { openPullRequest: confirmingPush === 'pr' })
                        setConfirmingPush(null)
                        setNotice(result.detail)
                      })
                    }
                  >
                    {busy ? 'Working…' : 'Confirm'}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingPush(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmingPush('push')}>
                  <Upload size={12} className="mr-1" />
                  Push
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  // Offered only when `gh` can actually open one, rather than
                  // failing after the push has already happened.
                  disabled={busy || !state.ghReady}
                  title={state.ghReady ? undefined : (state.ghDetail ?? 'GitHub CLI is not available.')}
                  onClick={() => setConfirmingPush('pr')}
                >
                  <GitPullRequest size={12} className="mr-1" />
                  Pull request
                </Button>
              </div>
            )}
          </div>
        )}

        {state && state.recent.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-black/10 pt-3 dark:border-white/10">
            <p className="text-[10px] font-medium uppercase tracking-wide text-black/35 dark:text-white/35">
              Recent commits
            </p>
            {state.recent.map((c) => (
              <p key={c.hash} className="truncate text-[11px] text-black/50 dark:text-white/50">
                <span className="font-mono text-black/35 dark:text-white/35">{c.shortHash}</span> {c.subject}
              </p>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

function FileGroup({
  title,
  files,
  expanded,
  diff,
  busy,
  actionLabel,
  onAction,
  onOpen,
}: {
  title: string
  files: string[]
  expanded: string | null
  diff: { path: string; patch: string; truncated: boolean } | null
  busy: boolean
  actionLabel: string
  onAction: (paths: string[]) => void
  onOpen: (path: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wide text-black/35 dark:text-white/35">
          {title} ({files.length})
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAction(files)}
          className="text-[10px] text-black/50 underline-offset-2 hover:underline disabled:opacity-50 dark:text-white/50"
        >
          {actionLabel} all
        </button>
      </div>
      {files.map((path) => (
        <div key={path} className="flex flex-col">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onOpen(path)}
              className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] transition hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            >
              {expanded === path ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              {/* The end of a path is the part that identifies it, so it is
                  the end that must survive truncation. */}
              <span className="truncate" dir="rtl">
                {path}
              </span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction([path])}
              className="shrink-0 rounded px-1 text-[10px] text-black/45 hover:bg-black/[0.05] disabled:opacity-50 dark:text-white/45 dark:hover:bg-white/[0.07]"
            >
              {actionLabel}
            </button>
          </div>
          {expanded === path && (
            <div className="pb-2 pl-3">
              {diff?.path === path ? (
                <>
                  <DiffBlock diff={diff.patch} />
                  {diff.truncated && (
                    <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                      This diff was too large to show in full.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[10px] text-black/35 dark:text-white/35">Loading diff…</p>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
